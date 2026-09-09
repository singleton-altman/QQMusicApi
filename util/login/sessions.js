// SPDX-License-Identifier: GPL-3.0-only
const {randomBytes} = require('node:crypto');
const {LoginError} = require('./http');
const {QQLoginProtocol} = require('./protocol');

const RETRY_MS = 1500;
const expired = () => ({done: false, expired: true, status: 'expired', message: '二维码已过期，请重新扫码', retryAfterMs: RETRY_MS});
const failed = () => ({done: false, expired: true, status: 'error', message: 'QQ 音乐授权未完成，请重新扫码', retryAfterMs: RETRY_MS});

class LoginSessions {
  constructor({protocol = new QQLoginProtocol(), now = Date.now, ttlMs = 180000, capacity = 256} = {}) {
    this.protocol = protocol;
    this.now = now;
    this.ttlMs = ttlMs;
    this.capacity = capacity;
    this.sessions = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 15000);
    this.cleanupTimer.unref();
  }

  isActive(key, session) {
    return this.sessions.get(key) === session && !session.controller.signal.aborted && session.expiresAt > this.now();
  }

  remove(key) {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    session.controller.abort();
    session.jar?.clear();
    delete session.qrsig;
    delete session.pendingCredentials;
    delete session.result;
  }

  cleanup() {
    for (const [key, session] of this.sessions) if (session.expiresAt <= this.now()) this.remove(key);
  }

  close() {
    clearInterval(this.cleanupTimer);
    for (const key of this.sessions.keys()) this.remove(key);
  }

  async create(owner) {
    this.cleanup();
    // Include pending creates in the cap. One owner cannot evict another owner.
    if (this.sessions.size >= this.capacity) throw new LoginError('capacity');
    const unikey = randomBytes(32).toString('hex');
    const session = {
      owner, controller: new AbortController(), expiresAt: this.now() + this.ttlMs,
      nextPollAt: 0, result: {done: false, status: 'waiting', message: '请使用手机 QQ 扫码', retryAfterMs: RETRY_MS},
    };
    this.sessions.set(unikey, session);
    try {
      const qr = await this.protocol.create(session.controller.signal);
      if (!this.isActive(unikey, session)) {
        qr.jar?.clear();
        throw new LoginError('cancelled');
      }
      session.jar = qr.jar;
      session.qrsig = qr.qrsig;
      return {unikey, qrimg: qr.qrimg, expiresAt: session.expiresAt, message: '请使用手机 QQ 扫码'};
    } catch (err) {
      this.remove(unikey);
      throw err;
    }
  }

  cancel(owner, key) {
    if (this.sessions.get(key)?.owner === owner) this.remove(key);
    return {done: false, cancelled: true, status: 'cancelled', message: '已取消登录', retryAfterMs: RETRY_MS};
  }

  async status(owner, key) {
    const session = this.sessions.get(key);
    // Unknown keys and keys owned by somebody else have identical responses.
    if (!session || session.owner !== owner) return expired();
    if (!this.isActive(key, session)) {
      this.remove(key);
      return expired();
    }
    if (session.inFlight) return session.inFlight;
    if (session.result.done || session.result.expired || session.result.cancelled || this.now() < session.nextPollAt) {
      return session.result;
    }
    session.nextPollAt = this.now() + RETRY_MS;
    session.inFlight = (async () => {
      let result;
      try {
        result = session.pendingCredentials ? await this.protocol.verify(session) : await this.protocol.poll(session);
        result = {done: false, retryAfterMs: RETRY_MS, ...result};
      } catch (err) {
        if (err instanceof LoginError && err.kind === 'network' &&
            (!session.exchanging || session.pendingCredentials)) {
          result = {done: false, status: session.pendingCredentials ? 'scanned' : 'waiting',
            message: '网络暂时不可用，正在重试', retryAfterMs: RETRY_MS};
        } else result = failed();
      }
      if (!this.isActive(key, session)) {
        // Also clear values assigned by an in-flight protocol after cancellation.
        session.jar?.clear();
        delete session.pendingCredentials;
        delete session.qrsig;
        if (this.sessions.get(key) === session) this.remove(key);
        return expired();
      }
      session.result = result;
      session.nextPollAt = this.now() + RETRY_MS;
      if (result.done || result.expired || result.cancelled) {
        session.jar?.clear();
        delete session.qrsig;
        delete session.pendingCredentials;
      }
      return result;
    })();
    try { return await session.inFlight; }
    finally { session.inFlight = undefined; }
  }
}

module.exports = {LoginSessions};

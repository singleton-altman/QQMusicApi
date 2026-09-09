// SPDX-License-Identifier: GPL-3.0-only
// Protocol reference: L-1124/QQMusicApi login.py, commit
// 374017047c39dc987418450b6d513bc216499a69 (GPL-3.0).
const {randomUUID} = require('node:crypto');
const {QQLoginProtocol, normalizeCredentials} = require('./protocol');
const {LoginError} = require('./http');

const CONNECT = 'https://open.weixin.qq.com/connect/qrconnect';
const IMAGE = 'https://open.weixin.qq.com/connect/qrcode/';
const POLL = 'https://lp.open.weixin.qq.com/connect/l/qrconnect';
const APP_ID = 'wx48db31d50e334801';

function parseWechatStatus(text) {
  // Read only known assignment values. Never evaluate the returned JavaScript.
  const statuses = [...text.matchAll(/\bwindow\.wx_errcode\s*=\s*(\d+)\s*;/g)];
  const codes = [...text.matchAll(/\bwindow\.wx_code\s*=\s*(['"])([A-Za-z0-9_-]*)\1\s*;?/g)];
  if (statuses.length !== 1 || codes.length > 1) throw new LoginError();
  const status = Number(statuses[0][1]);
  const code = codes[0]?.[2] || '';
  if (code.length > 4096 || (status === 405 && !code)) throw new LoginError();
  return {status, code};
}

class WeChatLoginProtocol extends QQLoginProtocol {
  async create(signal) {
    const url = new URL(CONNECT);
    url.search = new URLSearchParams({
      appid: APP_ID,
      redirect_uri: 'https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/',
      response_type: 'code', scope: 'snsapi_login', state: randomUUID(),
      href: 'https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect',
    }).toString();
    const page = await this.http.request(url, {signal, cookie: ''});
    if (page.status !== 200) throw new LoginError();
    const html = page.body.toString('utf8');
    const uuid = /\/connect\/qrcode\/([A-Za-z0-9_-]{8,128})(?=["'?\s<])/.exec(html)?.[1] ||
      /\buuid=([A-Za-z0-9_-]{8,128})(?=["'&\s<])/.exec(html)?.[1];
    if (!uuid) throw new LoginError();
    const image = await this.http.request(IMAGE + uuid, {
      signal, cookie: '', headers: {Referer: CONNECT},
    });
    const jpeg = image.body.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    const png = image.body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    if (image.status !== 200 || (!jpeg && !png)) throw new LoginError();
    return {uuid, qrimg: `data:image/${jpeg ? 'jpeg' : 'png'};base64,${image.body.toString('base64')}`};
  }

  async poll(session) {
    const url = new URL(POLL);
    url.search = new URLSearchParams({uuid: session.uuid, _: String(this.now())}).toString();
    let response;
    try {
      response = await this.http.request(url, {
        signal: session.controller.signal, cookie: '', timeoutMs: 18000,
        headers: {Referer: 'https://open.weixin.qq.com/'},
      });
    } catch (error) {
      // A quiet long poll is an ordinary waiting state, not failed authorization.
      if (error instanceof LoginError && error.kind === 'timeout') {
        return {status: session.result?.status === 'scanned' ? 'scanned' : 'waiting'};
      }
      throw error;
    }
    if (response.status !== 200) throw new LoginError();
    const {status, code} = parseWechatStatus(response.body.toString('utf8'));
    const states = {
      408: {status: 'waiting'},
      404: {status: 'scanned'},
      402: {status: 'expired', expired: true},
      403: {status: 'cancelled', cancelled: true},
    };
    if (states[status]) return states[status];
    if (status !== 405) throw new LoginError();
    session.exchanging = true;
    const data = await this.cgi('music.login.LoginServer', 'Login', {code, strAppid: APP_ID}, session);
    session.pendingCredentials = normalizeCredentials(data, 'wechat');
    return this.verify(session);
  }
}

module.exports = {WeChatLoginProtocol, parseWechatStatus};

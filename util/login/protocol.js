// SPDX-License-Identifier: GPL-3.0-only
// Protocol reference: L-1124/QQMusicApi, login.py and core/versioning.py
// commit 374017047c39dc987418450b6d513bc216499a69 (GPL-3.0).
const {randomUUID} = require('node:crypto');
const {LoginError, LoginHttpClient, CookieJar, allowedUrl} = require('./http');

const SHOW = 'https://ssl.ptlogin2.qq.com/ptqrshow';
const POLL = 'https://ssl.ptlogin2.qq.com/ptqrlogin';
const CHECK = 'https://ssl.ptlogin2.graph.qq.com/check_sig';
const AUTHORIZE = 'https://graph.qq.com/oauth2.0/authorize';
const CGI = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const REDIRECT = 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/';
const REFERER = {'Referer': 'https://xui.ptlogin2.qq.com/'};

function hash33(value, initial = 0) {
  let hash = initial;
  for (let i = 0; i < value.length; i++) hash = (hash * 33 + value.charCodeAt(i)) | 0;
  return hash & 0x7fffffff;
}

function query(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

// Parse the known callback grammar without executing JavaScript. Escapes are
// decoded locally; trailing script content and malformed callbacks are rejected.
function parseCallback(text) {
  const match = /^\s*ptuiCB\(((?:.|\n)*)\)\s*;?\s*$/.exec(text);
  if (!match) throw new LoginError();
  const fields = [];
  const expression = /\s*'((?:\\(?:[\\'"nrt]|x[\da-fA-F]{2}|u[\da-fA-F]{4})|[^'\\\r\n])*)'\s*(,|$)/y;
  let position = 0;
  while (position < match[1].length) {
    expression.lastIndex = position;
    const field = expression.exec(match[1]);
    if (!field) throw new LoginError();
    fields.push(field[1].replace(/\\(x[\da-fA-F]{2}|u[\da-fA-F]{4}|.)/g, (_, char) => {
      if (char[0] === 'x' || char[0] === 'u') return String.fromCharCode(parseInt(char.slice(1), 16));
      return ({n: '\n', r: '\r', t: '\t'})[char] || char;
    }));
    position = expression.lastIndex;
    if (field[2] && position === match[1].length) throw new LoginError();
    if (!field[2]) break;
  }
  if (fields.length < 1 || !/^\d+$/.test(fields[0])) throw new LoginError();
  return fields;
}

// Quote integer JSON tokens before JSON.parse so even numeric 64-bit music IDs
// remain exact. Strings/escapes are consumed first and never rewritten.
function parseExactJson(body) {
  try {
    return JSON.parse(body.toString('utf8').replace(
      /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      token => /^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token,
    ));
  } catch { throw new LoginError(); }
}

function normalizeCredentials(data) {
  if (!data || typeof data !== 'object') throw new LoginError();
  const musicid = String(data.str_musicid || data.musicid || '');
  const musickey = data.musickey;
  if (!/^[1-9]\d{0,24}$/.test(musicid) || typeof musickey !== 'string' ||
      !/^[\x21-\x7E]{1,2048}$/.test(musickey) || /[;,]/.test(musickey)) throw new LoginError();
  const credentials = {musicid, str_musicid: musicid, musickey, login_type: 1};
  for (const key of ['openid', 'unionid', 'refresh_key', 'refresh_token', 'access_token', 'encryptUin']) {
    if (typeof data[key] === 'string' && data[key].length <= 4096) credentials[key] = data[key];
  }
  for (const key of ['expired_at', 'expired_in', 'musickeyCreateTime', 'keyExpiresIn', 'needRefreshKeyIn']) {
    if (Number.isSafeInteger(data[key]) && data[key] >= 0) credentials[key] = data[key];
  }
  return credentials;
}

function musicCookie(credentials) {
  return `uin=${credentials.musicid}; qqmusic_uin=${credentials.musicid}; qqmusic_key=${credentials.musickey}; qm_keyst=${credentials.musickey}; login_type=1`;
}

function webComm(credentials) {
  const gtk = hash33(credentials?.musickey || '', 5381);
  return {
    ct: 24, cv: 4747474, platform: 'yqq.json', chid: '0',
    uin: credentials?.musicid || '0', g_tk: gtk, g_tk_new_20200303: gtk,
    format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0, need_new_code: 1,
    // QQConnect uses 2 for QQ; the web cookie's login_type uses 1 for QQ.
    tmeLoginType: 2,
    ...(credentials ? {authst: credentials.musickey} : {}),
  };
}

class QQLoginProtocol {
  constructor({http = new LoginHttpClient(), now = Date.now} = {}) {
    this.http = http;
    this.now = now;
  }

  async create(signal) {
    const jar = new CookieJar();
    const response = await this.http.request(query(SHOW, {
      appid: '716027609', e: '2', l: 'M', s: '3', d: '72', v: '4',
      t: Math.random(), daid: '383', pt_3rd_aid: '100497308',
    }), {jar, signal, headers: REFERER});
    const qrsig = jar.get(POLL, 'qrsig');
    if (!qrsig || response.status !== 200 ||
        !response.body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new LoginError();
    return {jar, qrsig, qrimg: `data:image/png;base64,${response.body.toString('base64')}`};
  }

  async poll(session) {
    const response = await this.http.request(query(POLL, {
      u1: 'https://graph.qq.com/oauth2.0/login_jump', ptqrtoken: hash33(session.qrsig),
      ptredirect: '0', h: '1', t: '1', g: '1', from_ui: '1', ptlang: '2052',
      action: `0-0-${this.now()}`, js_ver: '20102616', js_type: '1', pt_uistyle: '40',
      aid: '716027609', daid: '383', pt_3rd_aid: '100497308', has_onekey: '1',
    }), {jar: session.jar, signal: session.controller.signal, headers: REFERER});
    const args = parseCallback(response.body.toString('utf8'));
    const states = {
      '66': {status: 'waiting', message: '请使用手机 QQ 扫码'},
      '67': {status: 'scanned', message: '请在手机 QQ 上确认登录'},
      '65': {status: 'expired', expired: true, message: '二维码已过期，请重新扫码'},
      '68': {status: 'cancelled', cancelled: true, message: '已取消登录，请重新扫码'},
    };
    if (states[args[0]]) return states[args[0]];
    if (args[0] !== '0' || !args[2]) throw new LoginError();
    const callback = allowedUrl(args[2]);
    if (callback.hostname !== 'ssl.ptlogin2.graph.qq.com' || callback.pathname !== '/check_sig') throw new LoginError();
    const uin = callback.searchParams.get('uin');
    const sigx = callback.searchParams.get('ptsigx');
    if (!uin || !/^\d{1,25}$/.test(uin) || !sigx || sigx.length > 4096) throw new LoginError();
    // From here any transport failure is uncertain; never reuse a one-time code.
    session.exchanging = true;
    const credentials = await this.authorize(session, uin, sigx);
    session.pendingCredentials = credentials;
    return this.verify(session);
  }

  async authorize(session, uin, sigx) {
    const {jar, controller: {signal}} = session;
    const checked = await this.http.request(query(CHECK, {
      uin, pttype: '1', service: 'ptqrlogin', nodirect: '0', ptsigx: sigx,
      s_url: 'https://graph.qq.com/oauth2.0/login_jump', ptlang: '2052',
      ptredirect: '100', aid: '716027609', daid: '383', j_later: '0',
      low_login_hour: '0', regmaster: '0', pt_login_type: '3', pt_aid: '0',
      pt_aaid: '16', pt_light: '0', pt_3rd_aid: '100497308',
    }), {jar, signal, headers: REFERER});
    // We need Set-Cookie, not a redirect fetch. Validate any advertised target.
    const checkLocation = checked.headers.get('location');
    if (checkLocation) {
      const target = allowedUrl(new URL(checkLocation, CHECK));
      if (target.hostname !== 'graph.qq.com' || target.pathname !== '/oauth2.0/login_jump') throw new LoginError();
    }
    const skey = jar.get(AUTHORIZE, 'p_skey');
    if (!skey) throw new LoginError();
    const state = randomUUID();
    const authorized = await this.http.request(AUTHORIZE, {
      jar, signal, method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        response_type: 'code', client_id: '100497308', redirect_uri: REDIRECT,
        scope: 'get_user_info,get_app_friends', state, switch: '', from_ptlogin: '1',
        src: '1', update_auth: '1', openapi: '1010_1030', g_tk: String(hash33(skey, 5381)),
        auth_time: String(this.now()), ui: randomUUID(),
      }).toString(),
    });
    const location = authorized.headers.get('location');
    if (!location || ![301, 302, 303, 307, 308].includes(authorized.status)) throw new LoginError();
    const target = allowedUrl(location);
    if (target.hostname !== 'y.qq.com' || target.pathname !== '/portal/wx_redirect.html' ||
        target.searchParams.get('state') !== state) throw new LoginError();
    const code = target.searchParams.get('code');
    if (!code || code.length > 4096) throw new LoginError();
    const data = await this.cgi('QQConnectLogin.LoginServer', 'QQLogin', {code}, session);
    return normalizeCredentials(data);
  }

  async cgi(module, method, param, session, credentials) {
    const response = await this.http.request(CGI, {
      signal: session.controller.signal, method: 'POST',
      // Ordinary QQ OAuth cookies never cross into the music service.
      cookie: credentials ? musicCookie(credentials) : '',
      headers: {'Content-Type': 'application/json', Origin: 'https://y.qq.com'},
      body: JSON.stringify({comm: webComm(credentials), req_0: {module, method, param}}),
    });
    const result = parseExactJson(response.body);
    if (!result || (result.code !== undefined && result.code !== 0) ||
        result.req_0?.code !== 0 || !result.req_0.data || typeof result.req_0.data !== 'object' ||
        (result.req_0.data.code !== undefined && result.req_0.data.code !== 0)) {
      throw new LoginError('authentication');
    }
    return result.req_0.data;
  }

  async verify(session) {
    const credentials = session.pendingCredentials;
    const info = await this.cgi('music.UserInfo.userInfoServer', 'GetLoginUserInfo', {}, session, credentials);
    if (!Object.keys(info).length) throw new LoginError('authentication');
    const returnedId = info.str_musicid || info.musicid || info.userInfo?.musicid;
    if (returnedId && String(returnedId) !== credentials.musicid) throw new LoginError('authentication');
    return {status: 'authorized', done: true, uin: credentials.musicid,
      message: 'QQ 音乐登录成功', cookie: musicCookie(credentials), credentials};
  }
}

module.exports = {QQLoginProtocol, hash33, parseCallback, parseExactJson, normalizeCredentials, musicCookie, webComm};

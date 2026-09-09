const test = require('node:test');
const assert = require('node:assert/strict');
const {WeChatLoginProtocol, parseWechatStatus} = require('../../util/login/wechat');
const {QQLoginProtocol} = require('../../util/login/protocol');
const {LoginHttpClient, LoginError} = require('../../util/login/http');
const {LoginSessions} = require('../../util/login/sessions');

const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const MUSIC_ID = '18446744073709551615';
const UUID = 'private-uuid-12345';
const KEY = 'W_X_private-music-key';

function fixture(t, {status = 405, body, loginData, verifyCode = 0, verifyData, timeout = false, exchangeError = false} = {}) {
  const requests = [];
  const transport = new LoginHttpClient({fetchImpl: async (raw, options) => {
    const url = new URL(raw);
    requests.push({url, options});
    if (url.hostname.endsWith('weixin.qq.com')) assert.equal(options.headers.Cookie, undefined);
    if (url.pathname === '/connect/qrconnect') {
      assert.equal(url.searchParams.get('appid'), 'wx48db31d50e334801');
      assert.ok(url.searchParams.get('redirect_uri').includes('login_type=2'));
      return new Response(`<img src="/connect/qrcode/${UUID}" />`);
    }
    if (url.pathname === `/connect/qrcode/${UUID}`) return new Response(Buffer.from('ffd8ffe000112233', 'hex'));
    if (url.pathname === '/connect/l/qrconnect') {
      assert.equal(url.searchParams.get('uuid'), UUID);
      return new Response(body ?? `window.wx_errcode=${status};window.wx_code='${status === 405 ? 'private-auth-code' : ''}';`);
    }
    assert.equal(url.href, 'https://u.y.qq.com/cgi-bin/musicu.fcg');
    const payload = JSON.parse(options.body);
    assert.equal(payload.comm.tmeLoginType, 1);
    if (payload.req_0.method === 'Login') {
      assert.equal(payload.req_0.module, 'music.login.LoginServer');
      assert.deepEqual(payload.req_0.param, {code: 'private-auth-code', strAppid: 'wx48db31d50e334801'});
      assert.equal(options.headers.Cookie, undefined);
      if (exchangeError) throw new Error('private-auth-code');
      const data = loginData ? JSON.stringify(loginData) : `{"musicid":${MUSIC_ID},"musickey":"${KEY}","refresh_token":"private-refresh"}`;
      return new Response(`{"code":0,"req_0":{"code":0,"data":${data}}}`);
    }
    assert.equal(payload.req_0.method, 'GetLoginUserInfo');
    assert.equal(payload.comm.uin, MUSIC_ID);
    assert.equal(payload.comm.authst, KEY);
    assert.ok(options.headers.Cookie.includes(`wxuin=${MUSIC_ID};`));
    assert.ok(options.headers.Cookie.includes('login_type=2'));
    return new Response(JSON.stringify({code: 0, req_0: {code: verifyCode, data: verifyData || {musicid: MUSIC_ID}}}));
  }});
  const http = {request: (url, options) => {
    if (timeout && new URL(url).pathname === '/connect/l/qrconnect') {
      assert.equal(options.timeoutMs, 18000);
      throw new LoginError('timeout');
    }
    return transport.request(url, options);
  }};
  let clock = 10000;
  const sessions = new LoginSessions({wechatProtocol: new WeChatLoginProtocol({http}), now: () => clock});
  t.after(() => sessions.close());
  return {sessions, requests, advance: () => { clock += 1500; }};
}

test('WeChat QR, code exchange and music verification preserve the complete long account ID', async t => {
  const {sessions, requests} = fixture(t);
  const qr = await sessions.create(OWNER, 'wechat');
  assert.equal(qr.loginType, 'wechat'); assert.equal(qr.message, '请使用微信扫码');
  assert.match(qr.qrimg, /^data:image\/jpeg;base64,/);
  assert.doesNotMatch(JSON.stringify(qr), /private-uuid/);
  const result = await sessions.status(OWNER, qr.unikey);
  assert.equal(result.done, true); assert.equal(result.status, 'authorized');
  assert.equal(result.uin, MUSIC_ID); assert.equal(result.credentials.musicid, MUSIC_ID);
  assert.equal(result.credentials.login_type, 2); assert.equal(result.credentials.loginType, 1);
  assert.equal(result.loginType, 'wechat'); assert.match(result.cookie, /login_type=2$/);
  assert.equal(requests.length, 5);
  assert.deepEqual(await sessions.status(OWNER, qr.unikey), result);
  assert.equal(requests.length, 5, 'one-time code is not exchanged again');
  assert.equal(sessions.sessions.get(qr.unikey).uuid, undefined);
  sessions.cancel(OWNER, qr.unikey);
});

for (const [code, status] of [[408, 'waiting'], [404, 'scanned'], [402, 'expired'], [403, 'cancelled']]) {
  test(`WeChat ${code} maps to ${status} without exposing provider identifiers`, async t => {
    const {sessions, requests} = fixture(t, {status: code});
    const qr = await sessions.create(OWNER, 'wechat');
    const result = await sessions.status(OWNER, qr.unikey);
    assert.equal(result.status, status); assert.equal(result.done, false);
    assert.equal(requests.length, 3);
    assert.doesNotMatch(JSON.stringify(result), /private-|cookie|credentials/);
  });
}

for (const [name, options] of [
  ['missing authorization code', {body: "window.wx_errcode=405;window.wx_code='';"}],
  ['missing music key', {loginData: {musicid: MUSIC_ID}}],
  ['invalid music session', {verifyCode: 1000}],
  ['wrong music identity', {verifyData: {musicid: '123'}}],
  ['uncertain exchange', {exchangeError: true}],
  ['unknown status', {status: 999}],
]) {
  test(`WeChat ${name} cannot produce a successful binding`, async t => {
    const {sessions, requests, advance} = fixture(t, options);
    const qr = await sessions.create(OWNER, 'wechat');
    const result = await sessions.status(OWNER, qr.unikey);
    assert.equal(result.done, false); assert.equal(result.status, 'error');
    assert.doesNotMatch(JSON.stringify(result), /private-|cookie|credentials/);
    const count = requests.length; advance(); await sessions.status(OWNER, qr.unikey);
    assert.equal(requests.length, count);
  });
}

test('silent WeChat long poll stays pending and remains cancellable', async t => {
  const {sessions} = fixture(t, {timeout: true});
  const qr = await sessions.create(OWNER, 'wechat');
  assert.equal((await sessions.status(OWNER, qr.unikey)).status, 'waiting');
  sessions.cancel(OTHER, qr.unikey); assert.equal(sessions.sessions.size, 1);
  sessions.cancel(OWNER, qr.unikey); assert.equal(sessions.sessions.size, 0);
});

test('QQ and WeChat session protocols are fixed at creation and cannot be switched by poll input', async t => {
  const calls = [];
  const make = type => ({create: async () => ({qrimg: 'image'}), poll: async () => { calls.push(type); return {status: 'waiting'}; }});
  const sessions = new LoginSessions({protocol: make('qq'), wechatProtocol: make('wechat')});
  t.after(() => sessions.close());
  const qq = await sessions.create(OWNER), wx = await sessions.create(OWNER, 'wechat');
  await sessions.status(OWNER, qq.unikey, 'wechat'); await sessions.status(OWNER, wx.unikey, 'qq');
  assert.deepEqual(calls, ['qq', 'wechat']);
  for (const invalid of ['wx', 'mobile', null, {}, 2]) await assert.rejects(sessions.create(OWNER, invalid));
});

test('WeChat response values are parsed as data with duplicate or malformed codes rejected', () => {
  assert.deepEqual(parseWechatStatus('window.wx_errcode=405;window.wx_code="code-123";'), {status: 405, code: 'code-123'});
  for (const text of ['<html>error</html>', 'window.wx_errcode=405;window.wx_code=run();', 'window.wx_errcode=408;window.wx_errcode=405;']) assert.throws(() => parseWechatStatus(text));
});

test('per-request transport timeout is classified without leaking the URL', async () => {
  const http = new LoginHttpClient({fetchImpl: (_url, {signal}) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}))});
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(http.request('https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=secret', {timeoutMs: 1}), error => error.kind === 'timeout' && !error.message.includes('secret')); }
  finally { clearTimeout(keepAlive); }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {QQLoginProtocol, parseCallback, parseExactJson, hash33} = require('../../util/login/protocol');
const {LoginHttpClient, CookieJar} = require('../../util/login/http');
const {LoginSessions} = require('../../util/login/sessions');

const OWNER = 'a'.repeat(64);
const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const MUSIC_ID = '18446744073709551615';
const SECRET_KEY = 'music-secret-do-not-log';

function fixture(t, {pollCode = '0', loginData, verifyCode = 0, verifyData, exchangeError = false} = {}) {
  const requests = [];
  const http = new LoginHttpClient({fetchImpl: async (raw, init) => {
    const url = new URL(raw);
    requests.push({url, init});
    if (url.pathname === '/ptqrshow') {
      return new Response(PNG, {headers: {'Content-Type': 'image/png', 'Set-Cookie': 'qrsig=private-qr-signature; Domain=ptlogin2.qq.com; Path=/; Secure'}});
    }
    if (url.pathname === '/ptqrlogin') {
      assert.equal(url.searchParams.get('ptqrtoken'), String(hash33('private-qr-signature')));
      assert.equal(init.headers.Cookie, 'qrsig=private-qr-signature');
      return new Response(`ptuiCB('${pollCode}','0','https://ssl.ptlogin2.graph.qq.com/check_sig?uin=12345678&service=ptqrlogin&ptsigx=private-sigx&s_url=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump','0','untrusted message','nickname');`);
    }
    if (url.pathname === '/check_sig') {
      assert.equal(url.searchParams.get('uin'), '12345678');
      assert.equal(url.searchParams.get('ptsigx'), 'private-sigx');
      assert.ok(!init.headers.Cookie);
      const headers = new Headers({Location: 'https://graph.qq.com/oauth2.0/login_jump'});
      headers.append('Set-Cookie', 'p_skey=private-p-skey; Domain=graph.qq.com; Path=/; Secure');
      headers.append('Set-Cookie', 'p_uin=o12345678; Domain=graph.qq.com; Path=/; Secure');
      return new Response(null, {status: 302, headers});
    }
    if (url.pathname === '/oauth2.0/authorize') {
      assert.equal(init.method, 'POST');
      assert.ok(init.headers.Cookie.includes('p_skey=private-p-skey'));
      assert.ok(!init.headers.Cookie.includes('private-qr-signature'));
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('client_id'), '100497308');
      assert.equal(form.get('g_tk'), String(hash33('private-p-skey', 5381)));
      return new Response(null, {status: 302, headers: {
        Location: `https://y.qq.com/portal/wx_redirect.html?login_type=1&code=private-auth-code&state=${form.get('state')}`,
      }});
    }
    assert.equal(url.origin + url.pathname, 'https://u.y.qq.com/cgi-bin/musicu.fcg');
    assert.equal(url.search, '');
    const payload = JSON.parse(init.body);
    assert.equal(payload.comm.ct, 24);
    assert.equal(payload.comm.cv, 4747474);
    assert.equal(payload.comm.tmeLoginType, 2);
    if (payload.req_0.method === 'QQLogin') {
      assert.equal(payload.req_0.module, 'QQConnectLogin.LoginServer');
      assert.deepEqual(payload.req_0.param, {code: 'private-auth-code'});
      assert.ok(!init.headers.Cookie);
      if (exchangeError) throw new Error('private-auth-code at https://secret/');
      const serialized = loginData ? JSON.stringify(loginData) :
        `{"musicid":${MUSIC_ID},"musickey":"${SECRET_KEY}","refresh_key":"refresh-private","openid":"openid-private"}`;
      return new Response(`{"code":0,"req_0":{"code":0,"data":${serialized}}}`);
    }
    assert.equal(payload.req_0.module, 'music.UserInfo.userInfoServer');
    assert.equal(payload.req_0.method, 'GetLoginUserInfo');
    assert.equal(payload.comm.uin, MUSIC_ID);
    assert.equal(payload.comm.authst, SECRET_KEY);
    assert.equal(payload.comm.g_tk, hash33(SECRET_KEY, 5381));
    assert.ok(init.headers.Cookie.includes(`uin=${MUSIC_ID};`));
    assert.ok(init.headers.Cookie.includes('login_type=1'));
    assert.ok(!init.headers.Cookie.includes('p_skey'));
    return new Response(JSON.stringify({code: 0, req_0: {code: verifyCode,
      data: verifyData || {musicid: MUSIC_ID, nickname: 'QQ Music user'}}}));
  }});
  let clock = 1000000;
  const protocol = new QQLoginProtocol({http});
  const sessions = new LoginSessions({protocol, now: () => clock});
  t.after(() => sessions.close());
  return {sessions, requests, advance: () => { clock += 1500; }};
}

test('full QR → check_sig → OAuth → QQLogin → authenticated user chain keeps 64-bit musicid exact', async t => {
  const {sessions, requests} = fixture(t);
  const qr = await sessions.create(OWNER);
  assert.match(qr.unikey, /^[a-f0-9]{64}$/);
  assert.ok(qr.qrimg.startsWith('data:image/png;base64,'));
  assert.equal(JSON.stringify(qr).includes('private-qr-signature'), false);
  const result = await sessions.status(OWNER, qr.unikey);
  assert.equal(result.done, true);
  assert.equal(result.credentials.musicid, MUSIC_ID);
  assert.equal(result.credentials.musickey, SECRET_KEY);
  assert.equal(requests.length, 6);
  assert.deepEqual(await sessions.status(OWNER, qr.unikey), result);
  assert.equal(requests.length, 6, 'retain completed result without exchanging the same code twice');
  assert.equal(sessions.sessions.get(qr.unikey).qrsig, undefined);
  sessions.cancel(OWNER, qr.unikey);
  assert.equal((await sessions.status(OWNER, qr.unikey)).expired, true);
});

for (const [code, status] of [['66', 'waiting'], ['67', 'scanned'], ['65', 'expired'], ['68', 'cancelled']]) {
  test(`maps QQ status ${code} to ${status} without leaking callback content`, async t => {
    const {sessions, requests} = fixture(t, {pollCode: code});
    const qr = await sessions.create(OWNER);
    const result = await sessions.status(OWNER, qr.unikey);
    assert.equal(result.status, status);
    assert.equal(result.done, false);
    assert.equal(requests.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /private-|nickname|untrusted/);
  });
}

for (const [name, options] of [
  ['missing music key', {loginData: {musicid: '123'}}],
  ['rejected authentication', {verifyCode: 1000}],
  ['business authentication failure', {verifyData: {code: 104401}}],
  ['mismatched authenticated account', {verifyData: {musicid: '123'}}],
  ['uncertain one-time exchange', {exchangeError: true}],
]) {
  test(`${name} never marks login successful or returns secrets`, async t => {
    const {sessions, requests, advance} = fixture(t, options);
    const qr = await sessions.create(OWNER);
    const result = await sessions.status(OWNER, qr.unikey);
    assert.equal(result.status, 'error');
    assert.equal(result.done, false);
    assert.equal(result.cookie, undefined);
    assert.equal(result.credentials, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-|music-secret/);
    const count = requests.length;
    advance();
    await sessions.status(OWNER, qr.unikey);
    assert.equal(requests.length, count);
  });
}

test('JSONP is parsed as data and callback injections are rejected', () => {
  assert.deepEqual(parseCallback("ptuiCB('66','测试\\x26\\u4f60');"), ['66', '测试&你']);
  for (const value of ["ptuiCB('66');evil()", "ptuiCB('66',evil())", "ptuiCB('66',)", "other('66')"]) {
    assert.throws(() => parseCallback(value), /QQ login protocol/);
  }
  assert.deepEqual(parseExactJson(Buffer.from(`{"musicid":${MUSIC_ID},"count":7,"name":"${MUSIC_ID}"}`)),
    {musicid: MUSIC_ID, count: 7, name: MUSIC_ID});
});

test('cookie jar enforces host/domain/path/expiry and does not follow arbitrary redirects', async () => {
  const jar = new CookieJar();
  const headers = new Headers();
  headers.append('Set-Cookie', 'qrsig=qr-only; Path=/; Secure');
  headers.append('Set-Cookie', 'bad=other; Domain=evil.com; Path=/');
  headers.append('Set-Cookie', 'suffix=bad; Domain=com; Path=/');
  headers.append('Set-Cookie', 'scope=limited; Path=/folder');
  headers.append('Set-Cookie', 'expired=bad; Max-Age=0; Path=/');
  jar.absorb('https://ssl.ptlogin2.qq.com/ptqrshow', headers);
  assert.equal(jar.header('https://ssl.ptlogin2.qq.com/ptqrlogin'), 'qrsig=qr-only');
  assert.equal(jar.header('https://graph.qq.com/oauth2.0/authorize'), '');
  assert.ok(jar.header('https://ssl.ptlogin2.qq.com/folder/page').includes('scope=limited'));
  assert.ok(!jar.header('https://ssl.ptlogin2.qq.com/folderish').includes('scope='));
  const http = new LoginHttpClient({fetchImpl: async () => { throw new Error('must not reach transport'); }});
  for (const url of ['https://evil.com/', 'http://graph.qq.com/', 'https://graph.qq.com:8443/', 'https://user:pass@graph.qq.com/']) {
    await assert.rejects(http.request(url), /QQ login protocol/);
  }
});

test('network errors expose no URL/body/cookie and response bodies are bounded', async () => {
  const http = new LoginHttpClient({fetchImpl: async () => { throw new Error('qrsig=private URL=https://private'); }});
  await assert.rejects(http.request('https://graph.qq.com/'), err => {
    assert.equal(err.message, 'QQ login network');
    assert.equal(err.cause, undefined);
    return true;
  });
  const large = new LoginHttpClient({fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1))});
  await assert.rejects(large.request('https://graph.qq.com/'), /QQ login protocol/);
});

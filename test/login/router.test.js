const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {createLoginRouter} = require('../../util/login/router');

const OWNER = 'a'.repeat(64);
const KEY = 'c'.repeat(64);
const TOKEN = 'service-secret-'.repeat(4);

async function server(t, {secret = TOKEN, sessions} = {}) {
  const calls = [];
  const app = express();
  app.use('/login', createLoginRouter({secret: () => secret, sessions: sessions || {
    create: async owner => { calls.push(['create', owner]); return {unikey: KEY, qrimg: 'data:image/png;base64,eA=='}; },
    status: async (owner, key) => { calls.push(['status', owner, key]); return {done: false, status: 'waiting'}; },
    cancel: async (owner, key) => { calls.push(['cancel', owner, key]); return {cancelled: true}; },
  }}));
  const http = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(listening));
    listening.on('error', reject);
  });
  t.after(() => new Promise(resolve => http.close(resolve)));
  const request = (path, {method = 'POST', token = TOKEN, body = {owner: OWNER}, raw} = {}) =>
    fetch(`http://127.0.0.1:${http.address().port}/login${path}`, {
      method, headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
      ...(!['GET', 'HEAD'].includes(method) ? {body: raw === undefined ? JSON.stringify(body) : raw} : {}),
    });
  return {request, calls};
}

test('HTTP routes enforce Bearer, POST, body-only identifiers, owner/token format and no-store', async t => {
  const {request, calls} = await server(t);
  for (const [path, options, status] of [
    ['/qr/create', {token: 'bad'}, 401],
    ['/qr/create', {method: 'GET'}, 405],
    ['/qr/create?owner=secret-in-query', {}, 400],
    ['/qr/create', {body: {owner: '123'}}, 400],
    ['/qr/create', {body: {owner: {foo: OWNER}}}, 400],
    ['/qr/create', {body: {owner: OWNER, loginType: 'wx'}}, 400],
    ['/qr/create', {body: {owner: OWNER, loginType: null}}, 400],
    ['/qr/status', {body: {owner: OWNER, unikey: 'not-a-session'}}, 400],
    ['/qr/create', {raw: '{"cookie":"secret",'}, 400],
    ['/qr/create', {raw: JSON.stringify({owner: OWNER, tooLarge: 'x'.repeat(3000)})}, 400],
    ['/wrong', {}, 404],
  ]) {
    const response = await request(path, options);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /secret|not-a-session|tooLarge/);
  }
  assert.equal(calls.length, 0);
  for (const path of ['/qr/create', '/qr/status', '/qr/cancel']) {
    const response = await request(path, {body: {owner: OWNER, unikey: KEY}});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result, 100);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.deepEqual(calls, [['create', OWNER], ['status', OWNER, KEY], ['cancel', OWNER, KEY]]);
});

test('missing or short service secret disables login with 503', async t => {
  for (const secret of ['', 'too-short']) {
    const {request, calls} = await server(t, {secret});
    const response = await request('/qr/create');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(calls.length, 0);
  }
});

test('unexpected upstream exceptions are redacted at the HTTP boundary', async t => {
  const {request} = await server(t, {sessions: {
    create: async () => { throw new Error('qrsig=private; code=auth-secret; Cookie=music-secret'); },
  }});
  const response = await request('/qr/create');
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /private|secret|Cookie|qrsig/);
});

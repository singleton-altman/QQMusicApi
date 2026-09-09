const test = require('node:test');
const assert = require('node:assert/strict');
const {LoginSessions} = require('../../util/login/sessions');
const {LoginError, CookieJar} = require('../../util/login/http');

const OWNER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const qr = () => ({jar: new CookieJar(), qrsig: 'secret-qr', qrimg: 'data:image/png;base64,eA=='});
function make(t, overrides = {}, options = {}) {
  let clock = 10000;
  const protocol = {create: async () => qr(), poll: async () => ({status: 'waiting'}), ...overrides};
  const sessions = new LoginSessions({protocol, now: () => clock, ...options});
  t.after(() => sessions.close());
  return {sessions, advance: amount => { clock += amount; }};
}

test('owner isolation and idempotent cancel do not reveal whether another session exists', async t => {
  const {sessions} = make(t);
  const created = await sessions.create(OWNER);
  assert.deepEqual(await sessions.status(OTHER, created.unikey), await sessions.status(OTHER, 'c'.repeat(64)));
  sessions.cancel(OTHER, created.unikey);
  assert.equal((await sessions.status(OWNER, created.unikey)).status, 'waiting');
  const result = sessions.cancel(OWNER, created.unikey);
  assert.deepEqual(sessions.cancel(OWNER, created.unikey), result);
  assert.equal((await sessions.status(OWNER, created.unikey)).expired, true);
});

test('parallel polls are single-flight and the next upstream call is throttled', async t => {
  let count = 0;
  let resolve;
  const {sessions, advance} = make(t, {poll: () => { count++; return new Promise(done => { resolve = done; }); }});
  const created = await sessions.create(OWNER);
  const first = sessions.status(OWNER, created.unikey);
  const second = sessions.status(OWNER, created.unikey);
  assert.equal(count, 1);
  resolve({status: 'scanned'});
  assert.deepEqual(await first, await second);
  await sessions.status(OWNER, created.unikey);
  assert.equal(count, 1);
  advance(1500);
  const third = sessions.status(OWNER, created.unikey);
  assert.equal(count, 2);
  resolve({status: 'scanned'});
  await third;
});

for (const mode of ['cancel', 'expiry']) {
  test(`${mode} during an in-flight exchange cannot resurrect credentials`, async t => {
    let resolve;
    let active;
    const {sessions, advance} = make(t, {poll: session => {
      active = session;
      return new Promise(done => { resolve = () => {
        session.pendingCredentials = {musicid: '123', musickey: 'secret'};
        done({done: true, status: 'authorized', cookie: 'secret', credentials: session.pendingCredentials});
      }; });
    }});
    const created = await sessions.create(OWNER);
    const pending = sessions.status(OWNER, created.unikey);
    if (mode === 'cancel') sessions.cancel(OWNER, created.unikey);
    else advance(180000);
    resolve();
    const result = await pending;
    assert.equal(result.expired, true);
    assert.equal(result.cookie, undefined);
    assert.equal(sessions.sessions.size, 0);
    assert.equal(active.pendingCredentials, undefined);
  });
}

test('TTL is enforced on read and creation capacity includes in-flight creates', async t => {
  let resolve;
  const {sessions, advance} = make(t, {create: () => new Promise(done => { resolve = done; })}, {capacity: 1});
  const pending = sessions.create(OWNER);
  await assert.rejects(sessions.create(OTHER), /QQ login capacity/);
  resolve(qr());
  const created = await pending;
  advance(180000);
  assert.equal((await sessions.status(OWNER, created.unikey)).expired, true);
  assert.equal(sessions.sessions.size, 0);
});

test('failed create frees its reserved capacity', async t => {
  const {sessions} = make(t, {create: async () => { throw new LoginError('network'); }}, {capacity: 1});
  await assert.rejects(sessions.create(OWNER), /network/);
  assert.equal(sessions.sessions.size, 0);
});

test('ordinary poll outages retry; completed exchange retries verification without exchanging again', async t => {
  let polls = 0;
  let verifications = 0;
  const {sessions, advance} = make(t, {
    poll: async session => {
      polls++;
      if (polls === 1) throw new LoginError('network');
      session.exchanging = true;
      session.pendingCredentials = {musicid: '123', musickey: 'private'};
      throw new LoginError('network');
    },
    verify: async () => {
      verifications++;
      return {done: true, status: 'authorized', cookie: 'uin=123; qqmusic_key=private', credentials: {musicid: '123'}};
    },
  });
  const created = await sessions.create(OWNER);
  assert.equal((await sessions.status(OWNER, created.unikey)).status, 'waiting');
  advance(1500);
  assert.equal((await sessions.status(OWNER, created.unikey)).status, 'scanned');
  advance(1500);
  assert.equal((await sessions.status(OWNER, created.unikey)).done, true);
  assert.equal(polls, 2);
  assert.equal(verifications, 1);
});

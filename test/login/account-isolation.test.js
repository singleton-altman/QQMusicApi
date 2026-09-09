const test = require('node:test');
const assert = require('node:assert/strict');
const moment = require('moment');
const Cache = require('../../util/cache');

test('business cache expires account-scoped entries with a four-digit year', () => {
  const originalNow = moment.now;
  let clock = Date.UTC(2026, 8, 9, 10);
  moment.now = () => clock;
  try {
    const cache = new Cache();
    cache.set('account:song', {url: 'old-url'}, 1);
    assert.equal(cache.get('account:song').url, 'old-url');
    clock += 120000;
    assert.equal(cache.get('account:song'), undefined);
  } finally { moment.now = originalNow; }
});
const scopedCache = require('../../util/scopedCache');
const song = require('../../routes/song');
const user = require('../../routes/user');

function cache() {
  const values = new Map();
  return {get: key => values.get(key), set: (key, value) => values.set(key, value), values};
}

test('cache scope separates accounts, anonymous requests, and rotated keys without storing raw cookies', () => {
  const underlying = cache();
  const first = scopedCache(underlying, {uin: '123', qqmusic_key: 'private-key'});
  first.set('song', {url: 'https://account-specific'});
  for (const cookie of [{}, {uin: '456', qqmusic_key: 'private-key'}, {uin: '123', qqmusic_key: 'new-key'}]) {
    assert.equal(scopedCache(underlying, cookie).get('song'), undefined);
  }
  assert.deepEqual(scopedCache(underlying, {qqmusic_key: 'private-key', uin: '123'}).get('song'),
    {url: 'https://account-specific'});
  assert.doesNotMatch([...underlying.values.keys()].join(','), /private-key|uin|qqmusic_key/);
});

for (const route of ['/url', '/urls']) {
  test(`song${route} uses one request identity and never borrows global credentials`, async () => {
    const underlying = cache();
    const calls = [];
    async function fetchFor(cookies) {
      let result;
      await song[route]({
        req: {query: {id: 'song-mid', ownCookie: 1}, body: {}, cookies},
        res: {send: value => { result = value; }},
        globalCookie: {userCookie: () => { throw new Error('must never use global credentials'); }},
        cache: scopedCache(underlying, cookies),
        request: async input => {
          const payload = typeof input === 'string' ? JSON.parse(new URL(input).searchParams.get('data')) :
            JSON.parse(input.data.data);
          calls.push(payload);
          return {req_0: {data: {testfile2g: 1, sip: ['https://audio.example/'],
            midurlinfo: [{songmid: 'song-mid', purl: `user-${cookies.uin || '0'}.mp3`}]}}};
        },
      });
      return result;
    }
    const first = await fetchFor({uin: '123', qqmusic_key: 'first-key'});
    const second = await fetchFor({uin: '456', qm_keyst: 'second-key'});
    const anonymous = await fetchFor({});
    assert.notDeepEqual(first, second);
    assert.notDeepEqual(first, anonymous);
    assert.equal(calls.length, 3);
    for (const [index, uin, key] of [[0, '123', 'first-key'], [1, '456', 'second-key'], [2, '0', '']]) {
      assert.equal(calls[index].req_0.param.uin, uin);
      assert.equal(calls[index].comm.uin, uin);
      assert.equal(calls[index].comm.authst, key);
    }
  });
}

test('legacy cookie repositories return 410 without reading, writing, or returning any cookie', () => {
  for (const route of ['/getCookie', '/setCookie']) {
    let status;
    let response;
    user[route]({
      req: {query: {id: '123'}, body: {data: 'uin=123; qqmusic_key=private'}},
      res: {status: code => { status = code; return {send: value => { response = value; }}; }},
      globalCookie: {allCookies: () => { throw new Error('must not read cookie store'); }},
    });
    assert.equal(status, 410);
    assert.equal(response.result, 410);
    assert.doesNotMatch(JSON.stringify(response), /private|qqmusic_key/);
  }
});

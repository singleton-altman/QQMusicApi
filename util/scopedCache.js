const {createHash} = require('node:crypto');

// Bind every route's cache to its actual request cookies, including key rotation.
// Only a one-way fingerprint is stored in a cache key.
module.exports = (cache, cookies = {}) => {
  const identity = createHash('sha256').update(JSON.stringify(
    Object.keys(cookies).sort().map(key => [key, cookies[key]]),
  )).digest('hex');
  return {
    get: key => cache.get(`${identity}:${key}`),
    set: (key, value, time) => cache.set(`${identity}:${key}`, value, time),
  };
};

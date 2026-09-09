// SPDX-License-Identifier: GPL-3.0-only
const express = require('express');
const {timingSafeEqual} = require('node:crypto');
const {LoginSessions} = require('./sessions');
const {LoginError} = require('./http');

function createLoginRouter({sessions = new LoginSessions(), secret = () => process.env.QQMUSIC_LOGIN_SECRET} = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    const expected = secret();
    if (typeof expected !== 'string' || expected.length < 32) {
      return res.status(503).json({result: 503, errMsg: 'QQ 扫码登录服务未配置'});
    }
    const token = req.get('authorization') || '';
    const expectedHeader = `Bearer ${expected}`;
    if (Buffer.byteLength(token) !== Buffer.byteLength(expectedHeader) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(expectedHeader))) {
      return res.status(401).json({result: 401, errMsg: '登录服务鉴权失败'});
    }
    if (req.method !== 'POST') {
      res.set('Allow', 'POST');
      return res.status(405).json({result: 405, errMsg: '请使用 POST 请求'});
    }
    if (!req.is('application/json') || Object.keys(req.query).length) {
      return res.status(400).json({result: 400, errMsg: '请通过 JSON 请求体传递登录参数'});
    }
    next();
  });
  router.use(express.json({limit: '2kb'}));
  for (const [path, needsKey, action] of [
    ['/qr/create', false, body => sessions.create(body.owner, body.loginType)],
    ['/qr/status', true, body => sessions.status(body.owner, body.unikey)],
    ['/qr/cancel', true, body => sessions.cancel(body.owner, body.unikey)],
  ]) {
    router.post(path, async (req, res) => {
      const body = req.body;
      if (!body || typeof body.owner !== 'string' || !/^[a-f0-9]{64}$/.test(body.owner) ||
          (!needsKey && body.loginType !== undefined && !['qq', 'wechat'].includes(body.loginType)) ||
          (needsKey && (typeof body.unikey !== 'string' || !/^[a-f0-9]{64}$/.test(body.unikey)))) {
        return res.status(400).json({result: 400, errMsg: '无效的登录会话参数'});
      }
      try {
        return res.json({result: 100, data: await action(body)});
      } catch (err) {
        const capacity = err instanceof LoginError && err.kind === 'capacity';
        return res.status(capacity ? 429 : 502).json({
          result: capacity ? 429 : 502,
          errMsg: capacity ? '登录会话过多，请稍后重试' : 'QQ 登录服务暂时不可用，请重新获取二维码',
        });
      }
    });
  }
  router.use((req, res) => res.status(404).json({result: 404, errMsg: '登录接口不存在'}));
  router.use((err, req, res, next) => res.status(400).json({result: 400, errMsg: '无效的登录请求'}));
  return router;
}

module.exports = {createLoginRouter};

# QQMusicApi

## Musix fork：手机 QQ 扫码登录

此 fork 保留原业务 API，新增服务间扫码登录接口。运行环境为 **Node.js 22 或更新版本**（使用 `npm ci` 和 `package-lock.json`；已移除引用失效镜像的旧 Yarn 锁文件），登录模块使用内建 `fetch`，没有新增运行时依赖。仅支持 **手机 QQ** 扫码，微信和 QQ 音乐 App 扫码尚未实现。

在 QQMusicApi 服务和 Musix 后端配置相同的 `QQMUSIC_LOGIN_SECRET`（至少 32 个字符）。该值只能保存在服务端。未配置或过短时登录接口返回 HTTP 503；鉴权失败返回 401。建议通过容器私网连接服务，公网部署时使用 HTTPS，并限制登录接口仅由应用后端访问。

所有登录接口均为 `POST`，请求头需要 `Authorization: Bearer <QQMUSIC_LOGIN_SECRET>`、`Content-Type: application/json`。会话标识仅从 JSON 请求体读取，响应均带 `Cache-Control: no-store`；GET 返回 405。

| 路径 | JSON 请求体 | `result: 100` 的 `data` |
| --- | --- | --- |
| `/login/qr/create` | `{ "owner": "64 位小写十六进制值" }` | `unikey`（随机 64 位 hex）、`qrimg`（PNG data URL）、`expiresAt`（毫秒时间戳）、`message` |
| `/login/qr/status` | `{ "owner": "同上", "unikey": "创建时返回的值" }` | `done`、`status`、`message`、`retryAfterMs: 1500`，终止时增加 `expired` 或 `cancelled` |
| `/login/qr/cancel` | `{ "owner": "同上", "unikey": "创建时返回的值" }` | `cancelled: true`；重复取消幂等 |

`owner` 应由后端根据已认证用户身份生成，例如以服务端密钥对用户 ID 做 HMAC-SHA256。不得由浏览器指定另一个用户的 owner。错误 owner 和不存在的会话均返回相同的过期状态。

状态包括 `waiting`（待扫码）、`scanned`（待手机确认或正在验证音乐凭据）、`authorized`、`expired`、`cancelled`、`error`。`error` 同时返回 `expired: true`，提示重新扫码。

仅在 **QQ 扫码确认 → 固定 check_sig → OAuth code → QQLogin → GetLoginUserInfo 验证成功** 后返回 `done: true`，成功数据额外包含：

```json
{
  "done": true,
  "status": "authorized",
  "uin": "字符串形式的音乐账号 ID",
  "cookie": "uin=<musicid>; qqmusic_uin=<musicid>; qqmusic_key=<musickey>; qm_keyst=<musickey>; login_type=1",
  "credentials": {
    "musicid": "字符串形式的音乐账号 ID",
    "str_musicid": "字符串形式的音乐账号 ID",
    "musickey": "音乐访问凭据",
    "login_type": 1
  },
  "message": "QQ 音乐登录成功",
  "retryAfterMs": 1500
}
```

上游返回时还会保留 `refresh_key`、`refresh_token`、`access_token`、`openid`、`unionid` 等字段。上述成功结果只能由 Musix 后端消费、加密保存，浏览器仅接收绑定摘要和登录状态。`musicid` 始终作为字符串处理，以保留 64 位账号 ID 的精度。音乐 CGI 的 `tmeLoginType: 2` 与网页 Cookie 的 `login_type=1` 采用不同编号，均代表此处的 QQ 登录。

每个会话有效期 180 秒，使用独立 Cookie jar，最多同时保留 256 个会话（包括正在创建的会话）。轮询按会话单飞并限制为每 1.5 秒一次。完成结果保留到取消或 TTL，方便业务数据库保存失败时再次读取；保存成功后调用 cancel 释放。进程重启会丢失内存会话，多副本部署需要会话粘滞路由。会话在飞时取消或过期，晚到的授权结果也不会重新生效。

登录网络请求超时为 10 秒；普通状态查询及已有凭据的认证检查可以重试；授权换票结果不确定时要求重新扫码，防止重复消费一次性 code。登录模块不执行 JSONP，不自动跟随重定向，只访问固定 HTTPS 域名，不向日志或错误响应输出二维码签名、Cookie、授权 code 或音乐凭据。

此 fork 同时停用旧 `/user/getCookie`、`/user/setCookie` 明文凭据仓接口（HTTP 410），账号凭据由应用后端保存。`/song/url` 与 `/song/urls` 使用当前请求同一组账号和音乐 key，业务缓存按当前请求 Cookie 指纹隔离，避免不同绑定账号共用播放结果。

离线回归测试（不会请求 QQ 服务）：

```sh
npm run test:login
```

测试覆盖完整协议链、状态映射、无效凭据、账号隔离、重复轮询、取消/过期竞态、HTTP 鉴权及错误脱敏；HTTP 测试需允许本机 loopback 监听。真实扫码授权仍需使用者在手机 QQ 确认，并验证实际账号的登录态与音乐接口。

协议实现参考 [L-1124/QQMusicApi](https://github.com/L-1124/QQMusicApi/tree/374017047c39dc987418450b6d513bc216499a69) 的 `qqmusic_api/modules/login.py` 与 `core/versioning.py`（GPL-3.0）。本 fork 延续原项目 GPLv3 许可，保留源代码及来源说明。

[![NPM](https://img.shields.io/npm/v/qq-music-api.svg)](https://www.npmjs.com/package/qq-music-api)
[![github](https://img.shields.io/badge/github-QQMusicApi-brightgreen.svg)](https://github.com/jsososo/QQMusicApi)
[![GitHub Pages Star](https://img.shields.io/github/stars/jsososo/QQMusicApi.svg)](https://github.com/jsososo/QQMusicApi)


接口参考：

[接口文档 Github](https://jsososo.github.io/QQMusicApi/#/)

[接口文档 Vercel](https://qq-api-soso.vercel.app/)


## 快速上手

### Node 服务

```shell script
git clone git@github.com:jsososo/QQMusicApi.git

npm ci --omit=dev

npm start
```

### Docker

```shell script
npm run build:docker

npm run start:docker
```


### npm

```shell script
yarn add qq-music-api
```

#### 接口调用

```javascript
const qqMusic = require('qq-music-api');

// 部分接口依赖 cookie, 这里穿参可以使用字符串或对象
qqMusic.setCookie('xxx=xxx; xxx=xxx;');
// or
qqMusic.setCookie({ a: 'xxx', b: 'xxx' });

qqMusic.api('search', { key: '周杰伦' })
    .then(res => console.log(res))
    .catch(err => console.log('接口调用出错'))

qqMusic.api('search', { key: '周杰伦' })
    .then((res) => console.log('搜索周杰伦：', res))
    .catch(err => console.log('接口调用出错'))

qqMusic.api('search/hot')
    .then((res) => console.log('热搜词：', res))
    .catch(err => console.log('接口调用出错'))//

// 刷新登陆
qqMusic.api('user/refresh')
```

#### 获取当前cookie

```javascript
const qqMusic = require('qq-music-api');

console.log(qqMusic.cookie);
```

#### 获取当前 cookie 用户
```javascript
const qqMusic = require('qq-music-api');

console.log(qqMusic.uin);
```


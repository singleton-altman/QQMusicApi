const search = require('./search');

const song = {
  '/': async ({req, res, request}) => {
    const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
    const {songmid, raw} = req.query;

    if (!songmid) {
      return res.send({
        result: 500,
        errMsg: 'songmid 不能为空',
      });
    }
    const data = {
      data: JSON.stringify({
        comm: {
          cv: 4747474,
          ct: 24,
          format: 'json',
          inCharset: 'utf-8',
          outCharset: 'utf-8',
          uin: req.cookies.uin || '0',
          g_tk: 5381,
        },
        songinfo: {
          method: 'get_song_detail_yqq',
          module: 'music.pf_song_detail_svr',
          param: {
            song_mid: songmid,
          },
        },
      }),
    };

    const result = await request({
      url,
      data,
      headers: {
        referer: 'https://y.qq.com/',
        origin: 'https://y.qq.com',
      },
    });

    if (Number(raw)) {
      return res.send(result);
    }

    if (!result?.songinfo?.data) {
      return res.send({
        result: 500,
        errMsg: '获取歌曲详情失败',
      });
    }

    res &&
    res.send({
      result: 100,
      data: result.songinfo.data,
    });
    return result.songinfo.data;
  },

  '/url': async ({req, res, request, cache, globalCookie}) => {
    const obj = {...req.query, ...req.body};
    const {uin = '0', qqmusic_key = req.cookies.qm_keyst || ''} = req.cookies;
    req.query.ownCookie = 1;

    const {id, type = '128', mediaId = id, isRedirect = '0'} = obj;
    const typeMap = {
      m4a: {
        s: 'C400',
        e: '.m4a',
      },
      128: {
        s: 'M500',
        e: '.mp3',
      },
      320: {
        s: 'M800',
        e: '.mp3',
      },
      ape: {
        s: 'A000',
        e: '.ape',
      },
      flac: {
        s: 'F000',
        e: '.flac',
      },
    };
    const typeObj = typeMap[type];

    if (!typeObj) {
      return res.send({
        result: 500,
        errMsg: 'type 传错了，看看文档去',
      });
    }
    if (!id) {
      return res.send({
        result: 500,
        errMsg: 'id ?',
      });
    }
    const file = `${typeObj.s}${id}${mediaId}${typeObj.e}`;
    const guid = (Math.random() * 10000000).toFixed(0);

    let purl = '';
    let count = 0;
    let cacheKey = `song_url_${file}`;
    let cacheData = cache.get(cacheKey);
    if (cacheData) {
      return res.send(cacheData);
    }
    let domain = '';
    while (!purl && count < 10) {
      count += 1;
      const result = await request({
        url: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
        data: {
          '-': 'getplaysongvkey',
          g_tk: 5381,
          loginUin: uin,
          hostUin: 0,
          format: 'json',
          inCharset: 'utf8',
          outCharset: 'utf-8¬ice=0',
          platform: 'yqq.json',
          needNewCode: 0,
          data: JSON.stringify({
            req_0: {
              module: 'vkey.GetVkeyServer',
              method: 'CgiGetVkey',
              param: {
                filename: [file],
                guid: guid,
                songmid: [id],
                songtype: [0],
                uin: uin,
                loginflag: 1,
                platform: '20',
              },
            },
            comm: {
              uin: uin,
              format: 'json',
              ct: 19,
              cv: 0,
              authst: qqmusic_key,
            },
          }),
        },
      });
      if (res && !result.req_0.data) {
        return res.send({
          result: 400,
          errMsg: '获取链接出错，建议检查是否携带 cookie ',
        });
      }
      if (result.req_0 && result.req_0.data && result.req_0.data.midurlinfo) {
        purl = result.req_0.data.midurlinfo[0].purl;
      }
      if (domain === '') {
        domain =
          result.req_0.data.sip.find(i => !i.startsWith('http://ws')) ||
          result.req_0.data.sip[0];
      }
    }
    if (!purl) {
      return res.send({
        result: 400,
        errMsg: '获取播放链接出错',
      });
    }

    if (Number(isRedirect)) {
      return res.redirect(`${domain}${purl}`);
    }

    cacheData = {
      data: `${domain}${purl}`,
      result: 100,
    };
    res.send(cacheData);
    cache.set(cacheKey, cacheData);
  },

  '/urls': async ({req, res, request, globalCookie, cache}) => {
    const obj = {...req.query, ...req.body};
    const {uin = '0', qqmusic_key = req.cookies.qm_keyst || ''} = req.cookies;
    req.query.ownCookie = 1;

    const {id = ''} = obj;
    const idArr = id.split(',');
    let count = 0;
    const idStr = idArr.map(id => `"${id}"`).join(',');

    let cacheKey = `song_url_${idStr}`;
    let cacheData = cache.get(cacheKey);
    if (cacheData) {
      return res.send(cacheData);
    }
    const payload = {
      req_0: {module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: {
        guid: '2796982635', songmid: idArr, songtype: idArr.map(() => 0),
        uin, loginflag: 1, platform: '20',
      }},
      comm: {uin, format: 'json', ct: 24, cv: 0, authst: qqmusic_key},
    };
    const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg?' + new URLSearchParams({
      '-': 'getplaysongvkey', g_tk: '5381', loginUin: uin, hostUin: '0', format: 'json',
      inCharset: 'utf8', outCharset: 'utf-8', notice: '0', platform: 'yqq.json',
      needNewCode: '0', data: JSON.stringify(payload),
    });
    let isOk = false;
    let result = null;

    const reqFun = async () => {
      count += 1;
      result = await request(url);
      if (result.req_0.data.testfile2g) {
        isOk = true;
      }
    };

    while (!isOk && count < 5) {
      await reqFun().catch(() => (count += 1));
    }

    if (!result || !result.req_0) {
      return res.send({
        result: 200,
        errMsg: '获取链接失败，建议检查是否登录',
      });
    }

    const domain =
      result.req_0.data.sip.find(i => !i.startsWith('http://ws')) ||
      result.req_0.data.sip[0];

    // domain = 'http://122.226.161.16/amobile.music.tc.qq.com/';

    const data = {};
    result.req_0.data.midurlinfo.forEach(item => {
      if (item.purl) {
        data[item.songmid] = `${domain}${item.purl}`;
      }
    });

    cacheData = {
      data,
      result: 100,
    };
    res.send(cacheData);
    cache.set(cacheKey, cacheData);
  },

  // 相似歌曲
  '/similar': async ({req, res, request}) => {
    const {id, raw} = req.query;
    if (!id) {
      return res.send({
        result: 500,
        errMsg: 'id ?',
      });
    }
    const result = await request(
      {
        url: 'http://u.y.qq.com/cgi-bin/musicu.fcg',
        data: JSON.stringify({
          comm: {
            g_tk: 5381,
            format: 'json',
            inCharset: 'utf-8',
            outCharset: 'utf-8',
            notice: 0,
            platform: 'h5',
            needNewCode: 1,
          },
          simsongs: {
            module: 'rcmusic.similarSongRadioServer',
            method: 'get_simsongs',
            param: {
              songid: Number(id),
            },
          },
        }),
        method: 'post',
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      },
      {
        dataType: 'raw',
      },
    );

    if (Number(raw)) {
      return res.send(result);
    }
    return res.send({
      result: 100,
      data: result.simsongs.data.songInfoList,
    });
  },

  // 相关歌单
  '/playlist': async ({req, res, request}) => {
    const {id, raw} = req.query;
    if (!id) {
      return res.send({
        result: 500,
        errMsg: 'id ?',
      });
    }
    const result = await request(
      {
        url: 'http://u.y.qq.com/cgi-bin/musicu.fcg',
        data: JSON.stringify({
          comm: {
            g_tk: 5381,
            format: 'json',
            inCharset: 'utf-8',
            outCharset: 'utf-8',
            notice: 0,
            platform: 'h5',
            needNewCode: 1,
          },
          gedan: {
            module: 'music.mb_gedan_recommend_svr',
            method: 'get_related_gedan',
            param: {
              sin: 0,
              last_id: 0,
              song_type: 1,
              song_id: Number(id),
            },
          },
        }),
        method: 'post',
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      },
      {
        dataType: 'raw',
      },
    );

    if (Number(raw)) {
      return res.send(result);
    }
    return res.send({
      result: 100,
      data: result.gedan.data.vec_gedan,
    });
  },

  // 相关 mv
  '/mv': async ({req, res, request}) => {
    const {id, raw} = req.query;
    if (!id) {
      return res.send({
        result: 500,
        errMsg: 'id ?',
      });
    }
    const result = await request(
      {
        url: 'http://u.y.qq.com/cgi-bin/musicu.fcg',
        data: JSON.stringify({
          comm: {
            g_tk: 5381,
            format: 'json',
            inCharset: 'utf-8',
            outCharset: 'utf-8',
            notice: 0,
            platform: 'h5',
            needNewCode: 1,
          },
          video: {
            module: 'MvService.MvInfoProServer',
            method: 'GetSongRelatedMv',
            param: {
              songid: id,
              songtype: 1,
              lastmvid: 0,
              num: 10,
            },
          },
        }),
        method: 'post',
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      },
      {
        dataType: 'raw',
      },
    );

    if (Number(raw)) {
      return res.send(result);
    }
    return res.send({
      result: 100,
      data: result.video.data.list,
    });
  },
};
module.exports = song;

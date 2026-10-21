const StringHelper = require('../util/StringHelper');

// 歌单写操作走新版 musicu.fcg：旧版 fcg_music_add2songdir / fcg_music_delbatchsong CGI
// 已被 QQ 关闭（返回 403 no permit）。鉴权与 vkey 路由同一套 comm.authst(qqmusic_key)。
const musicuComm = (cookies) => ({
  cv: 4747474,
  ct: 24,
  format: 'json',
  inCharset: 'utf-8',
  outCharset: 'utf-8',
  uin: cookies.uin || '0',
  g_tk: 5381,
  authst: cookies.qqmusic_key || cookies.qm_keyst || '',
});

const musicuRequest = (request, req, payload) => request({
  url: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
  data: {
    data: JSON.stringify(payload),
  },
  headers: {
    referer: 'https://y.qq.com/',
    origin: 'https://y.qq.com',
  },
});

// PlaylistDetailWrite 只认数字 songId；兼容传入 mid 或数字 id。
const resolveSongIds = async (request, req, { mid, id }) => {
  const rawList = String(mid || id || '').split(',').filter(Boolean);
  if (!rawList.length) return [];
  const songIds = [];
  for (const raw of rawList) {
    if (/^\d+$/.test(raw)) {
      songIds.push(Number(raw));
      continue;
    }
    const detail = await musicuRequest(request, req, {
      comm: musicuComm(req.cookies),
      songinfo: {
        module: 'music.pf_song_detail_svr',
        method: 'get_song_detail_yqq',
        param: {
          song_mid: raw,
        },
      },
    });
    const songId = Number(detail?.songinfo?.data?.track_info?.id);
    if (!songId) return null;
    songIds.push(songId);
  }
  return songIds;
};

const sendWriteResult = (res, response, action) => {
  if (!response) return;
  const code = Number(response.code);
  const inner = Number(response.req_1?.code);
  if (inner === 0 && (code === 0 || Number.isNaN(code))) {
    return res.send({
      message: `${action}成功`,
      result: 100,
    });
  }
  const msg = response.req_1?.msg || response.msg || response.errMsg || `code ${inner || code}`;
  if (code === 1000 || inner === 1000 || /登录|login/i.test(String(msg))) {
    return res.send({
      result: 301,
      errMsg: '先登录！',
    });
  }
  return res.send({
    result: 200,
    errMsg: `${action}出错: ${msg}`,
  });
};

const songlistWrite = (method, action) => async ({req, res, request}) => {
  const {mid, id, dirid = 201} = req.query;
  if (!mid && !id) {
    return res.send({
      result: 500,
      errMsg: 'mid ? id ?',
    });
  }
  req.query.ownCookie = 1;
  let songIds;
  try {
    songIds = await resolveSongIds(request, req, {mid, id});
  } catch (e) {
    return res.send({
      result: 200,
      errMsg: `${action}出错: 解析歌曲失败 ${e?.message || e}`,
    });
  }
  if (!songIds) {
    return res.send({
      result: 500,
      errMsg: '无法解析歌曲编号',
    });
  }
  const response = await musicuRequest(request, req, {
    comm: musicuComm(req.cookies),
    req_1: {
      module: 'music.musicasset.PlaylistDetailWrite',
      method,
      param: {
        dirId: Number(dirid) || 201,
        v_songInfo: songIds.map((songId) => ({ songType: 0, songId })),
      },
    },
  });
  return sendWriteResult(res, response, action);
};

module.exports = {
  // 根据 id 获取歌单详情
  '/': async ({req, res, request}) => {
    const {id, raw} = req.query;
    if (!id) {
      return res.send({
        result: 500,
        errMsg: 'id 不能为空',
      })
    }
    const result = await request({
      url: 'http://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
      data: {
        type: 1,
        utf8: 1,
        disstid: id, // 歌单的id
        loginUin: 0,
      },
      headers: {
        Referer: 'https://y.qq.com/n/yqq/playlist',
      },
    });

    if (Number(raw)) {
      res.send(result);
    } else {
      const resData = {
        result: 100,
        data: result.cdlist[0] || {},
      };
      res && res.send(resData)
      return resData;
    }

  },

  // 获取歌单分类
  '/category': async ({req, res, request}) => {
    const {raw} = req.query;

    const result = await request({
      url: 'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg?format=json&inCharset=utf8&outCharset=utf-8',
      headers: {
        Referer: 'https://y.qq.com/'
      }
    });

    if (Number(raw)) {
      res.send(result);
    } else {
      res.send({
        result: 100,
        data: result.data.categories.map((item) => ({
          type: item.categoryGroupName,
          list: (item.items || []).map((obj) => ({
            id: obj.categoryId,
            name: obj.categoryName,
          }))
        })),
      })
    }
  },

  // 根据歌单分类筛选歌单
  '/list': async ({req, res, request}) => {
    const {raw, num = 20, pageSize = num, pageNo = 1, sort = 5, category = 10000000} = req.query;

    const result = await request({
      url: 'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg',
      data: {
        inCharset: 'utf8',
        outCharset: 'utf-8',
        sortId: sort,
        categoryId: category,
        sin: pageSize * (pageNo - 1),
        ein: pageNo * pageSize - 1,
      },
      headers: {
        Referer: 'https://y.qq.com',
      }
    });

    if (Number(raw)) {
      res.send(result);
    } else {
      const {list = [], sortId, categoryId, ein, sum} = result.data;
      res.send({
        result: 100,
        data: {
          list,
          sort: sortId,
          category: categoryId,
          pageNo,
          pageSize,
          total: sum,
        }
      });
    }
  },

  // 获取歌单中 mid 和 id 强制使用传过来的cookie
  '/map': async ({req, res, request}) => {
    const {dirid = 201, raw} = req.query;
    req.query.ownCookie = 1;
    const result = await request({
      url: 'https://c.y.qq.com/splcloud/fcgi-bin/fcg_musiclist_getmyfav.fcg',
      data: {
        dirid,
        dirinfo: 1,
        g_tk: 5381,
        format: 'json',
      },
      headers: {
        Referer: 'https://y.qq.com/n/yqq/playlist',
      },
    });
    if (result.code === 1000) {
      return res.send({
        result: 301,
        errMsg: '未登陆',
      })
    }
    if (Number(raw)) {
      return res.send(result);
    }
    return res.send({
      result: 100,
      data: {
        id: result.map,
        mid: result.mapmid,
      }
    })
  },

  // 把歌曲添加到歌单（红心/我喜欢 dirid=201），强制使用传过来的cookie。
  // 走新版 musicu.fcg PlaylistDetailWrite.AddSonglist；接受 mid 或数字 id，支持逗号批量。
  '/add': songlistWrite('AddSonglist', '添加'),

  // 从歌单中删除歌曲，强制使用传过来的cookie。
  // 走新版 musicu.fcg PlaylistDetailWrite.DelSonglist；接受 mid 或数字 id，支持逗号批量。
  '/remove': songlistWrite('DelSonglist', '删除'),

  // 新建歌单 强制使用传过来的cookie
  '/create': async ({req, res, request}) => {
    req.query.ownCookie = 1;
    const {name} = req.query;
    if (!name) {
      return res.send({
        result: 500,
        errMsg: 'name ? '
      })
    }
    const result = await request({
      url: 'https://c.y.qq.com/splcloud/fcgi-bin/create_playlist.fcg?g_tk=5381',
      method: 'post',
      data: StringHelper.changeUrlQuery({
        loginUin: req.cookies.uin,
        hostUin: 0,
        format: 'json',
        inCharset: 'utf8',
        outCharset: 'utf8',
        notice: 0,
        platform: 'yqq',
        needNewCode: 0,
        g_tk: 5381,
        uin: req.cookies.uin,
        name,
        show: 1,
        formsender: 1,
        utf8: 1,
        qzreferrer: 'https://y.qq.com/portal/profile.html#sub=other&tab=create&',
      }, '?').slice(1),
      headers: {
        Referer: 'https://y.qq.com/n/yqq/playlist',
      },
    });
    switch (Number(result.code)) {
      case 21:
        return res.send({
          result: 200,
          errMsg: '重名啦！',
        });
      case 0:
        return res.send({
          data: {
            dirid: result.dirid,
            message: '创建成功',
          },
          result: 100,
        });
      case 1:
        return res.send({
          result: 301,
          errMsg: '先登录！'
        });
      default:
        return res.send({
          result: 200,
          errMsg: `创建出错: ${result.msg}`,
        })
    }
  },

  // 删除歌单 强制使用传过来的Cookie
  '/delete': async ({req, res, request}) => {
    req.query.ownCookie = 1;
    const {dirid} = req.query;
    if (!dirid) {
      return res.send({
        result: 500,
        errMsg: 'dirid ?',
      })
    }
    let result = await request({
      url: 'https://c.y.qq.com/splcloud/fcgi-bin/fcg_fav_modsongdir.fcg?g_tk=5381',
      method: 'post',
      data: StringHelper.changeUrlQuery({
        loginUin: req.cookies.uin,
        hostUin: 0,
        format: 'fs',
        inCharset: 'GB2312',
        outCharset: 'gb2312',
        notice: 0,
        platform: 'yqq',
        needNewCode: 0,
        g_tk: 5381,
        uin: req.cookies.uin,
        delnum: 1,
        deldirids: dirid,
        forcedel: 1,
        formsender: 1,
        source: 103,
      }, '?').slice(1),
      headers: {
        Referer: 'https://y.qq.com/n/yqq/playlist',
      },
    }, {
      dataType: 'raw',
    });
    result = JSON.parse(result.replace(/(^.+\()|(\).+$)/g, ''));

    switch (Number(result.code)) {
      case 0:
        return res.send({
          message: '删除成功',
          result: 100,
        });
      case 1:
        return res.send({
          result: 301,
          errMsg: '先登录！'
        });
      default:
        return res.send({
          result: 200,
          errMsg: `删除出错: ${result.msg}`,
        })
    }
  },

  // 收藏歌单 强制使用传过来的Cookie
  '/collect': async ({req, res, request}) => {
    req.query.ownCookie = 1;
    // op: 1 收藏，2 取消收藏
    const {id, op} = req.query;
    if (!id || op === undefined) {
      return res.send({
        result: 500,
        errMsg: 'id or op?',
      })
    }
    const result = await request({
      url: 'https://c.y.qq.com/folder/fcgi-bin/fcg_qm_order_diss.fcg',
      data: {
        loginUin: req.cookies.uin,
        hostUin: 0,
        inCharset: 'GB2312',
        outCharset: 'utf8',
        platform: 'yqq',
        format: 'json',
        g_tk: 799643780,
        uin: req.cookies.uin,
        dissid: id,
        notice: 0,
        needNewCode: 0,
        from: 1,
        optype: String(op),
        utf8: 1,
        qzreferrer: `https://y.qq.com/n/yqq/playlist/${id}.html`,
      },
      headers: {
        Referer: `https://y.qq.com/n/yqq/playlist/${id}.html`,
        origin: 'https://imgcache.qq.com',
        'content-type': 'application/x-www-form-urlencoded',
      }
    }, {
      dataType: 'raw'
    });
    if (result.code) {
      return res.send({
        result: 200,
        errMsg: result.msg,
      })
    }
    return res.send({
      result: 100,
      data: {
        message: '操作成功',
      }
    });
  },

  // 这是一个把网易云歌单进行简单搬运到qq音乐的功能，运行的比较慢，看到的人感兴趣的就自己研究一下吧
  // '/move': async ({req, res, request}) => {
  //   const {id} = req.query;
  //   const url = `http://music.jsososo.com/api/playlist/detail?id=${id}`;
  //
  //   const result = await request(url);
  //   const list = [];
  //
  //   for (let index = 0; index < result.playlist.tracks.length; index++) {
  //     const item = result.playlist.tracks[index];
  //     const song = {
  //       name: item.name,
  //       artist: item.ar.map(a => a.name).join('/'),
  //       album: item.al.name,
  //     };
  //     const key = `${song.name} ${song.artist} ${song.album}`;
  //     try {
  //       const obj = await request(`http://music.jsososo.com/apiQ/song/find?key=${key}`);
  //       if (obj.data && obj.data.songmid) {
  //         list.push(obj.data.songmid);
  //         await request({
  //           url: `http://127.0.0.1:${global.PORT}/songlist/add`,
  //           data: {
  //             mid: obj.data.songmid,
  //             dirid: 201,
  //           }
  //         });
  //       }
  //     } catch (e) {
  //
  //     }
  //   }
  //
  //   res.send(list);
  // },
}

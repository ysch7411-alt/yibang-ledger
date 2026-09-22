const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getAccessToken } = require('../lib/wxtoken');
const log = require('../lib/log');

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.json({ code: 401, msg: '未登录' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.json({ code: 401, msg: 'token无效' });
  }
}

const TARGET = 2; // 累计邀请 2 人解锁终身版

// 我的推广进度
router.get('/info', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT p.id, p.status, p.created_at, u.nickname, u.shop_name ' +
      'FROM promotions p LEFT JOIN users u ON p.invitee_id = u.id ' +
      'WHERE p.inviter_id = ? ORDER BY p.id DESC LIMIT 50',
      [req.userId]
    );

    const list = rows.map((r) => ({
      id: r.id,
      name: r.shop_name || r.nickname || '微信好友',
      // 前端按字符串判断，这里直接给 'paid' / 'pending'
      status: Number(r.status) === 1 ? 'paid' : 'pending',
      created_at: r.created_at
    }));

    const paidCount = list.filter((x) => x.status === 'paid').length;

    res.json({
      code: 0,
      data: {
        inviteCount: paidCount,          // 只统计已购买，才能对应「邀请 2 人解锁」
        totalCount: list.length,
        target: TARGET,
        unlocked: paidCount >= TARGET,
        list
      }
    });
  } catch (err) {
    log.error('推广信息错误:', err);
    res.json({ code: 500, msg: '获取推广信息失败' });
  }
});

// 绑定邀请关系（被邀请人首次进入时调用）
router.post('/bind', auth, async (req, res) => {
  const inviterId = Number(req.body.inviterId || req.body.from || 0);
  if (!inviterId) return res.json({ code: 400, msg: '缺少邀请人' });
  if (inviterId === Number(req.userId)) return res.json({ code: 400, msg: '不能邀请自己' });

  try {
    const [exist] = await pool.query(
      'SELECT id FROM promotions WHERE invitee_id = ? LIMIT 1',
      [req.userId]
    );
    if (exist.length) {
      return res.json({ code: 0, msg: '已绑定邀请关系', data: { id: exist[0].id } });
    }

    const [result] = await pool.query(
      'INSERT INTO promotions (inviter_id, invitee_id, status) VALUES (?, ?, 0)',
      [inviterId, req.userId]
    );
    res.json({ code: 0, msg: '绑定成功', data: { id: result.insertId } });
  } catch (err) {
    log.error('绑定邀请错误:', err);
    res.json({ code: 500, msg: '绑定失败' });
  }
});

/**
 * 我的专属小程序码（给「分销海报」用）。
 * scene = `inviter=<userId>` → 对方扫码进小程序后，app.captureInvite() 能认出是谁邀请的，
 * 登录成功后自动落库（这条链在本项目里已经通了）。
 *
 * 为什么返回 **base64** 而不是一个图片 URL：
 *   前端要把这张图画到 canvas 上，就得先把图拿到本地。走 wx.downloadFile 需要
 *   把 api.dtzai.cn 配进 mp 后台的「downloadFile 合法域名」—— 又多一个必须人工配、
 *   配错整张海报就白掉的依赖。base64 让前端直接 writeFile 成临时文件，绕开它。
 *
 * 为什么缓存：同一个人的码永远不变，而生成要调微信接口（有频次限制）。
 * 落盘到 uploads/wxacode/u<id>.jpg，第二次直接读盘。
 */
const CODE_DIR = path.join(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'), 'wxacode');

router.get('/wxacode', auth, async (req, res) => {
  try {
    if (!fs.existsSync(CODE_DIR)) fs.mkdirSync(CODE_DIR, { recursive: true });
    const file = path.join(CODE_DIR, 'u' + req.userId + '.jpg');

    if (fs.existsSync(file) && fs.statSync(file).size > 1000) {
      return res.json({ code: 0, data: { imageBase64: fs.readFileSync(file).toString('base64'), cached: true } });
    }

    const token = await getAccessToken();
    const r = await axios.post(
      'https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=' + token,
      {
        scene: 'inviter=' + req.userId,
        page: 'pages/record/record',
        // 未发布的小程序没有"已发布页面"可校验，必须关掉 path 校验，否则直接报错
        check_path: false,
        width: 430
      },
      { responseType: 'arraybuffer', timeout: 30000 }
    );

    const buf = Buffer.from(r.data);
    // 微信出错时返回的是 JSON 而不是图片。只看 content-type 不够稳，直接看魔数：
    // JPEG = ffd8…，PNG = 89504e47…，两个都不是就当失败，把微信的原话带出来。
    const magic = buf.slice(0, 4).toString('hex');
    if (magic.indexOf('ffd8') !== 0 && magic !== '89504e47') {
      let msg = '';
      try { msg = JSON.parse(buf.toString('utf8')).errmsg || ''; } catch (e) { msg = buf.toString('utf8').slice(0, 120); }
      log.error('生成小程序码失败:', msg);
      return res.json({ code: 500, msg: '生成小程序码失败：' + (msg || '返回的不是图片') });
    }

    fs.writeFileSync(file, buf);
    res.json({ code: 0, data: { imageBase64: buf.toString('base64'), cached: false } });
  } catch (err) {
    log.error('小程序码错误:', err.message);
    res.json({ code: 500, msg: '生成小程序码失败' });
  }
});

module.exports = router;

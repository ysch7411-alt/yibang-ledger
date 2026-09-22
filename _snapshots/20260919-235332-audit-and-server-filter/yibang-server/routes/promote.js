const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');

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
    console.error('推广信息错误:', err);
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
    console.error('绑定邀请错误:', err);
    res.json({ code: 500, msg: '绑定失败' });
  }
});

module.exports = router;

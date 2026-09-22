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

// 店员列表
router.get('/list', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, nickname, shop_name, role, created_at FROM users WHERE boss_id = ?',
      [req.userId]
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    res.json({ code: 500, msg: '获取店员列表失败' });
  }
});

// 待审核记录
router.get('/pending', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT t.*, c.name as contact_name, u.nickname as creator_name FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id LEFT JOIN users u ON t.created_by = u.id WHERE t.user_id = ? AND t.status = 0 ORDER BY t.created_at DESC',
      [req.userId]
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    res.json({ code: 500, msg: '获取待审核记录失败' });
  }
});

// 审核记录
router.post('/approve', auth, async (req, res) => {
  const { id, status } = req.body || {}; // 1通过 2驳回

  // 审计抓到的假成功：不传参数时 UPDATE 影响了 0 行，接口照样回「审核完成」。
  // 先校验参数，再校验真的改到了行 —— 改不到就得如实说，不能报成功。
  if (!id) return res.json({ code: 400, msg: '缺少要审核的记录 id' });
  if (![1, 2].includes(Number(status))) {
    return res.json({ code: 400, msg: 'status 只能是 1（通过）或 2（驳回）' });
  }

  try {
    const [r] = await pool.query(
      'UPDATE transactions SET status = ? WHERE id = ? AND user_id = ?',
      [Number(status), id, req.userId]
    );
    if (!r.affectedRows) {
      return res.json({ code: 404, msg: '没有找到这笔待审记录（可能已被处理）' });
    }
    res.json({ code: 0, msg: '审核完成' });
  } catch (err) {
    console.error('审核失败:', err && err.message);
    res.json({ code: 500, msg: '审核失败' });
  }
});

module.exports = router;

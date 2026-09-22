const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const notify = require('../lib/notification');

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

// 获取通知列表
router.get('/list', auth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const list = await notify.getList(req.userId, limit, offset);
    res.json({ code: 0, data: list });
  } catch (err) {
    console.error('获取通知列表失败:', err);
    res.json({ code: 500, msg: '获取通知列表失败' });
  }
});

// 获取未读数量
router.get('/unread-count', auth, async (req, res) => {
  try {
    const count = await notify.getUnreadCount(req.userId);
    res.json({ code: 0, data: { count } });
  } catch (err) {
    console.error('获取未读数量失败:', err);
    res.json({ code: 500, msg: '获取失败' });
  }
});

// 标记单条已读
router.post('/read', auth, async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.json({ code: 400, msg: '缺少通知id' });

  try {
    const ok = await notify.markAsRead(req.userId, id);
    if (ok) {
      res.json({ code: 0, msg: '已标记已读' });
    } else {
      res.json({ code: 404, msg: '通知不存在' });
    }
  } catch (err) {
    console.error('标记已读失败:', err);
    res.json({ code: 500, msg: '操作失败' });
  }
});

// 标记全部已读
router.post('/read-all', auth, async (req, res) => {
  try {
    const count = await notify.markAllAsRead(req.userId);
    res.json({ code: 0, msg: `已标记 ${count} 条为已读`, data: { count } });
  } catch (err) {
    console.error('标记全部已读失败:', err);
    res.json({ code: 500, msg: '操作失败' });
  }
});

module.exports = router;

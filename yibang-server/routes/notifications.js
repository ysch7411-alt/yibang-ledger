const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const notify = require('../lib/notification');
const push = require('../lib/push');
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

// 获取通知列表
router.get('/list', auth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const list = await notify.getList(req.userId, limit, offset);
    res.json({ code: 0, data: list });
  } catch (err) {
    log.error('获取通知列表失败:', err);
    res.json({ code: 500, msg: '获取通知列表失败' });
  }
});

// 获取未读数量
router.get('/unread-count', auth, async (req, res) => {
  try {
    const count = await notify.getUnreadCount(req.userId);
    res.json({ code: 0, data: { count } });
  } catch (err) {
    log.error('获取未读数量失败:', err);
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
    log.error('标记已读失败:', err);
    res.json({ code: 500, msg: '操作失败' });
  }
});

// 标记全部已读
router.post('/read-all', auth, async (req, res) => {
  try {
    const count = await notify.markAllAsRead(req.userId);
    res.json({ code: 0, msg: `已标记 ${count} 条为已读`, data: { count } });
  } catch (err) {
    log.error('标记全部已读失败:', err);
    res.json({ code: 500, msg: '操作失败' });
  }
});

/* ═══════════ 订阅消息（真推送）═══════════
   一次性订阅：用户授权一次 = 后端能发一条。所以前端每次授权成功都要来记一笔。

   ⚠️ 模板 id **只从服务端配置读**，不接受前端传进来的值 ——
   否则谁都能往里塞垃圾 tmpl_id，额度表会被写脏，而脏数据在定时任务里是静默的。
   （前端拿它只是为了调 wx.requestSubscribeMessage，不是让它决定用什么模板。） */
async function configuredTmplId() {
  const [rows] = await pool.query("SELECT payload FROM app_configs WHERE cfg_key = 'global'");
  const cfg = (rows[0] && rows[0].payload) || {};
  return String((cfg.push && cfg.push.daily && cfg.push.daily.tmplId) || '').trim();
}

// 前端启动时问一次：这功能开了吗？模板 id 是什么？我还剩几次额度？
router.get('/subscribe', auth, async (req, res) => {
  try {
    const tmplId = await configuredTmplId();
    if (!tmplId) return res.json({ code: 0, data: { configured: false, tmplId: '', remain: 0 } });
    const remain = await push.remain(req.userId, tmplId);
    res.json({ code: 0, data: { configured: true, tmplId, remain } });
  } catch (err) {
    log.error('查订阅状态失败:', err.message);
    res.json({ code: 500, msg: '查询失败' });
  }
});

// 用户授权成功后 +1 次下发额度
router.post('/subscribe', auth, async (req, res) => {
  try {
    const tmplId = await configuredTmplId();
    if (!tmplId) return res.json({ code: 400, msg: '订阅消息还没配置' });
    await push.grant(req.userId, tmplId, 1);
    const remain = await push.remain(req.userId, tmplId);
    res.json({ code: 0, msg: '已记录', data: { remain } });
  } catch (err) {
    log.error('记录订阅授权失败:', err.message);
    res.json({ code: 500, msg: '记录失败' });
  }
});

module.exports = router;

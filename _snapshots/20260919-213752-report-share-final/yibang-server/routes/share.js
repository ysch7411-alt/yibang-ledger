const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { dayOr } = require('../lib/ledger');

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

// 生成分享链接
router.post('/create', auth, async (req, res) => {
  const { type, contact_id, data_date, expire_days = 7 } = req.body || {};

  // 空参数也能建出一条"分享"来，是审计里抓到的假成功：type 是 null 的分享记录
  // 打开后谁也不知道该显示什么。先校验清楚再说。
  const t = Number(type);
  if (![1, 2].includes(t)) {
    return res.json({ code: 400, msg: '请指定分享类型（1 每日汇总 / 2 客户对账）' });
  }
  if (t === 2 && !contact_id) {
    return res.json({ code: 400, msg: '客户对账分享需要指定 contact_id' });
  }
  const days = Number(expire_days);
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    return res.json({ code: 400, msg: 'expire_days 需要在 1~365 之间' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expireAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  try {
    await pool.query(
      'INSERT INTO shares (token, user_id, type, contact_id, data_date, expire_at) VALUES (?, ?, ?, ?, ?, ?)',
      [token, req.userId, t, contact_id || null, dayOr(data_date, null), expireAt]
    );

    res.json({
      code: 0,
      msg: '分享链接生成成功',
      data: {
        token,
        url: `https://api.dtzai.cn/share/${token}`,
        expire_at: expireAt
      }
    });
  } catch (err) {
    res.json({ code: 500, msg: '生成分享失败' });
  }
});

// 公开接口：查看分享内容
router.get('/view/:token', async (req, res) => {
  const { token } = req.params;

  try {
    const [shares] = await pool.query('SELECT * FROM shares WHERE token = ? AND is_valid = 1 AND expire_at > NOW()', [token]);

    if (shares.length === 0) {
      return res.json({ code: 404, msg: '分享链接无效或已过期' });
    }

    const share = shares[0];

    // 更新浏览次数
    await pool.query('UPDATE shares SET view_count = view_count + 1 WHERE id = ?', [share.id]);

    // 获取分享数据
    let data;
    if (share.type === 1) {
      // 每日汇总
      const [summary] = await pool.query(
        "SELECT COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END), 0) as income, COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END), 0) as expense FROM transactions WHERE user_id = ? AND record_date = ? AND status = 1",
        [share.user_id, share.data_date]
      );
      const [details] = await pool.query(
        'SELECT t.*, c.name as contact_name FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id WHERE t.user_id = ? AND t.record_date = ? AND t.status = 1 ORDER BY t.created_at DESC',
        [share.user_id, share.data_date]
      );
      data = { summary: summary[0], details };
    } else {
      // 客户对账
      const [contact] = await pool.query('SELECT * FROM contacts WHERE id = ?', [share.contact_id]);
      const [transactions] = await pool.query(
        'SELECT * FROM transactions WHERE user_id = ? AND contact_id = ? AND status = 1 ORDER BY record_date DESC',
        [share.user_id, share.contact_id]
      );
      data = { contact: contact[0], transactions };
    }

    res.json({ code: 0, data });
  } catch (err) {
    res.json({ code: 500, msg: '获取分享内容失败' });
  }
});

module.exports = router;

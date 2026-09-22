const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
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

/**
 * 「越用越懂」的可见账本。
 *
 * 背景：商家词表（merchant_terms）和纠正流水（ai_corrections）一直在后台默默积累，
 * 但**用户完全看不见** —— 招牌卖点「越用越懂」只能靠我们自己说，用户感知不到。
 * 这个接口把"它到底学会了什么"摊开给老板看：学会了哪些叫法、哪些是你亲自纠正的。
 *
 * 注意：alias === canonical 的词条（自动积累的同名项）不算"学会了一个叫法"，
 * 只是把用过的词登记了一下，不列进 nameMap，否则数字虚高、看着像在吹。
 */
router.get('/info', auth, async (req, res) => {
  try {
    const [nameRows] = await pool.query(
      "SELECT alias, canonical, hits, source, updated_at FROM merchant_terms " +
      "WHERE user_id = ? AND kind = 'contact' AND alias <> canonical " +
      "ORDER BY (source = 'user') DESC, updated_at DESC LIMIT 10",
      [req.userId]
    );
    const [reasonRows] = await pool.query(
      "SELECT canonical, hits FROM merchant_terms WHERE user_id = ? AND kind = 'reason' " +
      'ORDER BY hits DESC LIMIT 8',
      [req.userId]
    );
    const [cntRows] = await pool.query(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN source = ? THEN 1 ELSE 0 END) AS from_user FROM merchant_terms WHERE user_id = ?',
      ['user', req.userId]
    );
    const [corRows] = await pool.query('SELECT COUNT(*) AS c FROM ai_corrections WHERE user_id = ?', [req.userId]);

    const cnt = cntRows[0] || {};
    const nameMap = nameRows.map((r) => ({
      from: r.alias,
      to: r.canonical,
      hits: Number(r.hits) || 1,
      byUser: r.source === 'user'      // true = 老板亲自纠正出来的，最值得展示
    }));

    res.json({
      code: 0,
      data: {
        termCount: Number(cnt.total) || 0,
        nameCount: nameMap.length,                 // 真正"学会的叫法"数量
        learnedFromUser: Number(cnt.from_user) || 0,
        correctionCount: Number(corRows[0] && corRows[0].c) || 0,
        nameMap,
        reasons: reasonRows.map((r) => ({ text: r.canonical, hits: Number(r.hits) || 1 }))
      }
    });
  } catch (err) {
    log.error('记忆信息错误:', err && err.message);
    res.json({ code: 500, msg: '获取记忆信息失败' });
  }
});

module.exports = router;

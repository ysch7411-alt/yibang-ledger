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

// 新增往来对象
router.post('/create', auth, async (req, res) => {
  const { name, type, phone, remark } = req.body;
  if (!name) return res.json({ code: 400, msg: '缺少名称' });
  try {
    const [result] = await pool.query(
      'INSERT INTO contacts (user_id, name, type, phone, remark, balance) VALUES (?, ?, ?, ?, ?, 0)',
      [req.userId, name, type || 1, phone || null, remark || null]
    );
    res.json({ code: 0, msg: '添加成功', data: { id: result.insertId } });
  } catch (err) {
    res.json({ code: 500, msg: '添加失败' });
  }
});

// 往来对象列表
router.get('/list', auth, async (req, res) => {
  const { type } = req.query;
  try {
    let sql = 'SELECT * FROM contacts WHERE user_id = ?';
    const params = [req.userId];
    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    sql += ' ORDER BY balance DESC, id DESC';
    const [rows] = await pool.query(sql, params);
    res.json({ code: 0, data: rows });
  } catch (err) {
    res.json({ code: 500, msg: '获取列表失败' });
  }
});

// 应收应付总览
router.get('/summary', auth, async (req, res) => {
  try {
    const [receivable] = await pool.query(
      'SELECT COALESCE(SUM(balance), 0) as total FROM contacts WHERE user_id = ? AND balance > 0',
      [req.userId]
    );
    const [payable] = await pool.query(
      'SELECT COALESCE(SUM(ABS(balance)), 0) as total FROM contacts WHERE user_id = ? AND balance < 0',
      [req.userId]
    );
    res.json({
      code: 0,
      data: {
        receivable: Number(receivable[0].total),
        payable: Number(payable[0].total)
      }
    });
  } catch (err) {
    res.json({ code: 500, msg: '获取汇总失败' });
  }
});

// 单个往来对象详情 + 往来明细
router.get('/detail', auth, async (req, res) => {
  const { id } = req.query;
  if (!id) return res.json({ code: 400, msg: '缺少 id' });

  try {
    const [contacts] = await pool.query(
      'SELECT * FROM contacts WHERE id = ? AND user_id = ?',
      [id, req.userId]
    );
    if (!contacts.length) return res.json({ code: 404, msg: '往来对象不存在' });

    /* 2026-09-22 修：原来这里是 SELECT *。
       连接池没设 dateStrings/timezone，mysql2 会把 DATE 返回成 JS Date，
       JSON 序列化后是 UTC 的 ISO 串 —— 页面直接打印 record_date，
       于是往来详情里显示的是「2026-09-20T16:00:00.000Z」这种串，
       而且**日期还差一天**（本地 9-21 零点 = UTC 9-20 16 点）。
       按项目约定：DATE 一律在源头用 DATE_FORMAT 取成字符串，列清单显式写。 */
    const [records] = await pool.query(
      'SELECT id, type, amount, content, qty, unit, unit_price, pay_method, ' +
      "DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date, created_at " +
      'FROM transactions WHERE user_id = ? AND contact_id = ? ' +
      'ORDER BY record_date DESC, id DESC LIMIT 200',
      [req.userId, id]
    );

    res.json({ code: 0, data: { contact: contacts[0], records } });
  } catch (err) {
    log.error('往来详情错误:', err);
    res.json({ code: 500, msg: '获取详情失败' });
  }
});

module.exports = router;

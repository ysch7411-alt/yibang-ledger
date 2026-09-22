const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const path = require('path');
const fs = require('fs');

// 管理后台登录验证（简单的token机制）
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'yibang-admin-2026';

function auth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ code: 401, msg: '未授权' });
  }
  next();
}

// 获取全局配置
router.get('/config', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT payload, version FROM app_configs WHERE cfg_key = 'global' LIMIT 1"
    );
    if (!rows.length) {
      return res.json({ code: 0, data: { version: 0, config: {} } });
    }
    let config;
    if (typeof rows[0].payload === 'string') {
      config = JSON.parse(rows[0].payload);
    } else if (Buffer.isBuffer(rows[0].payload)) {
      config = JSON.parse(rows[0].payload.toString('utf8'));
    } else {
      config = rows[0].payload;
    }
    res.json({ code: 0, data: { version: Number(rows[0].version) || 0, config } });
  } catch (err) {
    console.error('获取配置失败:', err);
    res.json({ code: 500, msg: '获取配置失败' });
  }
});

// 保存全局配置
router.post('/config', auth, async (req, res) => {
  try {
    const { config } = req.body;
    if (!config || typeof config !== 'object') {
      return res.json({ code: 400, msg: '配置格式错误' });
    }

    // 获取当前版本号
    const [rows] = await pool.query(
      "SELECT version FROM app_configs WHERE cfg_key = 'global' LIMIT 1"
    );
    const currentVersion = rows.length ? Number(rows[0].version) || 0 : 0;
    const newVersion = currentVersion + 1;

    const payload = JSON.stringify(config);

    if (rows.length) {
      await pool.query(
        "UPDATE app_configs SET payload = ?, version = ? WHERE cfg_key = 'global'",
        [payload, newVersion]
      );
    } else {
      await pool.query(
        "INSERT INTO app_configs (cfg_key, payload, version) VALUES ('global', ?, ?)",
        [payload, newVersion]
      );
    }

    res.json({ code: 0, msg: '保存成功', data: { version: newVersion } });
  } catch (err) {
    console.error('保存配置失败:', err);
    res.json({ code: 500, msg: '保存配置失败: ' + err.message });
  }
});

// 获取用户列表
router.get('/users', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const offset = (page - 1) * pageSize;

    const [rows] = await pool.query(
      "SELECT id, openid, nickname, phone, role, boss_id, created_at FROM users ORDER BY id DESC LIMIT ? OFFSET ?",
      [pageSize, offset]
    );
    const [countRows] = await pool.query("SELECT COUNT(*) as total FROM users");

    res.json({
      code: 0,
      data: {
        list: rows,
        total: countRows[0].total,
        page,
        pageSize
      }
    });
  } catch (err) {
    console.error('获取用户列表失败:', err);
    res.json({ code: 500, msg: '获取用户列表失败' });
  }
});

// 获取账目记录列表
router.get('/records', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const offset = (page - 1) * pageSize;

    const [rows] = await pool.query(
      `SELECT r.id, r.user_id, r.type, r.amount, r.title, r.contact, r.note, r.created_at, u.nickname
       FROM transactions r LEFT JOIN users u ON r.user_id = u.id
       ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );
    const [countRows] = await pool.query("SELECT COUNT(*) as total FROM transactions");

    res.json({
      code: 0,
      data: {
        list: rows,
        total: countRows[0].total,
        page,
        pageSize
      }
    });
  } catch (err) {
    console.error('获取账目记录失败:', err);
    res.json({ code: 500, msg: '获取账目记录失败' });
  }
});

// 获取统计数据
router.get('/stats', auth, async (req, res) => {
  try {
    const [userCount] = await pool.query("SELECT COUNT(*) as count FROM users");
    const [recordCount] = await pool.query("SELECT COUNT(*) as count FROM transactions");
    const [todayRecords] = await pool.query(
      "SELECT COUNT(*) as count, COALESCE(SUM(CASE WHEN type=1 THEN amount ELSE 0 END),0) as income, COALESCE(SUM(CASE WHEN type=2 THEN amount ELSE 0 END),0) as expense FROM transactions WHERE DATE(created_at) = CURDATE()"
    );

    res.json({
      code: 0,
      data: {
        totalUsers: userCount[0].count,
        totalRecords: recordCount[0].count,
        todayRecords: todayRecords[0].count,
        todayIncome: todayRecords[0].income,
        todayExpense: todayRecords[0].expense
      }
    });
  } catch (err) {
    console.error('获取统计数据失败:', err);
    res.json({ code: 500, msg: '获取统计数据失败' });
  }
});

module.exports = router;

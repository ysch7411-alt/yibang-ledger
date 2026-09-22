const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const path = require('path');
const fs = require('fs');
const log = require('../lib/log');

/* 管理后台鉴权。
   🔴 2026-09-22 代码审查修复。原来写的是：
        const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'yibang-admin-2026';
   而线上 .env 里**根本没有 ADMIN_TOKEN** —— 于是全平台的门由一个人人可见的默认口令把着。
   实测：用 'yibang-admin-2026' 请求 /api/admin/config → HTTP 200 真的进去了。
   而这个后台能 `GET /records` 读全部商户账目、`GET /users` 读全部用户、
   `POST /config` 改写全局配置（主题/文案/导航标题/功能开关）。

   现在改成 **启动即失败**：漏设环境变量不许"悄悄用一个默认口令继续跑"，必须启动就炸。
   —— 凡是凭证类的 `process.env.X || '写死的值'` 都是同一个坑：
      迁移、换机器、重建 .env 时最容易漏设，而**漏设不报错**，服务照常起来，只是门开着。 */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN || String(ADMIN_TOKEN).length < 16) {
  throw new Error('必须配置 ADMIN_TOKEN（≥16 位随机串）—— 不允许用默认口令或弱口令启动');
}

function auth(req, res, next) {
  // ⚠️ 只认 header，**不认 query**：URL 里的 token 会进 nginx access log、Referer、浏览器历史
  const token = req.headers['x-admin-token'];
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
    log.error('获取配置失败:', err);
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
    log.error('保存配置失败:', err);
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
    log.error('获取用户列表失败:', err);
    res.json({ code: 500, msg: '获取用户列表失败' });
  }
});

// 获取账目记录列表
router.get('/records', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const offset = (page - 1) * pageSize;

      /* 2026-09-22 修复：原来查的是 `r.title, r.contact, r.note` —— **这三列在 transactions 里不存在**，
         报 `ER_BAD_FIELD_ERROR: Unknown column 'r.title'`，后台账目列表一直是坏的。
         （错误日志里反复出现，从 15:20 之前就开始了，一直没人看。）

         修的时候刻意**用别名保留 `title` / `contact` 这两个字段名**：
         后台页面 admin/index.html 渲染的是 `r.title` / `r.contact`，
         直接换字段名会让页面全部显示 "-"（一个 bug 换来另一个 bug）。
         `title` 取自 `content`（事由），`contact` 取自关联的往来对象名。
         同时按全站口径把 record_date 用 DATE_FORMAT 取成字符串（连接池没设 dateStrings，
         直接拿 DATE 会变成 JS Date 对象 → 序列化成 "2026-09-21T16:00:00.000Z" 少一天）。 */
      const [rows] = await pool.query(
        `SELECT r.id, r.user_id, r.type, r.amount, r.category,
                r.content AS title,
                c.name AS contact,
                DATE_FORMAT(r.record_date, '%Y-%m-%d') AS record_date,
                r.created_at, u.nickname
         FROM transactions r
         LEFT JOIN users u ON r.user_id = u.id
         LEFT JOIN contacts c ON r.contact_id = c.id
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
    log.error('获取账目记录失败:', err);
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
    log.error('获取统计数据失败:', err);
    res.json({ code: 500, msg: '获取统计数据失败' });
  }
});

module.exports = router;

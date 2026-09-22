const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const log = require('../lib/log');

/**
 * 获取全局配置（主题/文案/布局/功能开关）
 * 前端启动时拉取，version变化时自动更新界面
 */
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT payload, version FROM app_configs WHERE cfg_key = 'global' LIMIT 1"
    );

    if (!rows.length) {
      return res.json({
        code: 0,
        data: {
          version: 0,
          config: {}
        }
      });
    }

    let config;
    if (typeof rows[0].payload === 'string') {
      config = JSON.parse(rows[0].payload);
    } else if (Buffer.isBuffer(rows[0].payload)) {
      config = JSON.parse(rows[0].payload.toString('utf8'));
    } else {
      config = rows[0].payload;
    }

    res.json({
      code: 0,
      data: {
        version: Number(rows[0].version) || 0,
        config
      }
    });
  } catch (err) {
    log.error('获取配置失败:', err);
    res.json({ code: 500, msg: '获取配置失败' });
  }
});

module.exports = router;

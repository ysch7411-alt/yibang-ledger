const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const opLog = require('../lib/operation-log');
const notify = require('../lib/notification');
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
 * 获取店铺店主id
 */
async function getShopOwnerId(userId) {
  const [users] = await pool.query('SELECT id, role, boss_id FROM users WHERE id = ?', [userId]);
  if (!users.length) return null;
  return users[0].boss_id || users[0].id;
}

/**
 * 初始化reports表（如果不存在）
 */
async function ensureReportsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_owner_id BIGINT NOT NULL COMMENT '店铺店主id',
      month VARCHAR(7) NOT NULL COMMENT '月份，如2026-09',
      status TINYINT DEFAULT 1 COMMENT '1草稿 2已确认(锁定) 3解锁申请中',
      confirmed_by BIGINT NULL COMMENT '确认人id',
      confirmed_at DATETIME NULL COMMENT '确认时间',
      unlock_requested_by BIGINT NULL COMMENT '申请解锁人id',
      unlock_requested_at DATETIME NULL COMMENT '申请解锁时间',
      unlock_reason VARCHAR(500) NULL COMMENT '申请解锁原因',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_shop_month (shop_owner_id, month)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='报表确认表'
  `);
  
  // 兼容旧表：添加新字段（如果不存在）
  try {
    await pool.query('ALTER TABLE reports ADD COLUMN unlock_requested_by BIGINT NULL COMMENT "申请解锁人id" AFTER confirmed_at');
  } catch (e) { /* 字段已存在，忽略 */ }
  try {
    await pool.query('ALTER TABLE reports ADD COLUMN unlock_requested_at DATETIME NULL COMMENT "申请解锁时间" AFTER unlock_requested_by');
  } catch (e) { /* 字段已存在，忽略 */ }
  try {
    await pool.query('ALTER TABLE reports ADD COLUMN unlock_reason VARCHAR(500) NULL COMMENT "申请解锁原因" AFTER unlock_requested_at');
  } catch (e) { /* 字段已存在，忽略 */ }
}

// 获取某月报表状态
router.get('/status', auth, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.json({ code: 400, msg: '缺少月份参数' });

  try {
    await ensureReportsTable();
    const shopOwnerId = await getShopOwnerId(req.userId);
    if (!shopOwnerId) return res.json({ code: 404, msg: '用户不存在' });

    const [reports] = await pool.query(
      'SELECT r.*, u.nickname as confirmer_name FROM reports r LEFT JOIN users u ON r.confirmed_by = u.id WHERE r.shop_owner_id = ? AND r.month = ?',
      [shopOwnerId, month]
    );

    if (reports.length) {
      res.json({ code: 0, data: reports[0] });
    } else {
      res.json({ code: 0, data: { status: 1, month } });
    }
  } catch (err) {
    log.error('获取报表状态失败:', err);
    res.json({ code: 500, msg: '获取报表状态失败' });
  }
});

// 确认报表（经理/店主操作，确认后所有合伙人可见）
router.post('/confirm', auth, async (req, res) => {
  const { month } = req.body || {};
  if (!month) return res.json({ code: 400, msg: '缺少月份参数' });

  try {
    await ensureReportsTable();

    // 检查权限：只有店主(role=1)和经理(role=3)能确认报表
    const [users] = await pool.query('SELECT id, role, boss_id FROM users WHERE id = ?', [req.userId]);
    if (!users.length) return res.json({ code: 404, msg: '用户不存在' });
    if (![1, 3].includes(users[0].role)) {
      return res.json({ code: 403, msg: '只有店主和经理才能确认报表' });
    }

    const shopOwnerId = users[0].boss_id || users[0].id;

    // 插入或更新报表状态
    await pool.query(
      `INSERT INTO reports (shop_owner_id, month, status, confirmed_by, confirmed_at)
       VALUES (?, ?, 2, ?, NOW())
       ON DUPLICATE KEY UPDATE status = 2, confirmed_by = ?, confirmed_at = NOW()`,
      [shopOwnerId, month, req.userId, req.userId]
    );

    // 记录操作日志
    const [opUser] = await pool.query('SELECT nickname FROM users WHERE id = ?', [req.userId]);
    await opLog.log({
      shopOwnerId,
      operatorId: req.userId,
      operatorName: opUser[0]?.nickname,
      action: opLog.ACTIONS.CONFIRM_REPORT,
      content: { month }
    });

    // 发送通知给所有合伙人
    const notifTitle = month + ' 报表已确认';
    const notifContent = (opUser[0]?.nickname || '经理') + '已确认' + month + '的报表，现在可以查看了。';
    await notify.sendToBosses(
      shopOwnerId,
      notify.TYPES.REPORT_CONFIRMED,
      notifTitle,
      notifContent,
      { month, confirmed_by: req.userId, confirmed_by_name: opUser[0]?.nickname }
    );

    res.json({ code: 0, msg: '报表已确认，所有合伙人均可查看' });
  } catch (err) {
    log.error('确认报表失败:', err);
    res.json({ code: 500, msg: '确认报表失败' });
  }
});

// 取消确认（只有店主能取消）
router.post('/unconfirm', auth, async (req, res) => {
  const { month } = req.body || {};
  if (!month) return res.json({ code: 400, msg: '缺少月份参数' });

  try {
    await ensureReportsTable();

    // 只有店主能取消确认
    const [users] = await pool.query('SELECT id, role, boss_id FROM users WHERE id = ?', [req.userId]);
    if (!users.length || users[0].role !== 1) {
      return res.json({ code: 403, msg: '只有店主才能取消确认' });
    }

    const shopOwnerId = users[0].id;

    await pool.query(
      'UPDATE reports SET status = 1, confirmed_by = NULL, confirmed_at = NULL WHERE shop_owner_id = ? AND month = ?',
      [shopOwnerId, month]
    );

    // 记录操作日志
    const [opUser] = await pool.query('SELECT nickname FROM users WHERE id = ?', [req.userId]);
    await opLog.log({
      shopOwnerId,
      operatorId: req.userId,
      operatorName: opUser[0]?.nickname,
      action: opLog.ACTIONS.UNCONFIRM_REPORT,
      content: { month }
    });

    res.json({ code: 0, msg: '已取消确认，报表恢复为草稿状态' });
  } catch (err) {
    log.error('取消确认失败:', err);
    res.json({ code: 500, msg: '取消确认失败' });
  }
});

// 获取已确认的报表列表（合伙人端用来显示"新报表"提醒）
router.get('/confirmed-list', auth, async (req, res) => {
  try {
    await ensureReportsTable();
    const shopOwnerId = await getShopOwnerId(req.userId);
    if (!shopOwnerId) return res.json({ code: 404, msg: '用户不存在' });

    const [reports] = await pool.query(
      `SELECT r.*, u.nickname as confirmer_name 
       FROM reports r 
       LEFT JOIN users u ON r.confirmed_by = u.id 
       WHERE r.shop_owner_id = ? AND r.status = 2 
       ORDER BY r.month DESC 
       LIMIT 12`,
      [shopOwnerId]
    );

    res.json({ code: 0, data: reports });
  } catch (err) {
    log.error('获取已确认报表列表失败:', err);
    res.json({ code: 500, msg: '获取已确认报表列表失败' });
  }
});

// 申请解锁报表（经理操作，已确认报表需申请才能修改）
router.post('/request-unlock', auth, async (req, res) => {
  const { month, reason } = req.body || {};
  if (!month) return res.json({ code: 400, msg: '缺少月份参数' });

  try {
    await ensureReportsTable();

    // 检查权限：只有经理(role=3)能申请解锁
    const [users] = await pool.query('SELECT id, role, boss_id, nickname FROM users WHERE id = ?', [req.userId]);
    if (!users.length) return res.json({ code: 404, msg: '用户不存在' });
    if (users[0].role !== 3) {
      return res.json({ code: 403, msg: '只有经理才能申请解锁报表' });
    }

    const shopOwnerId = users[0].boss_id || users[0].id;

    // 检查报表状态：必须是已确认(2)才能申请解锁
    const [reports] = await pool.query(
      'SELECT * FROM reports WHERE shop_owner_id = ? AND month = ?',
      [shopOwnerId, month]
    );

    if (!reports.length || reports[0].status !== 2) {
      return res.json({ code: 400, msg: '该报表未确认，无需申请解锁' });
    }

    // 更新状态为解锁申请中
    await pool.query(
      'UPDATE reports SET status = 3, unlock_requested_by = ?, unlock_requested_at = NOW(), unlock_reason = ? WHERE shop_owner_id = ? AND month = ?',
      [req.userId, reason || null, shopOwnerId, month]
    );

    // 记录操作日志
    await opLog.log({
      shopOwnerId,
      operatorId: req.userId,
      operatorName: users[0].nickname,
      action: opLog.ACTIONS.REQUEST_UNLOCK,
      content: { month, reason }
    });

    // 发送通知给店主
    await notify.send(
      shopOwnerId,
      notify.TYPES.UNLOCK_REQUESTED,
      month + ' 报表解锁申请',
      (users[0].nickname || '经理') + '申请解锁' + month + '的报表' + (reason ? '，原因：' + reason : '') + '，请审批。',
      { month, requested_by: req.userId, requested_by_name: users[0].nickname, reason }
    );

    res.json({ code: 0, msg: '解锁申请已提交，等待店主审批' });
  } catch (err) {
    log.error('申请解锁失败:', err);
    res.json({ code: 500, msg: '申请解锁失败' });
  }
});

// 批准解锁（店主操作）
router.post('/approve-unlock', auth, async (req, res) => {
  const { month } = req.body || {};
  if (!month) return res.json({ code: 400, msg: '缺少月份参数' });

  try {
    await ensureReportsTable();

    // 只有店主能批准
    const [users] = await pool.query('SELECT id, role, nickname FROM users WHERE id = ?', [req.userId]);
    if (!users.length || users[0].role !== 1) {
      return res.json({ code: 403, msg: '只有店主才能批准解锁' });
    }

    const shopOwnerId = users[0].id;

    // 检查状态：必须是解锁申请中(3)
    const [reports] = await pool.query(
      'SELECT * FROM reports WHERE shop_owner_id = ? AND month = ?',
      [shopOwnerId, month]
    );

    if (!reports.length || reports[0].status !== 3) {
      return res.json({ code: 400, msg: '该报表没有待审批的解锁申请' });
    }

    // 批准：状态改为草稿(1)，清除确认信息
    await pool.query(
      'UPDATE reports SET status = 1, confirmed_by = NULL, confirmed_at = NULL, unlock_requested_by = NULL, unlock_requested_at = NULL, unlock_reason = NULL WHERE shop_owner_id = ? AND month = ?',
      [shopOwnerId, month]
    );

    // 记录操作日志
    await opLog.log({
      shopOwnerId,
      operatorId: req.userId,
      operatorName: users[0].nickname,
      action: opLog.ACTIONS.APPROVE_UNLOCK,
      content: { month }
    });

    // 发送通知给申请人
    if (reports[0].unlock_requested_by) {
      await notify.send(
        reports[0].unlock_requested_by,
        notify.TYPES.UNLOCK_APPROVED,
        month + ' 报表解锁已批准',
        '店主已批准解锁' + month + '的报表，现在可以修改了。修改完成后请重新确认报表。',
        { month }
      );
    }

    res.json({ code: 0, msg: '已批准解锁，报表恢复为草稿状态' });
  } catch (err) {
    log.error('批准解锁失败:', err);
    res.json({ code: 500, msg: '批准解锁失败' });
  }
});

// 拒绝解锁（店主操作）
router.post('/reject-unlock', auth, async (req, res) => {
  const { month, reason } = req.body || {};
  if (!month) return res.json({ code: 400, msg: '缺少月份参数' });

  try {
    await ensureReportsTable();

    // 只有店主能拒绝
    const [users] = await pool.query('SELECT id, role, nickname FROM users WHERE id = ?', [req.userId]);
    if (!users.length || users[0].role !== 1) {
      return res.json({ code: 403, msg: '只有店主才能拒绝解锁' });
    }

    const shopOwnerId = users[0].id;

    // 检查状态
    const [reports] = await pool.query(
      'SELECT * FROM reports WHERE shop_owner_id = ? AND month = ?',
      [shopOwnerId, month]
    );

    if (!reports.length || reports[0].status !== 3) {
      return res.json({ code: 400, msg: '该报表没有待审批的解锁申请' });
    }

    // 拒绝：状态恢复为已确认(2)
    await pool.query(
      'UPDATE reports SET status = 2, unlock_requested_by = NULL, unlock_requested_at = NULL, unlock_reason = NULL WHERE shop_owner_id = ? AND month = ?',
      [shopOwnerId, month]
    );

    // 记录操作日志
    await opLog.log({
      shopOwnerId,
      operatorId: req.userId,
      operatorName: users[0].nickname,
      action: opLog.ACTIONS.REJECT_UNLOCK,
      content: { month, reason }
    });

    // 发送通知给申请人
    if (reports[0].unlock_requested_by) {
      await notify.send(
        reports[0].unlock_requested_by,
        notify.TYPES.UNLOCK_REJECTED,
        month + ' 报表解锁申请被拒绝',
        '店主拒绝了' + month + '报表的解锁申请' + (reason ? '，原因：' + reason : '') + '。',
        { month, reason }
      );
    }

    res.json({ code: 0, msg: '已拒绝解锁申请，报表保持锁定状态' });
  } catch (err) {
    log.error('拒绝解锁失败:', err);
    res.json({ code: 500, msg: '拒绝解锁失败' });
  }
});

// 获取解锁申请列表（店主端）
router.get('/unlock-requests', auth, async (req, res) => {
  try {
    await ensureReportsTable();

    const [users] = await pool.query('SELECT id, role FROM users WHERE id = ?', [req.userId]);
    if (!users.length || users[0].role !== 1) {
      return res.json({ code: 403, msg: '只有店主能查看解锁申请' });
    }

    const [requests] = await pool.query(
      `SELECT r.*, u.nickname as requester_name 
       FROM reports r 
       LEFT JOIN users u ON r.unlock_requested_by = u.id 
       WHERE r.shop_owner_id = ? AND r.status = 3 
       ORDER BY r.unlock_requested_at DESC`,
      [req.userId]
    );

    res.json({ code: 0, data: requests });
  } catch (err) {
    log.error('获取解锁申请列表失败:', err);
    res.json({ code: 500, msg: '获取失败' });
  }
});

module.exports = router;

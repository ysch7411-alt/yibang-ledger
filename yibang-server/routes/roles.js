const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const opLog = require('../lib/operation-log');
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

// 角色名称映射
const ROLE_NAMES = {
  1: '店主',
  2: '合伙人',
  3: '经理',
  4: '员工'
};

/**
 * 获取当前用户的店铺信息（店主id）
 * 如果是店主，返回自己的id；如果是员工，返回boss_id
 */
async function getShopOwnerId(userId) {
  const [users] = await pool.query('SELECT id, role, boss_id FROM users WHERE id = ?', [userId]);
  if (!users.length) return null;
  const user = users[0];
  // 店主的boss_id是NULL，返回自己的id
  return user.boss_id || user.id;
}

// 成员列表（店主/经理可见）
router.get('/members', auth, async (req, res) => {
  try {
    const shopOwnerId = await getShopOwnerId(req.userId);
    if (!shopOwnerId) return res.json({ code: 404, msg: '用户不存在' });

    // 查询店主自己 + 所有boss_id=店主id的成员
    const [rows] = await pool.query(
      `SELECT id, nickname, shop_name, phone, role, created_at 
       FROM users 
       WHERE id = ? OR boss_id = ? 
       ORDER BY role ASC, created_at ASC`,
      [shopOwnerId, shopOwnerId]
    );

    // 加上角色名称
    const members = rows.map(u => ({
      ...u,
      role_name: ROLE_NAMES[u.role] || '未知'
    }));

    res.json({ code: 0, data: members });
  } catch (err) {
    log.error('获取成员列表失败:', err);
    res.json({ code: 500, msg: '获取成员列表失败' });
  }
});

// 添加合伙人/经理/员工（通过手机号查找用户并设置角色）
router.post('/add', auth, async (req, res) => {
  const { phone, role } = req.body || {};

  // 只有店主才能添加成员
  const [currentUser] = await pool.query('SELECT role, boss_id FROM users WHERE id = ?', [req.userId]);
  if (!currentUser.length) return res.json({ code: 404, msg: '用户不存在' });
  if (currentUser[0].role !== 1) {
    return res.json({ code: 403, msg: '只有店主才能添加成员' });
  }

  if (!phone) return res.json({ code: 400, msg: '请输入手机号' });
  if (![2, 3, 4].includes(Number(role))) {
    return res.json({ code: 400, msg: '角色只能是 2（合伙人）、3（经理）、4（员工）' });
  }

  try {
    // 查找用户
    const [users] = await pool.query('SELECT id, nickname, boss_id FROM users WHERE phone = ?', [phone]);
    if (!users.length) {
      return res.json({ code: 404, msg: '该手机号还没有注册易帮账本，请先让对方注册' });
    }

    const targetUser = users[0];

    // 不能添加自己
    if (targetUser.id === req.userId) {
      return res.json({ code: 400, msg: '不能添加自己' });
    }

    // 已经是其他店铺的成员
    if (targetUser.boss_id && targetUser.boss_id !== req.userId) {
      return res.json({ code: 400, msg: '该用户已是其他店铺的成员，请先让对方退出' });
    }

    // 设置角色和boss_id
    await pool.query(
      'UPDATE users SET role = ?, boss_id = ? WHERE id = ?',
      [Number(role), req.userId, targetUser.id]
    );

    res.json({ 
      code: 0, 
      msg: `已添加为${ROLE_NAMES[role]}`,
      data: { id: targetUser.id, nickname: targetUser.nickname, role: Number(role), role_name: ROLE_NAMES[role] }
    });
  } catch (err) {
    log.error('添加成员失败:', err);
    res.json({ code: 500, msg: '添加成员失败' });
  }
});

// 修改成员角色
router.post('/change-role', auth, async (req, res) => {
  const { user_id, role } = req.body || {};

  // 只有店主才能修改角色
  const [currentUser] = await pool.query('SELECT role FROM users WHERE id = ?', [req.userId]);
  if (!currentUser.length || currentUser[0].role !== 1) {
    return res.json({ code: 403, msg: '只有店主才能修改角色' });
  }

  if (!user_id) return res.json({ code: 400, msg: '缺少用户id' });
  if (![2, 3, 4].includes(Number(role))) {
    return res.json({ code: 400, msg: '角色只能是 2（合伙人）、3（经理）、4（员工）' });
  }

  try {
    // 确认是本店成员
    const [target] = await pool.query('SELECT id, boss_id FROM users WHERE id = ?', [user_id]);
    if (!target.length) return res.json({ code: 404, msg: '用户不存在' });
    if (target[0].boss_id !== req.userId) {
      return res.json({ code: 403, msg: '只能修改本店成员' });
    }

    await pool.query('UPDATE users SET role = ? WHERE id = ?', [Number(role), user_id]);
    res.json({ code: 0, msg: `已修改为${ROLE_NAMES[role]}` });
  } catch (err) {
    log.error('修改角色失败:', err);
    res.json({ code: 500, msg: '修改角色失败' });
  }
});

// 移除成员
router.post('/remove', auth, async (req, res) => {
  const { user_id } = req.body || {};

  // 只有店主才能移除成员
  const [currentUser] = await pool.query('SELECT role FROM users WHERE id = ?', [req.userId]);
  if (!currentUser.length || currentUser[0].role !== 1) {
    return res.json({ code: 403, msg: '只有店主才能移除成员' });
  }

  if (!user_id) return res.json({ code: 400, msg: '缺少用户id' });

  try {
    // 确认是本店成员
    const [target] = await pool.query('SELECT id, boss_id FROM users WHERE id = ?', [user_id]);
    if (!target.length) return res.json({ code: 404, msg: '用户不存在' });
    if (target[0].boss_id !== req.userId) {
      return res.json({ code: 403, msg: '只能移除本店成员' });
    }

    // 清除boss_id，角色恢复为店主（独立用户）
    const [targetUser] = await pool.query('SELECT nickname FROM users WHERE id = ?', [user_id]);
    await pool.query('UPDATE users SET boss_id = NULL, role = 1 WHERE id = ?', [user_id]);

    // 记录操作日志
    const [opUser] = await pool.query('SELECT nickname FROM users WHERE id = ?', [req.userId]);
    await opLog.log({
      shopOwnerId: req.userId,
      operatorId: req.userId,
      operatorName: opUser[0]?.nickname,
      action: opLog.ACTIONS.REMOVE_MEMBER,
      content: { target_id: user_id, target_name: targetUser[0]?.nickname }
    });

    res.json({ code: 0, msg: '已移除' });
  } catch (err) {
    log.error('移除成员失败:', err);
    res.json({ code: 500, msg: '移除成员失败' });
  }
});

// 获取当前用户角色信息
router.get('/my-role', auth, async (req, res) => {
  try {
    const [users] = await pool.query(
      'SELECT id, nickname, role, boss_id, shop_name FROM users WHERE id = ?',
      [req.userId]
    );
    if (!users.length) return res.json({ code: 404, msg: '用户不存在' });

    const user = users[0];
    const shopOwnerId = user.boss_id || user.id;

    // 获取店主信息
    const [owners] = await pool.query(
      'SELECT id, nickname, shop_name FROM users WHERE id = ?',
      [shopOwnerId]
    );

    res.json({
      code: 0,
      data: {
        ...user,
        role_name: ROLE_NAMES[user.role] || '未知',
        shop_owner: owners[0] || null,
        // 权限判断
        can_manage_members: user.role === 1, // 只有店主能管理成员
        can_approve: user.role === 1 || user.role === 3, // 店主和经理能审核
        can_confirm_report: user.role === 1 || user.role === 3, // 店主和经理能确认报表
        can_view_all: user.role === 1 || user.role === 2, // 店主和合伙人能看所有数据
        can_export: user.role === 1 || user.role === 2 || user.role === 3 // 店主、合伙人、经理能导出
      }
    });
  } catch (err) {
    log.error('获取角色信息失败:', err);
    res.json({ code: 500, msg: '获取角色信息失败' });
  }
});

// 获取操作日志列表
router.get('/logs', auth, async (req, res) => {
  try {
    const shopOwnerId = await getShopOwnerId(req.userId);
    if (!shopOwnerId) return res.json({ code: 404, msg: '用户不存在' });

    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const logs = await opLog.getList(shopOwnerId, limit, offset);
    res.json({ code: 0, data: logs });
  } catch (err) {
    log.error('获取操作日志失败:', err);
    res.json({ code: 500, msg: '获取操作日志失败' });
  }
});

module.exports = router;

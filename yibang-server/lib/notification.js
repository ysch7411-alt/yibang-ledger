const pool = require('../db/config');
const log = require('./log');

/**
 * 通知类型常量
 */
const TYPES = {
  REPORT_CONFIRMED: 'report_confirmed',
  MEMBER_ADDED: 'member_added',
  ROLE_CHANGED: 'role_changed',
  MEMBER_REMOVED: 'member_removed',
  UNLOCK_REQUESTED: 'unlock_requested',
  UNLOCK_APPROVED: 'unlock_approved',
  UNLOCK_REJECTED: 'unlock_rejected'
};

/**
 * 通知类型中文名称映射
 */
const TYPE_NAMES = {
  report_confirmed: '报表已确认',
  member_added: '成员添加',
  role_changed: '角色变更',
  member_removed: '成员移除',
  unlock_requested: '解锁申请',
  unlock_approved: '解锁批准',
  unlock_rejected: '解锁拒绝'
};

/**
 * 初始化通知表
 */
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL COMMENT '接收用户id',
      type VARCHAR(50) NOT NULL COMMENT '通知类型',
      title VARCHAR(200) NOT NULL COMMENT '通知标题',
      content TEXT NULL COMMENT '通知内容',
      data TEXT NULL COMMENT '附加数据（JSON）',
      is_read TINYINT DEFAULT 0 COMMENT '是否已读 0未读 1已读',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id),
      INDEX idx_read (user_id, is_read),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='通知消息表'
  `);
}

/**
 * 发送通知给单个用户
 */
async function send(userId, type, title, content, data) {
  try {
    await ensureTable();
    const dataStr = data ? JSON.stringify(data) : null;
    await pool.query(
      'INSERT INTO notifications (user_id, type, title, content, data) VALUES (?, ?, ?, ?, ?)',
      [userId, type, title, content || null, dataStr]
    );
    return true;
  } catch (err) {
    log.error('发送通知失败:', err);
    return false;
  }
}

/**
 * 批量发送通知给多个用户
 */
async function sendBatch(userIds, type, title, content, data) {
  if (!userIds || !userIds.length) return 0;
  let count = 0;
  for (const userId of userIds) {
    const ok = await send(userId, type, title, content, data);
    if (ok) count++;
  }
  return count;
}

/**
 * 发送通知给某个店铺的所有老板
 */
async function sendToBosses(shopOwnerId, type, title, content, data) {
  // 店主自己也是老板，加上所有role=2的成员
  const [bosses] = await pool.query(
    'SELECT id FROM users WHERE id = ? OR (boss_id = ? AND role = 2)',
    [shopOwnerId, shopOwnerId]
  );
  const bossIds = bosses.map(b => b.id);
  return await sendBatch(bossIds, type, title, content, data);
}

/**
 * 获取用户的通知列表
 */
async function getList(userId, limit = 50, offset = 0) {
  await ensureTable();
  const [rows] = await pool.query(
    /* created_at 必须用 DATE_FORMAT 取**字符串**（项目约定）。
       原来这里是 SELECT *，mysql2 会把 DATETIME 转成 JS Date，JSON 序列化后是
       UTC 的 ISO 串 "2026-09-21T12:14:00.000Z"；小程序端一旦做
       `new Date(s.replace(/-/g,'/'))`（为兼容 iOS 解析空格写法而写）就会得到
       Invalid Date —— 界面上真的显示过「NaN月NaN日」。
       服务端给字符串，前端哪种写法都能解析，从源头把坑填掉。
       同时不再用 SELECT *：列清单显式写，加字段时才知道要同步（老坑：
       purchase 的 source_file_ids 就是加了 INSERT 忘了 SELECT，写进去读出来是 undefined）。
       排序末尾补 id DESC —— created_at 只到秒，同秒并列时 MySQL 不保证顺序，
       表现是"刚收到的通知没排最前"，也是分页正确的前提。 */
    `SELECT id, user_id, type, title, content, data, is_read,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
     FROM notifications
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
  return rows.map(row => ({
    ...row,
    type_name: TYPE_NAMES[row.type] || row.type,
    data_parsed: parseData(row.data)
  }));
}

/**
 * 获取未读通知数量
 */
async function getUnreadCount(userId) {
  await ensureTable();
  const [rows] = await pool.query(
    'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0',
    [userId]
  );
  return rows[0]?.count || 0;
}

/**
 * 标记通知为已读
 */
async function markAsRead(userId, notificationId) {
  await ensureTable();
  const [r] = await pool.query(
    'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
    [notificationId, userId]
  );
  return r.affectedRows > 0;
}

/**
 * 标记所有通知为已读
 */
async function markAllAsRead(userId) {
  await ensureTable();
  const [r] = await pool.query(
    'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
    [userId]
  );
  return r.affectedRows;
}

/**
 * 解析附加数据
 */
function parseData(data) {
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch (e) {
    return data;
  }
}

module.exports = {
  TYPES,
  TYPE_NAMES,
  send,
  sendBatch,
  sendToBosses,
  getList,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  ensureTable
};

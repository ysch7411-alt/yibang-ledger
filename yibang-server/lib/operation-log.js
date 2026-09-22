const pool = require('../db/config');

/**
 * 操作类型常量
 */
const ACTIONS = {
  CONFIRM_REPORT: 'confirm_report',
  UNCONFIRM_REPORT: 'unconfirm_report',
  ADD_MEMBER: 'add_member',
  REMOVE_MEMBER: 'remove_member',
  CHANGE_ROLE: 'change_role',
  REQUEST_UNLOCK: 'request_unlock',
  APPROVE_UNLOCK: 'approve_unlock',
  REJECT_UNLOCK: 'reject_unlock'
};

/**
 * 操作类型中文名称映射
 */
const ACTION_NAMES = {
  confirm_report: '确认报表',
  unconfirm_report: '取消确认报表',
  add_member: '添加成员',
  remove_member: '移除成员',
  change_role: '修改角色',
  request_unlock: '申请解锁报表',
  approve_unlock: '批准解锁报表',
  reject_unlock: '拒绝解锁报表'
};

/**
 * 初始化操作日志表
 */
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      shop_owner_id BIGINT NOT NULL COMMENT '店铺店主id',
      operator_id BIGINT NOT NULL COMMENT '操作人id',
      operator_name VARCHAR(100) NULL COMMENT '操作人名称',
      action VARCHAR(50) NOT NULL COMMENT '操作类型',
      content TEXT NULL COMMENT '操作内容（JSON）',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_shop (shop_owner_id),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='操作日志表'
  `);
}

/**
 * 记录操作日志
 * @param {Object} params
 * @param {number} params.shopOwnerId - 店铺店主id
 * @param {number} params.operatorId - 操作人id
 * @param {string} params.operatorName - 操作人名称
 * @param {string} params.action - 操作类型
 * @param {Object|string} params.content - 操作内容
 */
async function log(params) {
  try {
    await ensureTable();
    const { shopOwnerId, operatorId, operatorName, action, content } = params;
    
    const contentStr = typeof content === 'object' ? JSON.stringify(content) : (content || '');
    
    await pool.query(
      'INSERT INTO operation_logs (shop_owner_id, operator_id, operator_name, action, content) VALUES (?, ?, ?, ?, ?)',
      [shopOwnerId, operatorId, operatorName || null, action, contentStr]
    );
  } catch (err) {
    console.error('记录操作日志失败:', err);
    // 日志记录失败不影响主流程
  }
}

/**
 * 获取操作日志列表
 * @param {number} shopOwnerId - 店铺店主id
 * @param {number} limit - 条数限制
 * @param {number} offset - 偏移量
 */
async function getList(shopOwnerId, limit = 50, offset = 0) {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT * FROM operation_logs 
     WHERE shop_owner_id = ? 
     ORDER BY created_at DESC 
     LIMIT ? OFFSET ?`,
    [shopOwnerId, limit, offset]
  );
  
  // 加上操作类型中文名称
  return rows.map(row => ({
    ...row,
    action_name: ACTION_NAMES[row.action] || row.action,
    content_parsed: parseContent(row.content)
  }));
}

/**
 * 解析操作内容
 */
function parseContent(content) {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch (e) {
    return content;
  }
}

module.exports = {
  ACTIONS,
  ACTION_NAMES,
  log,
  getList,
  ensureTable
};

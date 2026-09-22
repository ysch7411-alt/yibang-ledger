const pool = require('./config');

/**
 * 幂等加列。
 * `CREATE TABLE IF NOT EXISTS` 对**已存在**的表什么都不做，所以给老表补字段必须单独迁移，
 * 否则线上表结构会停在旧版本，接口一上线就报 Unknown column。
 */
async function ensureColumn(table, column, definition) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS c FROM information_schema.COLUMNS ' +
    'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  if (Number(rows[0].c) === 0) {
    await pool.query('ALTER TABLE `' + table + '` ADD COLUMN ' + definition);
    console.log('  · 迁移：' + table + ' 增加字段 ' + column);
  }
}

async function initTables() {
  const sqlList = [
    `CREATE TABLE IF NOT EXISTS users (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      openid VARCHAR(64) UNIQUE NOT NULL,
      phone VARCHAR(20) NULL COMMENT '注册手机号，微信手机号快速验证组件拿到',
      phone_bound_at DATETIME NULL COMMENT '绑定手机号的时间',
      nickname VARCHAR(100),
      shop_name VARCHAR(100),
      role TINYINT DEFAULT 1 COMMENT '1老板 2店员',
      boss_id BIGINT NULL,
      plan_type TINYINT DEFAULT 0,
      storage_used BIGINT DEFAULT 0,
      storage_limit BIGINT DEFAULT 5368709120,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_users_phone (phone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS contacts (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      name VARCHAR(100) NOT NULL,
      type TINYINT COMMENT '1客户 2供应商 3两者',
      phone VARCHAR(20),
      remark TEXT,
      balance DECIMAL(12,2) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_contacts_user (user_id),
      INDEX idx_contacts_user_balance (user_id, balance)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS transactions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      contact_id BIGINT NULL,
      type TINYINT COMMENT '1收入 2支出 3应收 4应付 5回款 6付款',
      amount DECIMAL(12,2),
      content VARCHAR(255),
      record_date DATE,
      status TINYINT DEFAULT 1 COMMENT '0待审核 1已入账 2驳回',
      created_by BIGINT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tx_user_date (user_id, record_date),
      INDEX idx_tx_user_contact (user_id, contact_id),
      INDEX idx_tx_user_status (user_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS files (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      transaction_id BIGINT NULL,
      file_url VARCHAR(500),
      file_type VARCHAR(20),
      file_size BIGINT,
      ocr_result TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_files_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS shares (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      token VARCHAR(64) UNIQUE NOT NULL,
      user_id BIGINT NOT NULL,
      type TINYINT COMMENT '1每日汇总 2客户对账',
      contact_id BIGINT NULL,
      data_date DATE NULL,
      expire_at DATETIME,
      is_valid TINYINT DEFAULT 1,
      view_count INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    // 推广邀请关系：一个被邀请人只绑一个邀请人
    `CREATE TABLE IF NOT EXISTS promotions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      inviter_id BIGINT NOT NULL,
      invitee_id BIGINT NOT NULL,
      status TINYINT DEFAULT 0 COMMENT '0待购买 1已购买',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_invitee (invitee_id),
      INDEX idx_inviter (inviter_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    // 商家词表：老板怎么称呼客户/怎么描述事由 → 归一到标准说法
    // 「越用越懂商家」的主要载体。source='user' 来自老板纠正，优先级高于自动积累。
    `CREATE TABLE IF NOT EXISTS merchant_terms (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      kind VARCHAR(16) NOT NULL COMMENT 'contact=往来对象 reason=事由',
      alias VARCHAR(64) NOT NULL COMMENT '老板口中的说法',
      canonical VARCHAR(64) NOT NULL COMMENT '标准说法',
      ref_id BIGINT NULL COMMENT '指向 contacts.id 等',
      hits INT NOT NULL DEFAULT 1 COMMENT '命中次数，越用越准',
      source VARCHAR(16) NOT NULL DEFAULT 'auto' COMMENT 'auto=自动积累 user=老板纠正',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_term (user_id, kind, alias),
      INDEX idx_user_kind (user_id, kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    // 纠正流水：AI 给了什么、老板改成了什么。这是最有价值的一份数据（训练/复盘都靠它）
    `CREATE TABLE IF NOT EXISTS ai_corrections (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      transaction_id BIGINT NULL,
      source_text VARCHAR(500) NOT NULL COMMENT '老板原话',
      ai_result JSON NULL,
      user_result JSON NULL,
      learned VARCHAR(255) NULL COMMENT '本次学到了什么',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    // 采购单（送货单 / 磅单）：一张单据一行
    `CREATE TABLE IF NOT EXISTS purchase_orders (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      supplier_name VARCHAR(100) NULL COMMENT '供应商（AI 识别或手填）',
      contact_id BIGINT NULL,
      order_no VARCHAR(64) NULL COMMENT '单据号',
      order_date DATE NULL,
      total_amount DECIMAL(12,2) DEFAULT 0 COMMENT '合计金额',
      item_count INT DEFAULT 0,
      source_file_id BIGINT NULL COMMENT '来源文件（照片）',
      remark VARCHAR(255) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_po_user_date (user_id, order_date),
      INDEX idx_po_user_supplier (user_id, supplier_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    // 采购单明细：品名 / 规格型号 / 单位 / 数量 / 单价 / 金额
    `CREATE TABLE IF NOT EXISTS purchase_items (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      order_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      seq INT DEFAULT 0 COMMENT '行号',
      item_name VARCHAR(100) NOT NULL COMMENT '品名',
      spec VARCHAR(100) NULL COMMENT '规格型号',
      unit VARCHAR(16) NULL COMMENT '单位（吨/件/米）',
      qty DECIMAL(12,3) NULL COMMENT '数量或重量',
      unit_price DECIMAL(12,4) NULL COMMENT '单价',
      amount DECIMAL(12,2) NULL COMMENT '金额',
      remark VARCHAR(255) NULL,
      INDEX idx_pi_order (order_id),
      INDEX idx_pi_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
  ];

  for (const sql of sqlList) {
    await pool.query(sql);
  }

  // 老表补字段（每次启动都跑，幂等）
  console.log('  · 检查字段迁移…');
  await ensureColumn('users', 'phone', "phone VARCHAR(20) NULL COMMENT '注册手机号，微信手机号快速验证组件拿到' AFTER openid");
  await ensureColumn('users', 'phone_bound_at', "phone_bound_at DATETIME NULL COMMENT '绑定手机号的时间' AFTER phone");
  // 多张单据汇总时，一张采购单会有多张来源照片，逗号分隔存下来供回溯
  await ensureColumn('purchase_orders', 'source_file_ids', "source_file_ids VARCHAR(500) NULL COMMENT '来源照片 id，逗号分隔（多张汇总时用）' AFTER source_file_id");
  // 行级维度：合并成一张记录之后，明细行仍要保留「来自哪个供应商 / 什么品类 / 哪张照片」，
  // 否则三张不同供应商的单子合并后就没法按供应商统计了。
  await ensureColumn('purchase_items', 'supplier_name', "supplier_name VARCHAR(100) NULL COMMENT '该行来自哪个供应商（多张汇总时各行可能不同）' AFTER item_name");
  await ensureColumn('purchase_items', 'category', "category VARCHAR(32) NULL COMMENT '品类，用于分类统计' AFTER spec");
  await ensureColumn('purchase_items', 'source_file_id', "source_file_id BIGINT NULL COMMENT '该行来自哪张照片' AFTER amount");

  // 一次性回填：新加的字段对**历史数据**是空的，不回填的话「按供应商统计」里
  // 老采购单会全都掉进「未分类」。只在字段为空时补，幂等，重复跑无副作用。
  try {
    const [r1] = await pool.query(
      "UPDATE purchase_items i JOIN purchase_orders o ON o.id = i.order_id " +
      "SET i.supplier_name = o.supplier_name " +
      "WHERE i.supplier_name IS NULL AND o.supplier_name IS NOT NULL AND o.supplier_name <> ''"
    );
    if (r1.affectedRows) console.log('  · 回填明细行供应商：' + r1.affectedRows + ' 行');

    // 老单据都是一张照片对一张采购单，所以表头的 source_file_id 就是行级的
    const [r2] = await pool.query(
      "UPDATE purchase_items i JOIN purchase_orders o ON o.id = i.order_id " +
      "SET i.source_file_id = o.source_file_id " +
      "WHERE i.source_file_id IS NULL AND o.source_file_id IS NOT NULL"
    );
    if (r2.affectedRows) console.log('  · 回填明细行来源照片：' + r2.affectedRows + ' 行');
  } catch (e) {
    console.log('  · 历史数据回填跳过：' + e.message);
  }

  console.log('✅ 数据表初始化完成');
  process.exit(0);
}

initTables().catch((err) => {
  console.error('❌ 初始化失败:', err);
  process.exit(1);
});

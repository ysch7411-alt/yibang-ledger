/**
 * 订阅消息下发（真推送）
 *
 * 为什么单独一层：微信订阅消息有一堆「不做就失败」的细节，
 * 散在定时脚本里迟早写漏。集中在这里，一处写对。
 *
 * 🔴 三条微信规则，绕不开：
 *  ① **一次性订阅**：用户授权一次 = 只能下发一条。所以必须记「还剩几次」（本文件的额度表）；
 *     额度用完就**不许再发**，硬发会返回 43101（用户拒收）并可能影响账号权重。
 *  ② **模板字段有长度上限**，超一个字符就整体发送失败（47003）：
 *     thing ≤ 20 字 / phrase ≤ 5 字 / time 要 `yyyy-MM-dd HH:mm`。
 *     字段名自带类型前缀（thing1 / time2 / phrase3 / amount4 / number5 / character_string6），
 *     所以这里按前缀截断 —— 这是**必做**，不是优化。
 *  ③ **不能滥发**。所以推送只在"确实有事"时才发（由 lib/skills/nudge-daily.js 判断），
 *     而不是每天固定发一条"你好"。这样既对老板友好，也省额度。
 *
 * 发不出去时**如实回报**，不假装成功（项目铁律）。
 */
const pool = require('../db/config');
const { callWx } = require('./wxtoken');
const log = require('./log');

/** 字段类型 → 截断规则。键名第一个 `_` 前的部分就是类型前缀 */
const LIMIT = {
  thing: 20,             // 中文按字算，微信自己也是这么数的
  phrase: 5,
  character_string: 32,
  number: 32,
  amount: 32,
  time: 32,
  date: 32,
  name: 10,
  phone_number: 32
};

function fieldType(key) {
  const m = /^([a-z_]+?)\d+$/.exec(key);
  return m ? m[1] : '';
}

/** 按微信的规则把一个值裁到合法长度。**必做** —— 超一个字符就是 47003 整体失败 */
function clip(key, value) {
  const t = fieldType(key);
  let v = value == null ? '' : String(value).replace(/\\n/g, ' ');
  if (t === 'time' || t === 'date') {
    // 微信要 yyyy-MM-dd HH:mm；只给日期时补 00:00，否则报格式错
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v = v + ' 00:00';
  }
  const max = LIMIT[t];
  if (max && v.length > max) v = v.slice(0, max - 1) + '…';
  return v;
}

/* ═══════════ 额度表 ═══════════
   一次性订阅：授权一次 = 能发一条。所以必须落库记账，
   而且**进程重启不能丢**（丢了会硬发 → 43101）。 */
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_quota (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      tmpl_id VARCHAR(128) NOT NULL,
      remain INT NOT NULL DEFAULT 0 COMMENT '还剩几次下发额度',
      granted_at DATETIME NULL COMMENT '最近一次授权时间',
      sent_at DATETIME NULL COMMENT '最近一次下发时间',
      UNIQUE KEY uk_user_tmpl (user_id, tmpl_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订阅消息额度'
  `);
}

/** 用户授权成功后调用。n 是这次拿到的额度（微信一次授权算一条） */
async function grant(userId, tmplId, n = 1) {
  await ensureTable();
  await pool.query(
    'INSERT INTO push_quota (user_id, tmpl_id, remain, granted_at) VALUES (?, ?, ?, NOW()) ' +
    'ON DUPLICATE KEY UPDATE remain = remain + VALUES(remain), granted_at = NOW()',
    [userId, tmplId, n]
  );
}

/** 还剩几次。给前端用（决定还要不要提示用户授权） */
async function remain(userId, tmplId) {
  await ensureTable();
  const [rows] = await pool.query(
    'SELECT remain FROM push_quota WHERE user_id = ? AND tmpl_id = ?', [userId, tmplId]
  );
  return rows.length ? Number(rows[0].remain) : 0;
}

/** 哪个用户在某个模板上有额度 —— 定时任务只用给这些人发 */
async function withQuota(tmplId) {
  await ensureTable();
  const [rows] = await pool.query(
    'SELECT q.user_id, q.remain, u.openid FROM push_quota q JOIN users u ON u.id = q.user_id ' +
    'WHERE q.tmpl_id = ? AND q.remain > 0 AND u.openid IS NOT NULL AND u.openid <> ?',
    [tmplId, '']
  );
  return rows;
}

/**
 * 下发一条。**成功才扣额度** —— 失败还扣的话，用户白授权了却什么都没收到。
 * @returns {{ok:boolean, errcode?:number, errmsg?:string}}
 */
async function sendOne(openid, tmplId, data, page) {
  const body = await callWx('/cgi-bin/message/subscribe/send', {
    touser: openid,
    template_id: tmplId,
    page: page || 'pages/advisor/advisor',
    data: data
  });
  const ok = body && body.errcode === 0;
  if (!ok) {
    // 43101 = 用户拒收/额度已用尽；47003 = 模板参数不合法。都不该静默吞掉：
    // 这两个错正是"代码写错了"和"用户撤了授权"的分界，日志里要能一眼分清。
    log.warn('[push] 下发失败:', body && body.errcode, body && body.errmsg);
  }
  return { ok, errcode: body && body.errcode, errmsg: body && body.errmsg };
}

/**
 * 组装模板数据。
 * fields 形如 { thing1: 'title', time2: 'time', thing3: 'detail' }，
 * 左边是微信模板里的字段名（用户建模板时给的），右边取我们 values 里的哪个值。
 * 这样**换模板只要改配置，不用改代码**。
 */
function buildData(fields, values) {
  const out = {};
  Object.keys(fields || {}).forEach((wxKey) => {
    const ourKey = fields[wxKey];
    const v = values[ourKey];
    out[wxKey] = { value: clip(wxKey, v == null ? '' : v) };
  });
  return out;
}

module.exports = { ensureTable, grant, remain, withQuota, sendOne, buildData, clip, fieldType };

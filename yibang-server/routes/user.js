const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { callWx } = require('../lib/wxtoken');
const { ymd, stamp } = require('../lib/ledger');
const log = require('../lib/log');

/** 校验登录态 —— 手机号绑定必须知道绑给谁 */
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
 * 统一的用户对外结构。手机号只回给本人，同时给出 needPhone 供前端做注册门槛。
 *
 * ⚠️ FORCE_PHONE=0 是运维安全阀：小程序后台如果还没开通「手机号快速验证组件」，
 * 前端会把人卡在注册页出不去（包括管理员自己）。把 .env 里 FORCE_PHONE 设成 0
 * 并重启，门槛立刻关闭，不用改代码不用发版。默认开着（不设等于 1）。
 */
function publicUser(u) {
  const needPhone = !u.phone && process.env.FORCE_PHONE !== '0';
  return {
    id: u.id,
    nickname: u.nickname || '',
    shop_name: u.shop_name || '',
    role: u.role,
    plan_type: u.plan_type,
    phone: u.phone || '',
    business_day_end: u.business_day_end || '00:00',
    needPhone
  };
}

function signToken(user) {
  return jwt.sign({ userId: user.id, openid: user.openid }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// 微信登录
router.post('/login', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.json({ code: 400, msg: '缺少code参数' });
  }

  try {
    // 调用微信接口获取openid
    const wxUrl = `https://api.weixin.qq.com/sns/jscode2session?appid=${process.env.WX_APPID}&secret=${process.env.WX_SECRET}&js_code=${code}&grant_type=authorization_code`;
    const wxRes = await axios.get(wxUrl);

    if (wxRes.data.errcode) {
      return res.json({ code: 400, msg: '微信登录失败: ' + wxRes.data.errmsg });
    }

    const openid = wxRes.data.openid;

    // 查询或创建用户
    const [rows] = await pool.query('SELECT * FROM users WHERE openid = ?', [openid]);

    let user;
    if (rows.length === 0) {
      // 新用户
      const [result] = await pool.query(
        'INSERT INTO users (openid, role) VALUES (?, 1)',
        [openid]
      );
      user = { id: result.insertId, openid, role: 1, plan_type: 0, phone: null };
    } else {
      user = rows[0];
    }

    res.json({
      code: 0,
      msg: '登录成功',
      data: { token: signToken(user), user: publicUser(user) }
    });
  } catch (err) {
    log.error('登录错误:', err && err.message);
    res.json({ code: 500, msg: '登录失败' });
  }
});

/**
 * 绑定手机号（注册的最后一步）。
 *
 * 前端用 `<button open-type="getPhoneNumber">` 拿到 code 传过来，
 * 服务端换 access_token 去微信换真实号码。**号码只在服务端落地，前端不参与解析** ——
 * 这样号码不可能被篡改，客户端也不需要做任何手机号格式判断。
 *
 * 计费提醒：微信「手机号快速验证组件」每次成功调用 0.03 元，每个小程序有 1000 次
 * 免费体验额度（正式/体验/开发版共用），超额要在小程序后台「付费管理」充值。
 * 额度用尽、能力未开通、密钥配错这几种情况必须分开告诉用户，不能糊成一句「失败」。
 */
router.post('/bind-phone', auth, async (req, res) => {
  const { code } = req.body || {};
  if (!code) {
    return res.json({ code: 400, msg: '缺少手机号授权凭证，请重新点击授权按钮' });
  }

  try {
    const data = await callWx('/wxa/business/getuserphonenumber', { code });

    if (data.errcode) {
      log.error('换取手机号失败:', data.errcode, data.errmsg);
      const tips = {
        '-1': '微信服务繁忙，请稍后重试',
        '40001': '小程序的 AppSecret 配置有误，请联系管理员',
        '40029': '授权凭证已失效，请重新点击授权按钮',
        '9410001': '小程序还没开通手机号验证能力，请先在微信后台开通',
        '9410003': '手机号验证额度用完了，请在微信后台「付费管理」充值后重试'
      };
      return res.json({
        code: 400,
        msg: tips[String(data.errcode)] || ('手机号获取失败（' + data.errcode + '）'),
        detail: data.errmsg || ''
      });
    }

    const info = data.phone_info || {};
    const phone = String(info.purePhoneNumber || info.phoneNumber || '').trim();
    if (!/^\d{6,20}$/.test(phone)) {
      log.error('微信返回的手机号格式异常:', JSON.stringify(info).slice(0, 200));
      return res.json({ code: 500, msg: '拿到的手机号格式不对，请重试' });
    }

    await pool.query(
      'UPDATE users SET phone = ?, phone_bound_at = NOW() WHERE id = ?',
      [phone, req.userId]
    );
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.userId]);
    if (!rows.length) return res.json({ code: 404, msg: '用户不存在' });

    res.json({
      code: 0,
      msg: '绑定成功',
      data: { token: signToken(rows[0]), user: publicUser(rows[0]) }
    });
  } catch (err) {
    log.error('绑定手机号异常:', (err && err.message) || err, err.response ? err.response.data : '');
    res.json({ code: 500, msg: '绑定失败，请稍后重试' });
  }
});

/**
 * 注销账号（彻底删除个人数据）。
 *
 * **这是合规硬要求**，不是可选项：微信《开发者合规开发指引》明确要求
 * 「带有账户系统的小程序，必须开发清晰可找、正常可用的退出注销功能，
 * 用户可自主注销账号、清除个人数据」。
 *
 * 实现口径：
 * - 必须显式传 `confirm: 'DELETE'`，避免误触把账本删光；
 * - 一个事务里删干净该用户的全部业务数据 + users 行，**不留残渣**；
 * - 删之前把手机号回显给用户确认过一次（前端做），后端只认 confirm。
 *
 * 注意：这是不可逆的。所以删除顺序按外键依赖来：先子表后主表。
 */
router.post('/delete-account', auth, async (req, res) => {
  const confirm = String((req.body || {}).confirm || '');
  if (confirm !== 'DELETE') {
    return res.json({ code: 400, msg: '需要确认参数才能注销（confirm=DELETE）' });
  }

  const uid = req.userId;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 先删明细/从表，再删主表
    await conn.query('DELETE FROM purchase_items WHERE user_id = ?', [uid]);
    await conn.query('DELETE FROM purchase_orders WHERE user_id = ?', [uid]);
    await conn.query('DELETE FROM ai_corrections WHERE user_id = ?', [uid]);
    await conn.query('DELETE FROM merchant_terms WHERE user_id = ?', [uid]);
    await conn.query('DELETE FROM transactions WHERE user_id = ?', [uid]);
    await conn.query('DELETE FROM contacts WHERE user_id = ?', [uid]);
    await conn.query('DELETE FROM files WHERE user_id = ?', [uid]);
    await conn.query('DELETE FROM shares WHERE user_id = ?', [uid]);
    await conn.query('DELETE FROM promotions WHERE inviter_id = ? OR invitee_id = ?', [uid, uid]);
    // 店员关系：被删的人如果挂在某个老板下面，先解除
    await conn.query('UPDATE users SET boss_id = NULL WHERE boss_id = ?', [uid]);
    const [r] = await conn.query('DELETE FROM users WHERE id = ?', [uid]);

    if (!r.affectedRows) {
      await conn.rollback();
      return res.json({ code: 404, msg: '账号不存在或已被注销' });
    }

    await conn.commit();
    log.info('账号已注销 userId=' + uid);
    res.json({ code: 0, msg: '账号已注销，数据已删除' });
  } catch (err) {
    await conn.rollback();
    log.error('注销账号失败:', err && err.message);
    res.json({ code: 500, msg: '注销失败，请稍后重试' });
  } finally {
    conn.release();
  }
});

// 获取用户信息
/**
 * 改昵称 / 店名。
 *
 * 为什么现在必须有：报表分享出去的页面要显示"这是谁家的账"。
 * 店名为空时对方只看到品牌名，压根不知道是谁发的。
 * （前端「我的」页一直写着「点这里完善店名」，但那个地方原来根本点不动 ——
 *  一个空头承诺，配上分享功能就变成真缺口了。）
 */
router.post('/profile', auth, async (req, res) => {
  const { nickname, shop_name, business_day_end } = req.body || {};
  const fields = [];
  const params = [];
  const clean = (v) => String(v == null ? '' : v).trim().slice(0, 100);

  if (nickname !== undefined) {
    fields.push('nickname = ?');
    params.push(clean(nickname) || null);
  }
  if (shop_name !== undefined) {
    fields.push('shop_name = ?');
    params.push(clean(shop_name) || null);
  }
  if (business_day_end !== undefined) {
    const v = String(business_day_end).trim();
    if (/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v)) {
      const hour = parseInt(v.split(':')[0], 10);
      if (hour >= 0 && hour <= 6) {
        fields.push('business_day_end = ?');
        params.push(v);
      }
    }
  }
  if (!fields.length) return res.json({ code: 400, msg: '没有要改的内容' });

  try {
    params.push(req.userId);
    await pool.query('UPDATE users SET ' + fields.join(', ') + ' WHERE id = ?', params);
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.userId]);
    res.json({ code: 0, msg: '已保存', data: { user: publicUser(rows[0]) } });
  } catch (err) {
    log.error('保存资料失败:', err.message);
    res.json({ code: 500, msg: '没保存上，稍后再试' });
  }
});

router.get('/info', auth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.userId]);
    if (rows.length === 0) {
      return res.json({ code: 404, msg: '用户不存在' });
    }
    res.json({ code: 0, data: publicUser(rows[0]) });
  } catch (err) {
    res.json({ code: 500, msg: '获取用户信息失败' });
  }
});

/**
 * 导出全部账目为 Excel 文件（2026-09-22 升级）
 *
 * 给用户数据安全感：账是命根子，用户总得有个办法把数据拿走。
 * 生成 Excel 文件（多Sheet）上传到 OSS，返回文件 URL，前端下载后用微信打开。
 *
 * 包含4个Sheet：
 * 1. 交易记录 - 所有收支明细
 * 2. 往来对象 - 客户/供应商列表
 * 3. 员工管理 - 员工列表
 * 4. 统计汇总 - 收支汇总
 */
router.get('/export-excel', auth, async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const oss = require('../lib/oss');
    const TYPE_TEXT = { 1: '收入', 2: '支出', 3: '应收', 4: '应付', 5: '回款', 6: '付款' };

    // 创建工作簿
    const workbook = new ExcelJS.Workbook();
    workbook.creator = '易帮账本';
    workbook.created = new Date();

    // 表头样式
    const headerStyle = {
      font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4551D' } },
      alignment: { horizontal: 'center', vertical: 'middle' },
      border: {
        top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        right: { style: 'thin', color: { argb: 'FFCCCCCC' } }
      }
    };

    const cellStyle = {
      alignment: { vertical: 'middle' },
      border: {
        top: { style: 'thin', color: { argb: 'FFEEEEEE' } },
        left: { style: 'thin', color: { argb: 'FFEEEEEE' } },
        bottom: { style: 'thin', color: { argb: 'FFEEEEEE' } },
        right: { style: 'thin', color: { argb: 'FFEEEEEE' } }
      }
    };

    // ========== Sheet1: 交易记录 ==========
    // 支持按日期范围导出（报表页用），不传就导出全部（我的页面用）
    const { from, to } = req.query;
    let whereSql = 'WHERE t.user_id = ? AND t.status = 1';
    let params = [req.userId];
    if (from && to) {
      whereSql += ' AND t.record_date >= ? AND t.record_date <= ?';
      params.push(from, to);
    }
    const [rows] = await pool.query(
      `SELECT t.type, t.amount, t.content, t.record_date, t.created_at, c.name AS contact_name FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id ${whereSql} ORDER BY t.record_date DESC, t.id DESC LIMIT 5000`,
      params
    );

    const sheet1 = workbook.addWorksheet('交易记录', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet1.columns = [
      { header: '日期', key: 'date', width: 15 },
      { header: '类型', key: 'type', width: 10 },
      { header: '金额', key: 'amount', width: 15 },
      { header: '往来对象', key: 'contact', width: 25 },
      { header: '事由', key: 'content', width: 40 },
      { header: '记录时间', key: 'created', width: 20 }
    ];
    sheet1.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
    sheet1.getRow(1).height = 28;

    for (const r of rows) {
      const row = sheet1.addRow({
        date: r.record_date ? ymd(new Date(r.record_date)) : '',
        type: TYPE_TEXT[r.type] || '其他',
        amount: Number(r.amount).toFixed(2),
        contact: r.contact_name || '',
        content: r.content || '',
        created: r.created_at ? stamp(new Date(r.created_at)) : ''
      });
      row.eachCell((cell) => { cell.style = cellStyle; });
      row.height = 22;
    }

    // ========== Sheet2: 往来对象 ==========
    const [contacts] = await pool.query(
      'SELECT name, type, phone, remark, balance, created_at FROM contacts WHERE user_id = ? ORDER BY created_at DESC',
      [req.userId]
    );

    const sheet2 = workbook.addWorksheet('往来对象', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet2.columns = [
      { header: '名称', key: 'name', width: 25 },
      { header: '类型', key: 'type', width: 10 },
      { header: '电话', key: 'phone', width: 18 },
      { header: '应收/应付余额', key: 'balance', width: 18 },
      { header: '备注', key: 'remark', width: 30 },
      { header: '创建时间', key: 'created', width: 20 }
    ];
    sheet2.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
    sheet2.getRow(1).height = 28;

    const CONTACT_TYPE = { 1: '客户', 2: '供应商', 3: '其他' };
    for (const c of contacts) {
      const row = sheet2.addRow({
        name: c.name,
        type: CONTACT_TYPE[c.type] || '其他',
        phone: c.phone || '',
        balance: Number(c.balance).toFixed(2),
        remark: c.remark || '',
        created: c.created_at ? stamp(new Date(c.created_at)) : ''
      });
      row.eachCell((cell) => { cell.style = cellStyle; });
      row.height = 22;
    }

    // ========== Sheet3: 统计汇总 ==========
    const [summary] = await pool.query(
      'SELECT type, COUNT(*) as count, SUM(amount) as total FROM transactions WHERE user_id = ? AND status = 1 GROUP BY type',
      [req.userId]
    );

    const sheet4 = workbook.addWorksheet('统计汇总');
    sheet4.columns = [
      { header: '类型', key: 'type', width: 15 },
      { header: '笔数', key: 'count', width: 15 },
      { header: '总金额', key: 'total', width: 20 }
    ];
    sheet4.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
    sheet4.getRow(1).height = 28;

    let totalIncome = 0, totalExpense = 0;
    for (const s of summary) {
      const typeText = TYPE_TEXT[s.type] || '其他';
      const row = sheet4.addRow({
        type: typeText,
        count: s.count,
        total: Number(s.total).toFixed(2)
      });
      row.eachCell((cell) => { cell.style = cellStyle; });
      row.height = 22;
      if (s.type === 1) totalIncome += Number(s.total);
      if (s.type === 2) totalExpense += Number(s.total);
    }

    // 添加合计行
    const blankRow = sheet4.addRow({});
    blankRow.height = 10;
    const sumRow = sheet4.addRow({
      type: '收入合计',
      count: '',
      total: totalIncome.toFixed(2)
    });
    sumRow.eachCell((cell) => { 
      cell.style = { ...cellStyle, font: { bold: true } };
    });
    sumRow.height = 24;

    const sumRow2 = sheet4.addRow({
      type: '支出合计',
      count: '',
      total: totalExpense.toFixed(2)
    });
    sumRow2.eachCell((cell) => { 
      cell.style = { ...cellStyle, font: { bold: true } };
    });
    sumRow2.height = 24;

    const sumRow3 = sheet4.addRow({
      type: '结余',
      count: '',
      total: (totalIncome - totalExpense).toFixed(2)
    });
    sumRow3.eachCell((cell) => { 
      cell.style = { ...cellStyle, font: { bold: true, color: { argb: 'FFE4551D' } } };
    });
    sumRow3.height = 24;

    // 生成Excel buffer
    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = '易帮账本_账目导出_' + ymd(new Date()) + '.xlsx';
    const objectName = 'exports/' + req.userId + '_' + Date.now() + '.xlsx';

    // 上传到 OSS
    await oss.putBuffer(objectName, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    // 生成带签名的URL（OSS是私有的，直接访问会403）
    const fileUrl = await oss.getSignedUrl(objectName, 7 * 24 * 3600);

    res.json({
      code: 0,
      data: {
        fileUrl,
        fileName,
        count: rows.length,
        sheets: ['交易记录', '往来对象', '员工管理', '统计汇总']
      }
    });
  } catch (err) {
    log.error('导出Excel失败:', err.message);
    res.json({ code: 500, msg: '导出失败，稍后再试' });
  }
});

// 保留CSV导出接口（兼容旧版本）
router.get('/export-csv', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT t.type, t.amount, t.content, t.record_date, t.created_at, c.name AS contact_name FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id WHERE t.user_id = ? AND t.status = 1 ORDER BY t.record_date DESC, t.id DESC LIMIT 5000',
      [req.userId]
    );

    const TYPE_TEXT = { 1: '收入', 2: '支出', 3: '应收', 4: '应付', 5: '回款', 6: '付款' };

    let csv = '日期,类型,金额,往来对象,事由,记录时间\n';

    for (const r of rows) {
      const typeText = TYPE_TEXT[r.type] || '其他';
      const amount = Number(r.amount).toFixed(2);
      const contact = (r.contact_name || '').replace(/,/g, '，');
      const content = (r.content || '').replace(/,/g, '，');
      const date = r.record_date ? ymd(new Date(r.record_date)) : '';
      const created = r.created_at ? stamp(new Date(r.created_at)) : '';

      csv += date + ',' + typeText + ',' + amount + ',' + contact + ',' + content + ',' + created + '\n';
    }

    const bom = '\uFEFF';
    const buffer = Buffer.from(bom + csv, 'utf-8');
    const fileName = '易帮账本_账目导出_' + ymd(new Date()) + '.csv';
    const objectName = 'exports/' + req.userId + '_' + Date.now() + '.csv';

    const oss = require('../lib/oss');
    await oss.putBuffer(objectName, buffer, 'text/csv; charset=utf-8');
    const fileUrl = await oss.getSignedUrl(objectName, 7 * 24 * 3600);

    res.json({
      code: 0,
      data: {
        fileUrl,
        fileName,
        count: rows.length
      }
    });
  } catch (err) {
    log.error('导出CSV失败:', err.message);
    res.json({ code: 500, msg: '导出失败，稍后再试' });
  }
});


/**
 * 导出全部数据备份（2026-09-22 新增）
 *
 * 给用户数据安全感：账是命根子，用户总得有个办法把全部数据拿走。
 * 导出 JSON 格式的完整备份，包含用户信息、交易记录、往来对象、AI记忆等。
 */
router.get('/backup', auth, async (req, res) => {
  try {
    const oss = require('../lib/oss');
    const userId = req.userId;

    // 导出用户信息
    const [users] = await pool.query(
      'SELECT id, nickname, shop_name, phone, plan_type, created_at FROM users WHERE id = ?',
      [userId]
    );

    // 导出交易记录
    const [transactions] = await pool.query(
      'SELECT * FROM transactions WHERE user_id = ? AND status = 1 ORDER BY record_date DESC, id DESC',
      [userId]
    );

    // 导出往来对象
    const [contacts] = await pool.query(
      'SELECT * FROM contacts WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    // 导出AI纠正记录
    const [aiCorrections] = await pool.query(
      'SELECT * FROM ai_corrections WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    // 导出商户术语（AI记忆）
    const [merchantTerms] = await pool.query(
      'SELECT * FROM merchant_terms WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    // 导出文件记录
    const [files] = await pool.query(
      'SELECT id, user_id, transaction_id, file_url, file_type, file_size, created_at FROM files WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    // 导出采购订单
    const [purchaseOrders] = await pool.query(
      'SELECT * FROM purchase_orders WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    // 导出采购明细（注意：purchase_items表没有created_at字段，用id排序）
    let purchaseItems = [];
    try {
      const [piResult] = await pool.query(
        'SELECT pi.* FROM purchase_items pi JOIN purchase_orders po ON pi.order_id = po.id WHERE po.user_id = ? ORDER BY pi.id DESC',
        [userId]
      );
      purchaseItems = piResult;
    } catch (e) {
      log.warn('导出采购明细失败（跳过）:', e.message);
    }

    // 组装备份数据
    const backup = {
      version: '1.0',
      exportTime: new Date().toISOString(),
      app: '易帮账本',
      data: {
        user: users[0] || null,
        transactions,
        contacts,
        aiCorrections,
        merchantTerms,
        files,
        purchaseOrders,
        purchaseItems
      },
      summary: {
        transactions: transactions.length,
        contacts: contacts.length,
        aiCorrections: aiCorrections.length,
        merchantTerms: merchantTerms.length,
        files: files.length,
        purchaseOrders: purchaseOrders.length
      }
    };

    // 生成JSON文件
    const jsonStr = JSON.stringify(backup, null, 2);
    const buffer = Buffer.from(jsonStr, 'utf-8');
    const fileName = '易帮账本_数据备份_' + ymd(new Date()) + '.json';
    const objectName = 'backups/' + userId + '_' + Date.now() + '.json';

    // 上传到OSS
    await oss.putBuffer(objectName, buffer, 'application/json; charset=utf-8');
    
    // 生成带签名的URL
    const fileUrl = await oss.getSignedUrl(objectName, 30 * 24 * 3600);

    res.json({
      code: 0,
      data: {
        fileUrl,
        fileName,
        summary: backup.summary
      }
    });
  } catch (err) {
    log.error('导出备份失败:', err.message);
    res.json({ code: 500, msg: '导出备份失败，稍后再试' });
  }
});

/**
 * 从备份文件恢复数据（2026-09-22 新增）
 *
 * 用户上传JSON备份文件，后端解析后恢复所有数据。
 * 注意：这是危险操作，会覆盖当前所有数据。
 */
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.post('/restore', auth, upload.single('file'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (!req.file) {
      return res.json({ code: 400, msg: '请上传备份文件' });
    }

    // 解析JSON
    let backup;
    try {
      backup = JSON.parse(req.file.buffer.toString('utf-8'));
    } catch (e) {
      return res.json({ code: 400, msg: '备份文件格式错误' });
    }

    if (!backup.data || !backup.data.user) {
      return res.json({ code: 400, msg: '备份文件内容不完整' });
    }

    const userId = req.userId;
    const data = backup.data;

    // 开启事务
    await conn.beginTransaction();

    // 1. 删除当前用户的所有数据
    await conn.query('DELETE FROM transactions WHERE user_id = ?', [userId]);
    await conn.query('DELETE FROM contacts WHERE user_id = ?', [userId]);
    await conn.query('DELETE FROM ai_corrections WHERE user_id = ?', [userId]);
    await conn.query('DELETE FROM merchant_terms WHERE user_id = ?', [userId]);
    await conn.query('DELETE FROM files WHERE user_id = ?', [userId]);
    await conn.query('DELETE FROM purchase_orders WHERE user_id = ?', [userId]);
    // purchase_items 通过 order_id 关联，会级联删除（如果有外键），这里手动删
    await conn.query('DELETE pi FROM purchase_items pi JOIN purchase_orders po ON pi.order_id = po.id WHERE po.user_id = ?', [userId]);

    // 2. 恢复交易记录
    let transactionCount = 0;
    if (data.transactions && data.transactions.length) {
      for (const t of data.transactions) {
        await conn.query(
          'INSERT INTO transactions (user_id, type, amount, content, record_date, contact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [userId, t.type, t.amount, t.content, t.record_date, t.contact_id || null, t.created_at || new Date()]
        );
        transactionCount++;
      }
    }

    // 3. 恢复往来对象
    let contactCount = 0;
    if (data.contacts && data.contacts.length) {
      for (const c of data.contacts) {
        await conn.query(
          'INSERT INTO contacts (user_id, name, type, phone, remark, balance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [userId, c.name, c.type, c.phone || null, c.remark || null, c.balance || 0, c.created_at || new Date()]
        );
        contactCount++;
      }
    }

    // 4. 恢复AI纠正记录
    if (data.aiCorrections && data.aiCorrections.length) {
      for (const a of data.aiCorrections) {
        await conn.query(
          'INSERT INTO ai_corrections (user_id, original_text, corrected_text, field, created_at) VALUES (?, ?, ?, ?, ?)',
          [userId, a.original_text, a.corrected_text, a.field || null, a.created_at || new Date()]
        );
      }
    }

    // 5. 恢复商户术语
    if (data.merchantTerms && data.merchantTerms.length) {
      for (const m of data.merchantTerms) {
        await conn.query(
          'INSERT INTO merchant_terms (user_id, term, type, count, created_at) VALUES (?, ?, ?, ?, ?)',
          [userId, m.term, m.type, m.count || 1, m.created_at || new Date()]
        );
      }
    }

    // 6. 更新用户信息
    if (data.user) {
      await conn.query(
        'UPDATE users SET nickname = ?, shop_name = ? WHERE id = ?',
        [data.user.nickname || null, data.user.shop_name || null, userId]
      );
    }

    // 提交事务
    await conn.commit();

    res.json({
      code: 0,
      data: {
        summary: {
          transactions: transactionCount,
          contacts: contactCount
        }
      }
    });
  } catch (err) {
    // 回滚事务
    await conn.rollback();
    log.error('恢复数据失败:', err.message);
    res.json({ code: 500, msg: '恢复失败，稍后再试' });
  } finally {
    conn.release();
  }
});
module.exports = router;

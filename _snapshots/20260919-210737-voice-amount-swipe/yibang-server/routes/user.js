const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { callWx } = require('../lib/wxtoken');

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
    console.error('登录错误:', err && err.message);
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
      console.error('换取手机号失败:', data.errcode, data.errmsg);
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
      console.error('微信返回的手机号格式异常:', JSON.stringify(info).slice(0, 200));
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
    console.error('绑定手机号异常:', (err && err.message) || err, err.response ? err.response.data : '');
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
    console.log('账号已注销 userId=' + uid);
    res.json({ code: 0, msg: '账号已注销，数据已删除' });
  } catch (err) {
    await conn.rollback();
    console.error('注销账号失败:', err && err.message);
    res.json({ code: 500, msg: '注销失败，请稍后重试' });
  } finally {
    conn.release();
  }
});

// 获取用户信息
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

module.exports = router;

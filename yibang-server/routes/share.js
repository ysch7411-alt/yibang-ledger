const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { dayOr } = require('../lib/ledger');
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
 * 分享给**别人**看的报表（2026-09-19 用户要求）：
 * 「能直接分享这个报表页面，收到的用户只要微信登录进去就能看到这个表」
 *
 * 与小程序的配合：老板点分享 → 微信转发的是**小程序卡片**，path 上带着 token。
 * 对方点开直接进小程序（微信自动登录），不需要注册、不需要绑手机号 ——
 * token 就是访问凭证，页面拿 token 自己去公开接口取数。
 *
 * 三种分享：
 *   1 每日汇总（按 data_date）—— 早期设计，保留
 *   2 客户对账（按 contact_id）—— 保留
 *   3 报表（按 from_date ~ to_date 区间）—— 现在用的
 *
 * 为什么报表不做成"实时算今天"：**分享出去的是一份快照**。
 * 老板今天分享「今日报表」，对方明天再打开，看到的应该还是那一天的账，
 * 而不是悄悄变成明天的。所以区间在创建时就固定下来。
 */

/** 服务器时间。口径不能用客户端时钟算 —— 手机时间不准（或被改过）会把区间算错。 */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** period → 区间。month 的起是本月 1 号、止是今天（不是月底：未来的账还不存在） */
function rangeOf(period) {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const fmt = (d) => d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  const to = fmt(now);
  if (period === 'month') {
    return { from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), to, period: 'month' };
  }
  return { from: to, to, period: 'today' };
}

const LABEL = { today: '今日报表', month: '本月报表' };

/** 明细一次最多给这么多行。超了如实说明"还有多少没列出来"，不假装完整。 */
const MAX_DETAILS = 500;

// 生成分享
router.post('/create', auth, async (req, res) => {
  const { type, contact_id, data_date, period, expire_days = 7 } = req.body || {};

  const t = Number(type);
  if (![1, 2, 3].includes(t)) {
    return res.json({ code: 400, msg: '请指定分享类型（1 每日汇总 / 2 客户对账 / 3 报表）' });
  }

  const days = Number(expire_days);
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    return res.json({ code: 400, msg: 'expire_days 需要在 1~365 之间' });
  }

  let row;

  if (t === 3) {
    const r = rangeOf(period === 'month' ? 'month' : 'today');
    row = { contact_id: null, data_date: null, from_date: r.from, to_date: r.to, period: r.period };
  } else if (t === 2) {
    if (!contact_id) return res.json({ code: 400, msg: '客户对账分享需要指定 contact_id' });
    // 越权校验：contact_id 是客户端传的。不查归属的话，配上 view 那边"读联系人也没带 user_id"，
    // 就能读到别人的客户名和电话 —— 两个洞凑一起才是真问题，所以两边都要堵。
    const [c] = await pool.query('SELECT id FROM contacts WHERE id = ? AND user_id = ?', [contact_id, req.userId]);
    if (!c.length) return res.json({ code: 400, msg: '这个往来对象不属于你' });
    /* 「截至日」必须钉死在**创建这一刻**，用服务器时间（不信客户端时钟）。
       对账单如果每次打开都跟着数据走，客户今天看到余额 8000、明天打开变成 11500，
       两边就永远对不上账 —— 而这个链接本来就是拿来对账的。
       记下 to_date，明细与余额都按它截断，页面上写明「截至 X 月 X 日」。
       （老分享记录的 to_date 是 null，view 那边会退回"今天"兜底，不会因此查全表。） */
    row = { contact_id, data_date: null, from_date: null, to_date: todayStr(), period: null };
  } else {
    row = { contact_id: null, data_date: dayOr(data_date, todayStr()), from_date: null, to_date: null, period: null };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expireAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  try {
    await pool.query(
      'INSERT INTO shares (token, user_id, type, contact_id, data_date, from_date, to_date, period, expire_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [token, req.userId, t, row.contact_id, row.data_date, row.from_date, row.to_date, row.period, expireAt]
    );

    res.json({
      code: 0,
      msg: '分享链接生成成功',
      data: {
        token,
        // 只给小程序页面路径，不给 http 链接：后端没有渲染页（H5 明确不做），
        // 而微信里分享的是小程序卡片，卡片的 path 就是这个。
        path: '/pages/report-view/report-view?token=' + token,
        type: t,
        period: row.period,
        from: row.from_date,
        to: row.to_date,
        expire_at: expireAt
      }
    });
  } catch (err) {
    log.error('生成分享失败:', err.message);
    res.json({ code: 500, msg: '生成分享失败' });
  }
});

/**
 * 公开接口：查看分享内容。**不需要登录** —— 持 token 即可读，
 * 而且只读得到这一个 token 绑定的那点数据。
 */
router.get('/view/:token', async (req, res) => {
  const token = String(req.params.token || '').trim();
  // 先卡格式：token 是 32 字节随机 hex（64 位）。不合格式的直接 404，
  // 不给数据库白跑一趟，也顺手挡掉扫描器的垃圾请求。
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return res.json({ code: 404, msg: '分享链接无效' });
  }

  try {
    const [shares] = await pool.query(
      // DATE 一律在源头取成字符串：mysql2 会把 DATE 返回成 JS Date，
      // JSON 化后带 UTC 偏移，再拿去比较就把区间算错一天。
      'SELECT s.id, s.user_id, s.type, s.contact_id, s.period, s.expire_at, s.view_count, ' +
      "DATE_FORMAT(s.data_date, '%Y-%m-%d') AS data_day, " +
      "DATE_FORMAT(s.from_date, '%Y-%m-%d') AS from_day, " +
      "DATE_FORMAT(s.to_date,   '%Y-%m-%d') AS to_day, " +
      "DATE_FORMAT(s.expire_at, '%Y-%m-%d') AS expire_day " +
      'FROM shares s WHERE s.token = ? AND s.is_valid = 1 AND s.expire_at > NOW()',
      [token]
    );

    if (!shares.length) {
      return res.json({ code: 404, msg: '分享链接无效或已过期' });
    }

    const share = shares[0];
    await pool.query('UPDATE shares SET view_count = view_count + 1 WHERE id = ?', [share.id]);

    const [u] = await pool.query('SELECT shop_name, nickname FROM users WHERE id = ?', [share.user_id]);
    const shop = (u.length && (u[0].shop_name || u[0].nickname)) || '';

    const meta = {
      // 店名可能没填（老易的账号就没填）。留空让页面按品牌兜底，
      // 别在这编一个「一个账本」—— 对方看到这四个字不知道是谁的账。
      shop: shop || '',
      expireDay: share.expire_day,
      viewCount: Number(share.view_count) + 1
    };

    if (share.type === 3) {
      const from = share.from_day;
      const to = share.to_day;

      const [sum] = await pool.query(
        'SELECT COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END), 0) AS income, ' +
        'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END), 0) AS expense, ' +
        'COUNT(*) AS cnt ' +
        'FROM transactions WHERE user_id = ? AND status = 1 AND record_date >= ? AND record_date <= ?',
        [share.user_id, from, to]
      );

      // 只取要展示的字段。这是**对外**接口，绝不 t.* ——
      // user_id / created_by / status 这些内部字段一个都不该漏出去。
      const [details] = await pool.query(
        'SELECT t.id, t.type, t.amount, t.content, t.qty, t.unit, t.unit_price, t.pay_method, ' +
        "DATE_FORMAT(t.record_date, '%Y-%m-%d') AS record_date, t.created_at, c.name AS contact_name " +
        'FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id ' +
        'WHERE t.user_id = ? AND t.status = 1 AND t.record_date >= ? AND t.record_date <= ? ' +
        'ORDER BY t.record_date DESC, t.created_at DESC, t.id DESC LIMIT ' + MAX_DETAILS,
        [share.user_id, from, to]
      );

      const cnt = Number(sum[0].cnt);
      const income = Number(sum[0].income);
      const expense = Number(sum[0].expense);

      return res.json({
        code: 0,
        data: Object.assign({}, meta, {
          kind: 'report',
          label: LABEL[share.period] || '报表',
          from,
          to,
          income,
          expense,
          net: Math.round((income - expense) * 100) / 100,
          count: cnt,
          details,
          // 明细超过上限时如实说明，别让对方以为这就是全部
          truncated: Math.max(0, cnt - details.length)
        })
      });
    }

    if (share.type === 2) {
      // 两个查询都必须带 user_id：contact_id 是客户端传进来的，
      // 只按 id 查会让持有链接的人看到不属于这个账本的联系人。
      // 注意这里**不再取 contacts.balance** —— 那是"此刻"的余额，
      // 而下面明细已经截到 asOf 了，两者口径必须一致，否则对账单自己跟自己打架。
      const [contact] = await pool.query(
        'SELECT id, name, phone, type FROM contacts WHERE id = ? AND user_id = ?',
        [share.contact_id, share.user_id]
      );
      if (!contact.length) return res.json({ code: 404, msg: '分享的对账对象已不存在' });

      // 截至日：老分享记录 to_date 为 null，退回今天兜底（不因缺字段而查全表）
      const asOf = share.to_day || todayStr();

      // 只取页面真正会渲染的列。**不带 category** —— 那是老板自己给账目归的类
      //（「工资」「房租」…），属于账本内部的口径；发给客户的账单上有「事由」就够了，
      // 把内部分类摊给客户看只会引起"你这笔记的什么"这类无谓追问。
      const [transactions] = await pool.query(
        'SELECT id, type, amount, content, ' +
        "DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date, created_at " +
        'FROM transactions WHERE user_id = ? AND contact_id = ? AND status = 1 AND record_date <= ? ' +
        'ORDER BY record_date DESC, created_at DESC, id DESC LIMIT ' + MAX_DETAILS,
        [share.user_id, share.contact_id, asOf]
      );

      /* 四个分项 + 余额都按 asOf 从明细现算，算式与 lib/ledger.js 的 recalcBalance **完全一致**：
           余额 = 应收(3) − 回款(5) − 应付(4) + 付款(6)
         口径必须一模一样 —— 客户拿着这个数跟老板小程序里看到的对不上，这份对账单就废了。

         为什么要把四个分项都列出来：只给一个余额，对方没法验算，反而更容易起疑；
         列出「应收多少 / 已回多少 / 还差多少」，客户自己一加就能核对，这才是对账单的价值。 */
      const [agg] = await pool.query(
        'SELECT ' +
        'COALESCE(SUM(CASE WHEN type = 3 THEN amount ELSE 0 END), 0) AS recv_amt, ' +
        'COALESCE(SUM(CASE WHEN type = 5 THEN amount ELSE 0 END), 0) AS back_amt, ' +
        'COALESCE(SUM(CASE WHEN type = 4 THEN amount ELSE 0 END), 0) AS pay_amt, ' +
        'COALESCE(SUM(CASE WHEN type = 6 THEN amount ELSE 0 END), 0) AS done_amt, ' +
        'COUNT(*) AS cnt ' +
        'FROM transactions WHERE user_id = ? AND contact_id = ? AND status = 1 AND record_date <= ?',
        [share.user_id, share.contact_id, asOf]
      );
      const a = agg[0] || {};
      const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
      const recvAmt = r2(a.recv_amt);
      const backAmt = r2(a.back_amt);
      const payAmt = r2(a.pay_amt);
      const doneAmt = r2(a.done_amt);
      const cnt = Number(a.cnt) || 0;

      return res.json({
        code: 0,
        data: Object.assign({}, meta, {
          kind: 'contact',
          asOf,
          contact: contact[0],
          amount: {
            recvAmt,     // 累计应收（对方欠我）
            backAmt,     // 累计已回款
            payAmt,      // 累计应付（我欠对方）
            doneAmt,     // 累计已付款
            // 与 recalcBalance 同一算式：3 − 5 − 4 + 6
            balance: r2(recvAmt - backAmt - payAmt + doneAmt)
          },
          count: cnt,
          transactions,
          // 明细超过上限时如实说明，别让对方以为这就是全部
          truncated: Math.max(0, cnt - transactions.length)
        })
      });
    }

    // type=1 每日汇总
    const day = share.data_day;
    const [sum] = await pool.query(
      'SELECT COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END), 0) AS income, ' +
      'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END), 0) AS expense, COUNT(*) AS cnt ' +
      'FROM transactions WHERE user_id = ? AND status = 1 AND record_date = ?',
      [share.user_id, day]
    );
    const [details] = await pool.query(
      'SELECT t.id, t.type, t.amount, t.content, t.qty, t.unit, t.unit_price, t.pay_method, ' +
      "DATE_FORMAT(t.record_date, '%Y-%m-%d') AS record_date, t.created_at, c.name AS contact_name " +
      'FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id ' +
      'WHERE t.user_id = ? AND t.status = 1 AND t.record_date = ? ' +
      'ORDER BY t.created_at DESC, t.id DESC LIMIT ' + MAX_DETAILS,
      [share.user_id, day]
    );
    const inc = Number(sum[0].income);
    const exp = Number(sum[0].expense);

    res.json({
      code: 0,
      data: Object.assign({}, meta, {
        kind: 'report',
        label: '每日汇总',
        from: day,
        to: day,
        income: inc,
        expense: exp,
        net: Math.round((inc - exp) * 100) / 100,
        count: Number(sum[0].cnt),
        details,
        truncated: 0
      })
    });
  } catch (err) {
    log.error('获取分享内容失败:', err.message);
    res.json({ code: 500, msg: '获取分享内容失败' });
  }
});

/* GET /share/mine 已删除（2026-09-19 审计）。
   它是给「我分享过哪些」列表页预留的，那个页面一直没做，前端零调用。
   真要做那个页面时再加回来 —— 留着一段没人跑的代码，只会让下次审计多一个要核对的问号。 */

module.exports = router;

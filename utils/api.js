/**
 * API 层 —— 全部走云托管 + yibang-realtime
 *
 * 2026-10-09。腾讯云开发版 + 实时语音通道。
 *
 * 🔴 与上一版（cloudbase-version）相比的变化：
 *   · 加了 _realtimeBase() —— 实时语音通道的 WSS 地址
 *   · 加了 ttsSynthesize() —— TTS 朗读
 *   · chat() 现在支持 voice 输入（ASR 转写后的文本）
 *
 * ⚠️ 所有请求都先 ensureOpenId() —— 拿不到 openid 就等于没有租户，
 * 服务端会一律返回 401。与其让服务端报错，不如在这里就说清原因。
 *
 * ── yibang-realtime WSS 地址怎么填 ──
 *   部署完 yibang-realtime 容器后，在 CloudBase 控制台 → 云托管 → 服务详情 →
 *   「访问入口」里能看到 HTTPS 地址。把 https 换成 wss 填到下面。
 *   例如：https://yibang-realtime-dtzai-d4gg0x0uf147b4584.ap-shanghai.run.tcloudbase.com
 *        → wss://yibang-realtime-dtzai-d4gg0x0uf147b4584.ap-shanghai.run.tcloudbase.com
 */
/* ── 2026-10-16：后端搬到自有服务器（阿里云 ECS）─────────────
 * 基地址 = api.dtzai.cn 的 /cb/ 前缀（域名已在小程序合法域名名单，零白名单操作）。
 * 身份 = /api/wx-login 换来的 JWT（app.ensureToken()），不再是云托管网关注入的 openid。 */
const API_BASE = 'https://api.dtzai.cn/cb/';

/* ⚠️ 实时语音 WSS 走已备案域名的 /rt/ 代理（nginx 上已有这条转发）。
 *   旧值是云托管裸域名 —— socket 合法域名加不进去，真机必挂，所以必须走代理。 */
const REALTIME_BASE = 'wss://api.dtzai.cn/rt';

/** 调自有服务器后端。统一在这里处理错误，各页面就不用各写一遍。 */
function call(path, method, data, opts) {
  const app = getApp();
  const o = opts || {};
  const ms = o.timeout || 20000;
  return app.ensureToken().then(({ token }) => new Promise((resolve, reject) => {
    /* 🔴 2026-10-17 自建看门狗（比 wx.request 的 timeout 更硬）。
       实测证据：服务端 16.1 秒就把结果算完返回了（日志 OK rows=19 用时16111ms），
       手机侧却既不 success 也不 fail，界面转了 129 秒还在转 ——
       wx.request 的 timeout 设成 45s 根本没触发。"半开连接"（手机切网/断网，
       此时微信正开着视频通话）下这个现象是真实的，所以不能只靠框架的 timeout。
       这里用自己的 setTimeout 兜底：到点必定 settle 一次，界面绝不无限转圈。 */
    let settled = false;
    const wd = setTimeout(() => {
      if (settled) return;
      settled = true;
      const e = new Error('等了 ' + Math.round(ms / 1000) + ' 秒没收到服务端回应（连接疑似掉线，服务端可能已经算完了）');
      e.netFail = true;
      e.hint = e.message;
      e.watchdog = true;
      reject(e);
    }, ms + 5000);

    /* 迟到的回调一律忽略，避免 success/fail 各来一次把栈打乱 */
    const wrap = (fn) => (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(wd);
      fn(v);
    };

    wx.request({
      url: API_BASE + String(path).replace(/^\//, ''),
      method: method || 'GET',
      data: data || {},
      /* 框架侧超时（第一道闸）。默认 20s，个别慢接口可传 opts.timeout 放宽。
         起因：真机上手机侧网络一断，请求既不 success 也不 fail，一路挂到默认 60s 才报错 ——
         期间界面停在「正在算…」，老板以为小程序死了。
         ⚠️ 拍照识票（parseReceipt）例外：服务端跑视觉大模型，实测小图 3s、
            手写整页要 16s 左右，配 20s 会把「本来能成」的请求掐掉，故单独放宽到 45s。
         ⚠️ 但它**不可靠**（见上面的看门狗注释），所以真正的兜底是那个 setTimeout。 */
      timeout: ms,
      header: {
        'content-type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      success: wrap((res) => {
        const body = res.data;
        if (!body) return reject(new Error('服务返回空（可能部署还没完成）'));
        if (body.code !== 0) {
          /* 🔴 如实抛错，不吞掉也不替换成友好文案——
             调用方需要知道"是 401 还是 500"，两者处理方式完全不同。 */
          const e = new Error(body.msg || ('接口返回 ' + body.code));
          e.code = body.code;
          if (body.code === 401) {
            /* 令牌失效（过期/换设备）→ 清本地登录态，下次请求自动重新登录 */
            app.clearAuth();
          }
          return reject(e);
        }
        resolve(body.data);
      }),
      /* 失败原因要能一眼看出是「没网/域名没白名单」还是「服务端挂了」——
         errMsg 形如 "request:fail timeout" / "request:fail url not in domain list"，
         原文带出来，别用"网络请求失败"四个字糊掉。 */
      fail: wrap((res) => {
        const raw = (res && res.errMsg) || '';
        const e = new Error(raw || '网络请求失败');
        e.netFail = true;
        if (/timeout/i.test(raw)) e.hint = '请求超时：手机网络不通';
        else if (/not in domain list/i.test(raw)) e.hint = '域名未加白名单：请在小程序后台配置 request 合法域名';
        return reject(e);
      })
    });
  }));
}

function _realtimeBase() { return REALTIME_BASE; }

/* ═══════════════ 业务 ═══════════════ */

function getToday()          { return call('api/today'); }

/**
 * 取主体信息（名称 + 领域）；传 name/industry 则顺带设置（首次引导 / 改名用）。
 *
 * ⚠️ 字段名沿用了后端的 shops / industry（表已存在，改名要迁移），
 *    但语义是**通用主体**：小店 / 公司 / 团队 / 项目都算。
 * ⚠️ 传空串 = 不改（后端把空值当"不修改"，避免误清空已有名称）。
 * @param {string} [name]
 * @param {string} [industry]
 */
function getShop(name, industry) {
  const body = {};
  if (name != null) body.name = name;
  if (industry != null) body.industry = industry;
  return call('api/shop', 'POST', body);
}

function getExperts()        { return call('api/experts'); }

function health()            { return call('api/health'); }

/* ═══════════════ AI 对话（支持语音转写后入账）═══════════════ */

/**
 * 问账房（方案 D · 对话驱动）
 * @param {string} question 用户原话（ASR 转写或键盘输入）
 * @param {string} [expert] 专家 code（默认 'bookkeeper'）
 * @param {{withTTS?:boolean, voice?:string, sessionId?:string, history?:Array}} [opts]
 *   sessionId: 长上下文会话 ID
 *   history: 最近 6 条对话 [{role, content}]
 */
function chat(question, expert, opts) {
  const o = opts || {};
  return call('api/chat', 'POST', {
    question,
    expert: expert || 'bookkeeper',
    withTTS: !!o.withTTS,
    voice: o.voice || undefined,
    sessionId: o.sessionId || undefined,
    history: o.history || undefined
  });
}

/* ═══════════════ 自动化 ═══════════════ */

function getAutomations()    { return call('api/automations'); }
function runAutomation(c)   { return call('api/automations/run', 'POST', { code: c }); }

/* ═══════════════ 连接器 ═══════════════ */

function getConnectors()     { return call('api/connectors'); }

/** 最近 5 笔账（语音核对"刚才那句到底记上没"用；后端 SQL 直查，毫秒级） */
function recent()            { return call('api/recent'); }

/** 动态快捷问提示词（后端按 30 天内高频+最近问过的 biz/memory 问句随机抽 4 个） */
function quicks()            { return call('api/quicks'); }
function toggleConnector(c, open) { return call('api/connectors/' + c + '/toggle', 'POST', { open: !!open }); }

/* ═══════════════ 撤销一笔（阶段四）═══════════════ */

/**
 * 撤销一笔记录（自动记账误录入兜底）。
 * @param {string|number} id 账目 ID（来自 act_record 返回的 undo 字段）
 */
function undoRecord(id) {
  return call('api/record/undo', 'POST', { id: id });
}

/**
 * 撤回撤销（5 秒内可重做刚才的撤销）。
 * @param {string|number} id 同一笔账目 ID
 */
function redoRecord(id) {
  return call('api/record/redo', 'POST', { id: id });
}

/**
 * 批量入账（OCR / 表格解析确认后用）。
 *
 * 🔴 必须一次提交、不能前端循环调 —— 循环会出现"入了 1 笔半"：
 *   确认卡说 3 笔、账上只有 1 笔，这种账最难查。后端单条 SQL 多值插入保证原子。
 *
 * @param {Array<{t:'in'|'out', amt:number, txt:string, who?:string}>} rows
 */
function saveBatch(rows) {
  return call('api/record/batch', 'POST', { rows: rows || [] });
}

/* ═══════════════ TTS 语音合成 ═══════════════ */

/**
 * 调后端合成语音。
 * @param {{text:string, voice?:string, speed?:number}} p
 *   text：要朗读的中文（≤ 150 字，超过服务端会截断）
 *   voice：音色名（13 音色白名单见 utils/tts.js）
 * @returns {Promise<{url:string, format:'mp3'|'wav'|'pcm'}>}
 */
function ttsSynthesize(p) {
  return call('api/tts/synthesize', 'POST', p || {});
}

/* ═══════════════ 长期记忆（阶段三）═══════════════ */

/**
 * 从一段对话抽取记忆（fire-and-forget）。
 * @param {{messages:Array<{role:string,content:string}>}} p
 */
function extractMemory(p) {
  return call('api/memory/extract', 'POST', {
    messages: (p && p.messages) || []
  });
}

/**
 * 「我的 → AI 记住了什么」列表。
 */
function listMemory() {
  return call('api/memory/list');
}

/**
 * 「越用越懂」摘要 —— 让老板看到 AI 学会了什么（人名/店名/原因/纠正次数）。
 * 概念参考 workbuddy 的 /memory/info，但用 WeKnora 存储做适配。
 */
function getMemoryInfo() {
  return call('api/memory/info');
}

/**
 * 一键清空老板的所有记忆（GDPR-like 被遗忘权）。
 */
function clearMemory() {
  return call('api/memory/clear', 'POST', {});
}

/**
 * 删除某一条记忆。
 * @param {string} id
 */
function deleteMemory(id) {
  return call('api/memory/delete', 'POST', { id: id });
}

/**
 * 创建分享快照（公开 token，对方不需登录可看）
 * @param {{type:1|2|3, period?, contact_name?, data_date?, expire_days?}} p
 *   type=1 每日汇总（按 data_date）
 *   type=2 客户对账（按 contact_name，钉死 as_of）
 *   type=3 区间报表（period=today/month）
 *   expire_days：1~365，默认 7
 */
function createShare(p) {
  return call('api/share/create', 'POST', p || {});
}

/**
 * 公开读分享（不需登录，token 就是凭证）
 * @param {string} token 64 位 hex
 */
function viewShare(token) {
  return call('api/share/view/' + encodeURIComponent(token));
}

/**
 * 🔴 2026-10-16 报表学习：上传样表（图/PDF/Excel 的 base64）或文字描述。
 * 后端解析文件 → LLM 抽列结构 → 存为该商家私有模板。
 * @param {{title?:string, text?:string, mime?:string, filename?:string, dataBase64?:string}} p
 */
function learnReportTemplate(p) {
  return call('api/report-template/learn', 'POST', p || {});
}

/**
 * 拍照识票据/单据（真 OCR）。
 * 图片 base64 直传后端，qwen3-vl-plus 抽成 JSON（rows + 页面合计）后解析成可入账行。
 * @param {{mime?:string, filename?:string, dataBase64:string}} p
 * @returns {Promise<{rows:Array<{t:string,txt:string,amt:number,who:string}>, raw:string,
 *   totals:{in_total:number|null,out_total:number|null,balance:number|null}|null, via:string}>}
 */
function parseReceipt(p) {
  /* 45s：视觉大模型抽整页手写账要十几秒，20s 会把能成的请求掐死（见 call 的超时注释） */
  return call('api/parse-receipt', 'POST', p || {}, { timeout: 45000 });
}

/* 🔴 2026-10-16 对齐核查：删了以下 3 个无主的 api 导出（全仓库 0 调用方）
 *   - uploadFile      /  listFiles        （后端 /api/file/* 也已删）
 *   - bindPromote                         （后端 /api/promote/bind 也已删）
 * 什么时候要恢复，从 git history 拿回。
 *
 * 🔴 2026-10-17 更正（上一版这段注释是错的，记下来免得再犯）：
 *   ① 上一版把 9 个名字列成"无主"，但其中 6 个各自被真实页面调用着，删了就是断链
 *      （按钮点了 404）：runAutomation→automations、toggleConnector→connectors、
 *      listNotifications/unreadCount/markNotificationRead/markAllNotificationsRead
 *      →notifications、profile。它们现在都还在，归属见文件末尾 module.exports。
 *      判据只有一条：`grep -r <名字> miniprogram/ --include=*.js` 能出调用方就得留着。
 *   ② 上一版还留了一句"'我的'页订阅状态有调用"，那句话也是**假的**：
 *      subscribeStatus / recordSubscribe 当时 grep 出来是 0 个调用方。
 *      现在真的接上了 —— pages/notifications 的「开启每日提醒」在调它们。
 *      教训：注释里凡是写"有谁在用"，必须能 grep 出来，否则就是自我安慰。 */

/**
 * 通知列表
 * @param {{limit?:number, offset?:number}} p
 */
function listNotifications(p) {
  const qs = [];
  if (p && p.limit) qs.push('limit=' + p.limit);
  if (p && p.offset) qs.push('offset=' + p.offset);
  return call('api/notification/list' + (qs.length ? '?' + qs.join('&') : ''));
}

/**
 * 订阅消息状态（模板是否配置 + 剩余额度）
 */
function subscribeStatus() {
  return call('api/notification/subscribe');
}

/**
 * 用户授权成功 +1 额度
 */
function recordSubscribe() {
  return call('api/notification/subscribe', 'POST', {});
}

/**
 * 我的推广进度（已邀请 paid 数 / target=2 / unlocked / list）
 * 返回里带 scene 字段，前端用这个调 wxacode 生成专属小程序码
 */
function getPromoteInfo() {
  return call('api/promote/info');
}

/* ═══════════════ 通知 · 已读 ═══════════════
 * 后端 /api/notification/unread-count · /read · /read-all 早已就绪，
 * 这里补全前端调用封装（之前在"对齐核查"里被误删导出，导致功能断链）。 */

/** 未读条数 */
function unreadCount() {
  return call('api/notification/unread-count');
}

/** 标记单条已读 */
function markNotificationRead(id) {
  return call('api/notification/read', 'POST', { id: id });
}

/** 标记全部已读 */
function markAllNotificationsRead() {
  return call('api/notification/read-all', 'POST', {});
}

module.exports = {
  /* 业务 */
  getToday, getShop, getExperts, health,
  /* AI */
  chat,
  /* 自动化 */
  getAutomations, runAutomation,
  /* 连接器 */
  getConnectors, toggleConnector,
  /* TTS */
  ttsSynthesize,
  /* 记忆 */
  extractMemory, listMemory, getMemoryInfo, clearMemory, deleteMemory,
  /* 分享 */
  createShare, viewShare, learnReportTemplate, parseReceipt,
  /* 通知 */
  listNotifications, unreadCount, markNotificationRead, markAllNotificationsRead,
  subscribeStatus, recordSubscribe,
  /* 推广 */
  getPromoteInfo,
  /* 撤销 */
  recent, quicks, undoRecord, redoRecord, saveBatch,
  /* 内部 */
  _realtimeBase
};

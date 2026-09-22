// pages/promote/promote.js
//
// 三种邀请方式，各有各的场景，不是重复功能：
//   ① 转发给好友（open-type="share"）—— 发给一个人，最常用
//   ② 转发到朋友圈（onShareTimeline）—— 发给一群人
//   ③ **分销海报**（本页新加）—— 发到微信群 / 贴店里 / 发给不在微信里的人。
//      前两种都会在微信里变成一张"卡片"，卡片里只有一个标题；
//      海报是你自己排好的一张图：有品牌、有卖点、有码，老板能直接看见"这玩意儿能干嘛"。
//
// 海报的核心是那个**专属小程序码**（scene 里带着邀请人 id）：
// 对方扫码进小程序 → app.captureInvite() 认出邀请人 → 登录成功后落到 promotions 表。
// 这条链在 2026-09-19 已经实测通了，所以海报不是"看着热闹"，是真能带上人。
const app = getApp();
const api = require('../../utils/api');
const cv = require('../../utils/canvas');

const { C, FONT, roundRect, fitText } = cv;

/* ---------------- 海报版式常量 ----------------
   planPosterHeight() 和 drawPoster() 必须用同一套数字，
   末尾会断言「实际画到的高度 == 事先算的高度」，不一致就报 drift。
   宽度取 750（= rpx 1:1），方便跟设计稿直接对照。 */
const PW = 750;           // 逻辑宽度
const PPAD = 48;          // 左右留白
const BRAND_H = 248;      // 顶部品牌卡
const VAL_H = 66;         // 每条价值点的高度
const VAL_N = 3;          // 价值点条数
const CODE = 360;         // 小程序码边长
const CODE_PAD = 40;      // 码卡内边距

// 海报上说的三句话 —— 直接对着"老板为什么不用表格"来写，不写功能名
const SELLS = [
  '说句话就记上，不用学表格',
  '买了几斤、多少钱，它自己算',
  '这个月赚了多少，问一句就知道'
];

Page({
  data: {
    loading: true,
    inviteCount: 0,
    progressPercent: 0,
    inviteList: [],
    rules: [
      '把海报发给微信好友，或让朋友扫你的码',
      '好友通过你的码注册，并购买 ¥19.9 终身版',
      '累计满 2 人，你免费解锁终身版'
    ],

    // 海报
    posterBusy: false,
    posterOpen: false,
    posterPath: '',
    posterW: PW,
    posterH: 1200        // draw 之前回填，给离屏画布一个初始尺寸
  },

  onLoad() {
    // 要同时开放「转发给好友」和「分享到朋友圈」两个入口，必须在页面里显式声明
    wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage', 'shareTimeline'] });
    this.setData({ posterH: this.planPosterHeight() });
    this.loadData();
  },

  async loadData() {
    this.setData({ loading: true });
    // 推广接口尚未上线：降级为 0，页面展示空状态而不是白屏
    const d = await api.safe(app.request('/promote/info', { silent: true }), {});
    const count = Number((d && d.inviteCount) || 0);
    const list = (d && d.list) || [];

    this.setData({
      inviteCount: count,
      progressPercent: Math.min((count / 2) * 100, 100),
      inviteList: list.map((it) => Object.assign({}, it, {
        _initial: (it.name || '友').slice(0, 1)
      })),
      loading: false
    });
  },

  /* ==================== 分销海报 ==================== */

  /** 海报上署名用谁：有店名用店名，没有就用昵称 —— 熟人看到店名才知道是谁发的 */
  posterWho() {
    const u = app.globalData.userInfo || {};
    const shop = String(u.shop_name || '').trim();
    const nick = String(u.nickname || '').trim();
    return shop || nick || '你的朋友';
  },

  /** 海报总高。drawPoster 按同样的顺序累计，末尾比对 */
  planPosterHeight() {
    let h = 8;                       // 顶部品牌细条
    h += 24;                         // 间距
    h += BRAND_H;                    // 品牌卡
    h += 40;                         // 间距
    h += VAL_N * VAL_H;              // 价值点
    h += 34;                         // 间距
    h += CODE_PAD + CODE + 74;       // 码卡：上留白 + 码 + 44(到提示文字基线) + 30(下留白)
    h += 32;                         // 间距
    h += 44;                         // 邀请语
    h += 34;                         // 间距
    h += 1 + 34;                     // 页脚横线 + 页脚文字
    h += 30;                         // 底部留白
    return h;
  },

  /**
   * 把小程序码弄成 canvas 能画的 Image。
   *
   * 后端给 base64，这里落成临时文件再交给 createImage() ——
   * base64 直接塞 img.src 在部分机型上不稳，落文件是所有机型都认的路子。
   * 同一个人的码永不变，所以本地也缓存一份，第二次不再打后端。
   */
  async loadCodeImage(canvas) {
    const fs = wx.getFileSystemManager();
    const file = wx.env.USER_DATA_PATH + '/wxacode_' + (app.globalData.userId || 0) + '.jpg';
    const exists = () => { try { fs.accessSync(file); return true; } catch (e) { return false; } };

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!exists()) {
        const d = await api.safe(api.getWxacode(), null);
        if (!d || !d.imageBase64) throw new Error('没拿到小程序码');
        fs.writeFileSync(file, d.imageBase64, 'base64');
      }
      try {
        const img = canvas.createImage();
        await new Promise((res, rej) => {
          img.onload = () => res();
          img.onerror = () => rej(new Error('decode'));
          img.src = file;
        });
        return img;
      } catch (e) {
        // 本地缓存坏了（上次写了一半 / 文件被清）→ 删掉重下一次。
        // 不删的话这张坏图会永久卡住海报，而用户只会看到「生成失败」。
        try { fs.unlinkSync(file); } catch (e2) { /* 删不掉就算了 */ }
      }
    }
    throw new Error('小程序码打不开，再试一次');
  },

  drawPoster(ctx, H, codeImg, who) {
    let y = 0;
    ctx.textBaseline = 'alphabetic';

    // 顶部品牌细条：一眼认出是易帮账本出的
    ctx.fillStyle = C.brand;
    ctx.fillRect(0, 0, PW, 8);
    y = 8;

    /* ---------- 品牌卡 ---------- */
    y += 24;
    ctx.fillStyle = C.brand;
    roundRect(ctx, PPAD, y, PW - PPAD * 2, BRAND_H, 30);
    ctx.fill();

    const cx = PW / 2;
    ctx.textAlign = 'center';

    // 「易」圆形标记 —— 没有位图 logo 也能有个辨识点
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(cx, y + 76, 44, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.brand;
    ctx.font = FONT('bold', 46);
    ctx.fillText('易', cx, y + 92);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = FONT('bold', 50);
    ctx.fillText('易帮账本', cx, y + 176);

    ctx.fillStyle = 'rgba(255,255,255,.88)';
    ctx.font = FONT('', 25);
    ctx.fillText('会思考，越用越懂你的账本', cx, y + 216);

    ctx.textAlign = 'left';
    y += BRAND_H;

    /* ---------- 价值点 ---------- */
    y += 40;
    SELLS.forEach((t) => {
      const mid = y + VAL_H / 2;
      ctx.fillStyle = C.brandWeak;
      ctx.beginPath();
      ctx.arc(PPAD + 18, mid, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.brand;
      ctx.font = FONT('bold', 22);
      ctx.textAlign = 'center';
      ctx.fillText('✓', PPAD + 18, mid + 8);
      ctx.textAlign = 'left';

      ctx.fillStyle = C.ink;
      ctx.font = FONT('', 30);
      ctx.fillText(fitText(ctx, t, PW - PPAD * 2 - 62), PPAD + 54, mid + 11);
      y += VAL_H;
    });

    /* ---------- 小程序码 ---------- */
    y += 34;
    const cardW = CODE + CODE_PAD * 2;
    const cardX = (PW - cardW) / 2;
    const cardH = CODE_PAD + CODE + 74;
    ctx.fillStyle = C.fill;
    roundRect(ctx, cardX, y, cardW, cardH, 28);
    ctx.fill();

    const codeX = cardX + CODE_PAD;
    const codeY = y + CODE_PAD;
    if (codeImg) {
      ctx.drawImage(codeImg, codeX, codeY, CODE, CODE);
    } else {
      // 没有码就**别装作有**。画个明确的空缺，比留白让人以为图坏了强。
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(codeX, codeY, CODE, CODE);
      ctx.fillStyle = C.ink3;
      ctx.font = FONT('', 26);
      ctx.textAlign = 'center';
      ctx.fillText('（小程序码没加载出来）', PW / 2, codeY + CODE / 2);
      ctx.textAlign = 'left';
    }

    ctx.fillStyle = C.ink3;
    ctx.font = FONT('', 25);
    ctx.textAlign = 'center';
    ctx.fillText('微信扫一扫，或长按识别', PW / 2, codeY + CODE + 44);
    ctx.textAlign = 'left';
    y += cardH;

    /* ---------- 邀请语 ---------- */
    y += 32;
    ctx.fillStyle = C.ink;
    ctx.font = FONT('bold', 32);
    ctx.textAlign = 'center';
    ctx.fillText(fitText(ctx, who + ' 邀请你一起用', PW - PPAD * 2), PW / 2, y + 36);
    ctx.textAlign = 'left';
    y += 44;

    /* ---------- 页脚 ---------- */
    y += 34;
    ctx.fillStyle = C.line;
    ctx.fillRect(PPAD, y, PW - PPAD * 2, 1);
    y += 34;
    ctx.fillStyle = C.ink3;
    ctx.font = FONT('', 23);
    ctx.fillText('易帮账本', PPAD, y);
    ctx.textAlign = 'right';
    ctx.fillText('说一声话就记账', PW - PPAD, y);
    ctx.textAlign = 'left';
    y += 30;

    // 自检：画出来的高度必须跟事先算的一致，否则底边会缺一块或多一块白
    if (Math.abs(y - H) > 2) {
      console.warn('[poster] 版式高度不一致：实际 ' + y + '，预算 ' + H);
    }
    return y;
  },

  async makePoster() {
    if (this.data.posterBusy) return;
    this.setData({ posterBusy: true });
    wx.showLoading({ title: '正在生成海报…', mask: true });

    const H = this.planPosterHeight();
    const dpr = cv.pickDpr(H);

    try {
      const node = await cv.getNode('#posterCanvas');
      if (!node) throw new Error('画布没准备好');

      this.setData({ posterW: PW, posterH: H });
      node.width = Math.round(PW * dpr);
      node.height = Math.round(H * dpr);
      const ctx = node.getContext('2d');
      ctx.scale(dpr, dpr);

      // 先拿码：拿不到就别画半张 —— 海报没有码就完全没有意义
      const codeImg = await this.loadCodeImage(node);

      // 白底：不铺的话 jpg 透明区会变黑
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, PW, H);
      const used = this.drawPoster(ctx, H, codeImg, this.posterWho());
      // 高度对不上不只是 console 警告：图会缺一截或多一块空白，而这是"发出去给人看"的东西
      if (Math.abs(used - H) > 2) app.beacon('poster-layout-drift', 'used=' + used + ' plan=' + H);

      const path = await cv.exportTempFile(node);
      wx.hideLoading();
      this.setData({ posterBusy: false, posterOpen: true, posterPath: path });
      app.beacon('poster', 'h=' + H + ' dpr=' + dpr);
    } catch (err) {
      wx.hideLoading();
      this.setData({ posterBusy: false });
      app.beacon('poster-fail', (err && err.message) || String(err));
      wx.showToast({ title: (err && err.message) || '海报没生成出来，再试一次', icon: 'none' });
    }
  },

  closePoster() {
    this.setData({ posterOpen: false });
  },

  /** 弹层里点空白处不该穿透到底下的按钮 */
  noop() {},

  savePoster() {
    if (!this.data.posterPath) return;
    cv.saveToAlbum(this.data.posterPath);
  },

  sharePoster() {
    if (!this.data.posterPath) return;
    cv.deliverImage(this.data.posterPath);
  },

  /**
   * 扫一扫试扫。
   * 为什么需要它：小程序页面里长按图片**识别不了码**——长按识别是微信聊天/内置浏览器的
   * 能力，小程序是自定义渲染，没有这个系统级功能。要在 App 内验证海报上的码，只能用
   * wx.scanCode。onlyFromCamera:false 让用户两种都行：相机对着另一块屏上的海报扫，
   * 或者从相册选刚保存的那张。
   * 扫出来的结果就是小程序码的 scene（inviter=<id>），顺手校验是不是本人，给个明确回话。
   */
  scanPosterCode() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => {
        const raw = String((res && res.result) || '');
        const m = /inviter=(\d+)/.exec(raw);
        const me = app.globalData.userId;
        if (m && String(m[1]) === String(me)) {
          wx.showModal({
            title: '海报没问题',
            content: '这张海报带的是你的邀请码，朋友扫了就会记在你名下。',
            showCancel: false
          });
        } else if (m) {
          wx.showModal({
            title: '扫到的是别人的码',
            content: '识别到 inviter=' + m[1] + '，当前登录的是 ' + me + '。',
            showCancel: false
          });
        } else {
          wx.showModal({ title: '扫到了', content: raw ? ('内容：' + raw) : '没识别到内容', showCancel: false });
        }
      }
      // 用户主动取消不提示——取消不是错误
    });
  },

  /* ==================== 转发 ==================== */

  onShareAppMessage() {
    const uid = app.globalData.userId || '';
    // 落在记账页而不是绑定页：好友点进来就能直接记账（合规也要求不能一进来就要手机号），
    // 邀请关系在登录成功后由 app.bindPendingInvite() 自动落库，不依赖绑定手机号。
    return {
      title: '易帮账本 · 说句话就记账，邀请你免费试用',
      path: '/pages/record/record?from=' + uid
    };
  },

  onShareTimeline() {
    return {
      title: '易帮账本 · 说句话就记账',
      query: 'from=' + (app.globalData.userId || '')
    };
  }
});

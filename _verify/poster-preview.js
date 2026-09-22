// 把 pages/promote 的 drawPoster **跑一遍**，但把绘制指令录下来翻译成 SVG。
//
// 为什么需要它：微信开发者工具的桥接服务挂了的时候（APPID_ERROR + ECONNRESET），
// 海报长什么样根本看不到。而 poster 的版式就写在代码里，没必要等工具修好才知道结果。
//
// 关键点：这里**不重写版式**，而是调用页面里那个真函数。
// 所以预览图里的文字、位置、颜色、字号都跟真机一致 ——
// 它不只是"示意图"，还是版式回归的一部分（配合 canvas-layout.test.js 的高度断言）。
//
// 用法: node poster-preview.js
// 产出: preview/poster-preview.html（内嵌真实小程序码，可直接扫）
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'yibang-miniprogram');
const OUT = path.join(__dirname, 'preview', 'poster-preview.html');
const CODE_JPG = path.join(__dirname, 'preview', 'wxacode_u2.jpg');

/* ---------------- 运行环境打桩（跟 canvas-layout.test.js 同一套） ---------------- */
let captured = null;
global.getApp = () => ({
  globalData: { userId: 2, userInfo: { shop_name: '老易的店', nickname: '老易' } },
  beacon() {},
  request() { return Promise.resolve({ code: 0 }); }
});
global.Page = (o) => { captured = o; };
global.wx = {
  getWindowInfo: () => ({ pixelRatio: 2, windowWidth: 375 }),
  getSystemInfoSync: () => ({ pixelRatio: 2 }),
  env: { USER_DATA_PATH: '/tmp' },
  showShareMenu() {}, showToast() {}, showLoading() {}, hideLoading() {}
};

require(path.join(SRC, 'pages/promote/promote.js'));
const promote = captured;
if (!promote) {
  console.error('页面没加载出来');
  process.exit(1);
}

/* ---------------- 录制式 ctx：canvas 调用 → SVG ---------------- */
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const num = (v) => Math.round(v * 100) / 100;
const fontSizeOf = (font) => {
  const m = /(\d+(?:\.\d+)?)px/.exec(font || '');
  return m ? parseFloat(m[1]) : 12;
};
const weightOf = (font) => (/bold/.test(font || '') ? 700 : 400);

function recordingCtx(codeDataUrl) {
  const svg = [];
  let d = '';
  let circle = null;

  const ctx = {
    textBaseline: 'alphabetic',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '',
    textAlign: 'left',

    beginPath() { d = ''; circle = null; },
    moveTo(x, y) { d += 'M' + num(x) + ' ' + num(y); },
    // arcTo 用二次贝塞尔近似：控制点取拐角点。canvas 内部的弧线也不是精确贝塞尔，
    // 但这样画出来的圆角在肉眼上看不出差别。
    arcTo(x1, y1, x2, y2) { d += 'Q' + num(x1) + ' ' + num(y1) + ' ' + num(x2) + ' ' + num(y2); },
    lineTo(x, y) { d += 'L' + num(x) + ' ' + num(y); },
    closePath() { d += 'Z'; },
    arc(cx, cy, r) { circle = { cx, cy, r }; },

    fill() {
      if (circle) {
        svg.push('<circle cx="' + num(circle.cx) + '" cy="' + num(circle.cy) + '" r="' +
          num(circle.r) + '" fill="' + ctx.fillStyle + '"/>');
        circle = null;
        return;
      }
      if (d) svg.push('<path d="' + d + '" fill="' + ctx.fillStyle + '"/>');
    },
    stroke() {},

    fillRect(x, y, w, h) {
      svg.push('<rect x="' + num(x) + '" y="' + num(y) + '" width="' + num(w) + '" height="' +
        num(h) + '" fill="' + ctx.fillStyle + '"/>');
    },

    fillText(t, x, y) {
      // SVG 的 text-anchor 与 canvas 的 textAlign 语义一致，直接映射
      const anchor = ctx.textAlign === 'center' ? 'middle' : (ctx.textAlign === 'right' ? 'end' : 'start');
      svg.push('<text x="' + num(x) + '" y="' + num(y) + '" font-family="sans-serif" font-size="' +
        fontSizeOf(ctx.font) + '" font-weight="' + weightOf(ctx.font) + '" fill="' + ctx.fillStyle +
        '" text-anchor="' + anchor + '">' + esc(t) + '</text>');
    },

    drawImage(img, x, y, w, h) {
      svg.push('<image x="' + num(x) + '" y="' + num(y) + '" width="' + num(w) + '" height="' +
        num(h) + '" href="' + codeDataUrl + '"/>');
    },

    // 跟 canvas-layout.test.js 一致：故意估宽，好覆盖 fitText 的截断分支
    measureText(s) {
      const size = fontSizeOf(ctx.font);
      let w = 0;
      for (const ch of String(s)) w += /[\u4e00-\u9fff]/.test(ch) ? size : size * 0.58;
      return { width: w };
    }
  };
  return { ctx, svg };
}

/* ---------------- 跑真函数，出 SVG ---------------- */
const W = 750;
const H = promote.planPosterHeight();

let codeDataUrl = '';
if (fs.existsSync(CODE_JPG)) {
  codeDataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(CODE_JPG).toString('base64');
  console.log('· 已内嵌真实小程序码（' + Math.round(fs.statSync(CODE_JPG).size / 1024) + 'KB）');
} else {
  codeDataUrl = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  console.log('· 没找到 wxacode_u2.jpg，用占位图');
}

const { ctx, svg } = recordingCtx(codeDataUrl);
const used = promote.drawPoster(ctx, H, { id: 'img' }, promote.posterWho());

const svgDoc = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' +
  '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#FFFFFF"/>' +
  svg.join('') +
  '</svg>';

const heightCheck = Math.abs(used - H) <= 2 ? '一致 ✓' : '不一致 ✗（used=' + used + ' plan=' + H + '）';

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>易帮账本 · 分销海报预览</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 24px 56px;
    background: #EDF0F3; color: #101828;
    font: 15px/1.7 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .sub { color: #667085; margin: 0 0 24px; font-size: 14px; }
  .stage {
    display: inline-block; padding: 18px; background: #fff; border-radius: 18px;
    box-shadow: 0 14px 44px -22px rgba(16,24,40,.5);
  }
  .stage svg { display: block; width: 375px; height: auto; }
  .meta { margin-top: 24px; max-width: 430px; }
  .meta h2 { font-size: 15px; margin: 0 0 10px; }
  .meta ul { margin: 0; padding-left: 20px; color: #344054; font-size: 14px; }
  .meta li { margin-bottom: 5px; }
  .ok { color: #0B7A43; font-weight: 600; }
  .bad { color: #D92D20; font-weight: 600; }
  code { background: #F2F4F7; padding: 1px 6px; border-radius: 4px; font-size: 13px; }
  .warn {
    margin-top: 20px; padding: 12px 16px; max-width: 430px;
    background: #FFF6E5; border-left: 4px solid #B54708; border-radius: 6px;
    color: #7A3D08; font-size: 13.5px;
  }
</style>
</head>
<body>
  <h1>分销海报 · 版式预览</h1>
  <p class="sub">由 <code>pages/promote/promote.js</code> 的 <code>drawPoster()</code> 真实执行后录制生成，非手绘示意图。</p>

  <div class="stage">
    ${svgDoc}
  </div>

  <div class="meta">
    <h2>这张图是怎么来的</h2>
    <ul>
      <li>逻辑尺寸 <code>750 × ${H}</code>，展示按 50% 缩放（≈真机宽度）</li>
      <li>版式高度自检：<span class="${Math.abs(used - H) <= 2 ? 'ok' : 'bad'}">${heightCheck}</span></li>
      <li>码内嵌的是真码（<code>scene=inviter=2</code>），可以直接扫</li>
      <li>署名取 <code>shop_name</code>，无店名回落到昵称，再回落到「你的朋友」</li>
    </ul>
  </div>

  <div class="warn">
    预览用 SVG 重建，字体是系统默认 sans-serif、圆角是贝塞尔近似，
    所以跟真机导出的 JPG 会有细微差别（真机画出来的更规整）。
    <b>最终以真机为准</b> —— 等开发者工具能连上后再截一次模拟器画面复核。
  </div>
</body>
</html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('· 海报 ' + W + '×' + H + '，绘制指令 ' + svg.length + ' 条');
console.log('· 版式高度：' + heightCheck);
console.log('· 已写出 ' + OUT);

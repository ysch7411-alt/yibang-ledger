// utils/canvas.js —— 「把一屏内容变成一张能发出去的图」的公共零件
//
// 用在两处：报表图（pages/summary）、分销海报（pages/promote）。
// 这些坑都踩过一遍了，别再在页面里各写一份：
//   · 2d canvas 用 display:none 拿不到 node，画不出来 —— 必须 position:fixed 挪到屏幕外
//   · 导出像素高有上限（超了部分机型直接出白图），所以 dpr 要按高度反算，不能照抄手机 dpr
//   · canvas 没有 CSS 的 ellipsis，超宽要自己按 measureText 截
//   · 微信里「把图发给别人」优先 showShareImageMenu；它不存在（老基础库）或失败时退回存相册。
//     用户取消了不算失败，不能弹「没存上」——那是自己错怪用户。

const MAX_PIXELS = 4000;   // 输出像素高的上限。超了老机型会出白图。

/**
 * 画布上的配色。跟 app.wxss 的 page{} 令牌一一对应 ——
 * canvas 里读不到 CSS 变量，只能在这里同步一份；改主题色时**两边都要改**。
 */
const C = {
  ink: '#101828',        // --t1
  ink2: '#344054',       // --t2
  ink3: '#667085',       // --t3（正文灰下限）
  line: '#EDF0F3',       // --line
  fill: '#F6F7F9',       // --bg
  brand: '#C9451A',      // --brand-btn（白字 4.75:1）
  brandWeak: '#FFF4EE',  // --brand-weak
  income: '#0B7A43',     // --income
  expense: '#D92D20'     // --expense
};

const FONT = (weight, size) => weight + ' ' + size + 'px sans-serif';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 超宽就往回收字符，末尾加省略号 */
function fitText(ctx, text, maxW) {
  let s = String(text == null ? '' : text);
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

/**
 * 输出缩放。
 * 两条上限都要看：
 *   · 像素**高**不能太大，超出后老机型画布直接空白（所以按高度反算）
 *   · 像素**宽**也不追高 —— 750 逻辑宽 × 手机常见 dpr 3 = 2250px，
 *     图会在微信里被压、体积也大；1500px 宽（dpr≤2）对手机屏已经足够清晰
 */
function pickDpr(planH, maxPixels) {
  let dpr = 2;
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    dpr = info.pixelRatio || 2;
  } catch (e) {
    /* 拿不到就按 2 算 */
  }
  dpr = Math.max(1, Math.min(dpr, 2, (maxPixels || MAX_PIXELS) / planH));
  return Math.floor(dpr * 10) / 10;
}

/** 离屏画布必须在页面上真实存在，2d canvas 拿不到 node 就画不了 */
function getNode(selector) {
  return new Promise((resolve) => {
    wx.createSelectorQuery()
      .select(selector)
      .fields({ node: true, size: true })
      .exec((res) => resolve(res && res[0] ? res[0].node : null));
  });
}

/**
 * 把 canvas 导出成临时文件。
 * 一定要用 canvas.width / canvas.height（**像素**尺寸）而不是逻辑尺寸，
 * 否则导出的图会被裁掉一角。
 */
function exportTempFile(canvas, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
      destWidth: canvas.width,
      destHeight: canvas.height,
      fileType: o.fileType || 'jpg',
      quality: o.quality == null ? 0.92 : o.quality,
      success: (r) => resolve(r.tempFilePath),
      fail: (e) => reject(new Error((e && e.errMsg) || '导出失败'))
    });
  });
}

function saveToAlbum(path) {
  wx.saveImageToPhotosAlbum({
    filePath: path,
    success: () => wx.showToast({ title: '已存到相册，去微信发给别人', icon: 'none' }),
    fail: (err) => {
      const msg = (err && err.errMsg) || '';
      if (/auth|authorize/i.test(msg)) {
        wx.showModal({
          title: '需要相册权限',
          content: '存图要先允许保存到相册，去设置里开一下就好',
          confirmText: '去设置',
          success: (r) => { if (r.confirm) wx.openSetting(); }
        });
        return;
      }
      wx.showToast({ title: '没存上，再试一次', icon: 'none' });
    }
  });
}

/** 发到微信。接口不存在（老基础库）或失败时退回存相册，别让老板白点一下 */
function deliverImage(path) {
  if (typeof wx.showShareImageMenu !== 'function') {
    saveToAlbum(path);
    return;
  }
  wx.showShareImageMenu({
    path,
    fail: (err) => {
      const msg = (err && err.errMsg) || '';
      if (/cancel/i.test(msg)) return;   // 用户自己取消了，不算失败
      saveToAlbum(path);
    }
  });
}

module.exports = {
  MAX_PIXELS,
  C,
  FONT,
  roundRect,
  fitText,
  pickDpr,
  getNode,
  exportTempFile,
  saveToAlbum,
  deliverImage
};

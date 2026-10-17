/**
 * utils/poster.js —— 海报生成（canvas 2d → 保存到相册）
 *
 * 2026-10-15。
 *
 * 老板说"分享给老婆" / "保存为图片" 时调这里。
 * 微信小程序 canvas 2d 流程：
 *   1. wx.createOffscreenCanvas / Canvas 画图
 *   2. canvasToTempFilePath 转 PNG
 *   3. wx.saveImageToPhotosAlbum 存相册
 *
 * 配色对齐 #FF6B35 主色（与方案 D 一致）。
 */

const W = 750;   // 海报宽度（2x 屏 375）
const H = 1334;  // 海报高度（2x 屏 667）

/**
 * 生成"今日小结"海报 PNG（buffer）
 * @param {{shopName?:string, date:string, income:number, expense:number, net:number, count:number}} data
 * @returns {Promise<string>} 临时文件路径
 */
function generateDailyPoster(data) {
  return new Promise((resolve, reject) => {
    const canvas = wx.createOffscreenCanvas ? wx.createOffscreenCanvas({ type: '2d', width: W, height: H }) : wx.createCanvas();
    const ctx = canvas.getContext('2d');

    // 背景渐变
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#FF6B35');
    grad.addColorStop(0.4, '#F45B22');
    grad.addColorStop(0.5, '#FAFAF7');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 顶部标题区
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 56px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('易帮AI · 今日小结', W / 2, 100);

    ctx.font = '32px -apple-system, "PingFang SC", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText(data.shopName || '你的店', W / 2, 160);

    ctx.font = '28px -apple-system, "PingFang SC", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(data.date, W / 2, 210);

    // 白色卡片
    const cx = 60, cy = 280, cw = W - 120, ch = 760;
    _roundRect(ctx, cx, cy, cw, ch, 24);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.shadowColor = 'rgba(0,0,0,0.1)';
    ctx.shadowBlur = 20;
    ctx.fill();
    ctx.shadowBlur = 0;

    // 大字：净余
    ctx.fillStyle = '#888';
    ctx.font = '32px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('今日净余', W / 2, cy + 80);

    const netColor = data.net >= 0 ? '#1a7f4a' : '#B04848';
    const netSign = data.net >= 0 ? '+' : '';
    ctx.fillStyle = netColor;
    ctx.font = 'bold 120px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(netSign + '¥' + _fmt(data.net), W / 2, cy + 230);

    // 收入 / 支出
    ctx.font = '32px -apple-system, "PingFang SC", sans-serif';
    ctx.fillStyle = '#888';
    ctx.textAlign = 'left';
    ctx.fillText('收入', cx + 50, cy + 320);
    ctx.fillText('支出', cx + cw - 200, cy + 320);
    ctx.font = 'bold 52px -apple-system, "PingFang SC", sans-serif';
    ctx.fillStyle = '#1a7f4a';
    ctx.fillText('¥' + _fmt(data.income), cx + 50, cy + 380);
    ctx.fillStyle = '#B04848';
    ctx.fillText('¥' + _fmt(data.expense), cx + cw - 200, cy + 380);

    // 笔数
    ctx.fillStyle = '#888';
    ctx.font = '28px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('共记账 ' + (data.count || 0) + ' 笔', W / 2, cy + 470);

    // 分割线
    ctx.strokeStyle = '#F0EBE5';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + 40, cy + 510);
    ctx.lineTo(cx + cw - 40, cy + 510);
    ctx.stroke();

    // 二维码占位（真后端接通了用 /api/promote/wxacode）
    ctx.fillStyle = '#F5F0EB';
    _roundRect(ctx, W / 2 - 90, cy + 550, 180, 180, 12);
    ctx.fill();
    ctx.fillStyle = '#888';
    ctx.font = '24px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('扫码查看', W / 2, cy + 650);
    ctx.font = '22px -apple-system, "PingFang SC", sans-serif';
    ctx.fillStyle = '#A79C92';
    ctx.fillText('（真后端接通后', W / 2, cy + 690);
    ctx.fillText('会自动换成专属码）', W / 2, cy + 720);

    // 底部品牌
    ctx.fillStyle = '#FF6B35';
    ctx.font = 'bold 36px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('越用越懂 · 说话即记账', W / 2, H - 120);

    ctx.fillStyle = '#A79C92';
    ctx.font = '24px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText('易帮AI v2 · ' + new Date().toISOString().slice(0, 10), W / 2, H - 70);

    // 转 PNG
    wx.canvasToTempFilePath({
      canvas,
      success: (r) => resolve(r.tempFilePath),
      fail: (e) => reject(new Error('canvasToTempFilePath 失败：' + (e && e.errMsg || '')))
    });
  });
}

/**
 * 调 wx.saveImageToPhotosAlbum
 * @param {string} filePath
 */
function saveToAlbum(filePath) {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => resolve(),
      fail: (e) => reject(new Error('保存失败：' + (e && e.errMsg || '用户拒绝授权')))
    });
  });
}

/**
 * 一站式：生成 + 保存
 */
async function generateAndSave(data) {
  const fp = await generateDailyPoster(data);
  await saveToAlbum(fp);
  return fp;
}

/* ── 内部工具 ── */

function _fmt(n) {
  // 千分位 + 2 位小数
  const num = Number(n) || 0;
  return num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

module.exports = { generateDailyPoster, saveToAlbum, generateAndSave };

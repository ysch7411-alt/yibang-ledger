// 一次性脚本：生成缺失的 SVG 图标 + 把 WXML 里的 emoji 全部替换为本地 SVG
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2];
const IMG = path.join(ROOT, 'images');

const svg = (inner, stroke = '#98A2B3') =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="' +
  stroke +
  '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>\n';

const ICONS = {
  // 通用空状态：文档 + 文本行
  'ic-empty': '<rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><path d="M8.5 9h7"/><path d="M8.5 13h7"/><path d="M8.5 17h4"/>',
  'ic-user': '<circle cx="12" cy="8" r="3.6"/><path d="M4.9 20.2c0-3.5 3.2-5.7 7.1-5.7s7.1 2.2 7.1 5.7"/>',
  'ic-people': '<circle cx="9" cy="8" r="3.2"/><path d="M3.6 19.6c0-3 2.4-4.9 5.4-4.9s5.4 1.9 5.4 4.9"/><path d="M16.2 5.5a3.2 3.2 0 0 1 0 5.1"/><path d="M17.6 15c1.8.7 2.9 2.2 2.9 4.1"/>',
  'ic-card': '<rect x="2.6" y="5.6" width="18.8" height="12.8" rx="2.6"/><path d="M2.6 10.1h18.8"/><path d="M6.2 14.6h4"/>',
  'ic-megaphone': '<path d="M4 10.4v3.2A1.6 1.6 0 0 0 5.6 15.2H7l7.4 3.6V5.2L7 8.8H5.6A1.6 1.6 0 0 0 4 10.4z"/><path d="M7 15.2v3.4A1.6 1.6 0 0 0 8.6 20.2h.6"/><path d="M17.8 9.4a4 4 0 0 1 0 5.2"/>',
  'ic-gear': '<circle cx="12" cy="12" r="3.1"/><path d="M12 3.4v2.3"/><path d="M12 18.3v2.3"/><path d="M20.6 12h-2.3"/><path d="M5.7 12H3.4"/><path d="M18.1 5.9l-1.6 1.6"/><path d="M7.5 16.5l-1.6 1.6"/><path d="M18.1 18.1l-1.6-1.6"/><path d="M7.5 7.5L5.9 5.9"/>',
  'ic-info': '<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5.6"/><path d="M12 7.9v.6"/>',
  'ic-clock': '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2V12l3.4 2"/>',
  'ic-camera': '<path d="M4 8.6h3l1.5-2.1h7L17 8.6h3a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 20 19.4H4a1.5 1.5 0 0 1-1.5-1.5v-7.8A1.5 1.5 0 0 1 4 8.6z"/><circle cx="12" cy="13.4" r="3.5"/>',
  'ic-image': '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.6"/><circle cx="9" cy="10" r="1.8"/><path d="M4 16.6l4.6-4.1 3.9 3.4 3-2.5 4.5 4"/>',
  'ic-folder': '<path d="M3.4 7.6a2 2 0 0 1 2-2h3.7l2 2.4h7.5a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9.8z"/>',
  'ic-pencil': '<path d="M4 20l4.2-.9L19.6 7.7a1.9 1.9 0 0 0 0-2.7l-.6-.6a1.9 1.9 0 0 0-2.7 0L4.9 15.8 4 20z"/><path d="M14.9 6.3l2.8 2.8"/>',
  'ic-sparkle': '<path d="M10.4 3.6l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5 1.5-4z"/><path d="M17.6 14.4l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z"/>'
};

// 1. 写图标
if (!fs.existsSync(IMG)) fs.mkdirSync(IMG, { recursive: true });
Object.keys(ICONS).forEach((n) => {
  fs.writeFileSync(path.join(IMG, n + '.svg'), svg(ICONS[n]));
});
console.log('生成图标 ' + Object.keys(ICONS).length + ' 个');

// 2. WXML 替换
const P = (p) => path.join(ROOT, p);
const edits = [
  // 空状态：统一为一个中性图标
  ['pages/advisor/advisor.wxml', /<view class="empty-ico">[\s\S]*?<\/view>/g,
    ['<image class="empty-ico" src="/images/ic-empty.svg" mode="aspectFit" />']],
  ['pages/contact-detail/contact-detail.wxml', /<view class="empty-ico">[\s\S]*?<\/view>/g,
    ['<image class="empty-ico" src="/images/ic-empty.svg" mode="aspectFit" />']],
  ['pages/pending/pending.wxml', /<view class="empty-ico">[\s\S]*?<\/view>/g,
    ['<image class="empty-ico" src="/images/ic-empty.svg" mode="aspectFit" />']],
  ['pages/promote/promote.wxml', /<view class="empty-ico">[\s\S]*?<\/view>/g,
    ['<image class="empty-ico" src="/images/ic-empty.svg" mode="aspectFit" />']],
  ['pages/staff/staff.wxml', /<view class="empty-ico">[\s\S]*?<\/view>/g,
    ['<image class="empty-ico" src="/images/ic-empty.svg" mode="aspectFit" />']],
  ['pages/summary/summary.wxml', /<view class="empty-ico">[\s\S]*?<\/view>/g,
    ['<image class="empty-ico" src="/images/ic-empty.svg" mode="aspectFit" />']],
  ['pages/search/search.wxml', /<view class="empty-ico">🔍<\/view>/g,
    ['<image class="empty-ico" src="/images/ic-empty.svg" mode="aspectFit" />']],
  // 问 AI 的引导：用星标
  ['pages/search/search.wxml', /<view class="empty-ico">💡<\/view>/g,
    ['<image class="empty-ico" src="/images/ic-sparkle.svg" mode="aspectFit" />']],
  // 记账的空状态
  ['pages/record/record.wxml', /<view class="empty-ico">[\s\S]*?<\/view>/g,
    ['<image class="empty-ico" src="/images/ic-empty.svg" mode="aspectFit" />']],
  // 加号面板四个入口
  ['pages/record/record.wxml', /<view class="plus-ico">📷<\/view>/,
    ['<view class="plus-ico"><image class="plus-ico-img" src="/images/ic-camera.svg" mode="aspectFit" /></view>']],
  ['pages/record/record.wxml', /<view class="plus-ico">🖼️<\/view>/,
    ['<view class="plus-ico"><image class="plus-ico-img" src="/images/ic-image.svg" mode="aspectFit" /></view>']],
  ['pages/record/record.wxml', /<view class="plus-ico">📁<\/view>/,
    ['<view class="plus-ico"><image class="plus-ico-img" src="/images/ic-folder.svg" mode="aspectFit" /></view>']],
  ['pages/record/record.wxml', /<view class="plus-ico">✏️<\/view>/,
    ['<view class="plus-ico"><image class="plus-ico-img" src="/images/ic-pencil.svg" mode="aspectFit" /></view>']],
  // AI 填表条标题
  ['pages/record/record.wxml', /<text class="ai-bar-title">🤖 说一句，我帮你填<\/text>/,
    ['<view class="ai-bar-l"><image class="ai-bar-ico" src="/images/ic-sparkle.svg" mode="aspectFit" />',
     '<text class="ai-bar-title">说一句，我帮你填</text></view>']],
  // 查页 AI 入口
  ['pages/search/search.wxml', /<view class="ai-entry-ico">🤖<\/view>/,
    ['<image class="ai-entry-ico" src="/images/ic-sparkle.svg" mode="aspectFit" />']],
  // 我的页
  ['pages/profile/profile.wxml', /<view class="me-avatar">👤<\/view>/,
    ['<view class="me-avatar">{{initial}}</view>']],
  ['pages/profile/profile.wxml', /<view class="row-ico">👥<\/view>/,
    ['<view class="row-ico"><image class="row-ico-img" src="/images/ic-people.svg" mode="aspectFit" /></view>']],
  ['pages/profile/profile.wxml', /<view class="row-ico">💎<\/view>/,
    ['<view class="row-ico"><image class="row-ico-img" src="/images/ic-card.svg" mode="aspectFit" /></view>']],
  ['pages/profile/profile.wxml', /<view class="row-ico">📣<\/view>/,
    ['<view class="row-ico"><image class="row-ico-img" src="/images/ic-megaphone.svg" mode="aspectFit" /></view>']],
  ['pages/profile/profile.wxml', /<view class="row-ico">⚙️<\/view>/,
    ['<view class="row-ico"><image class="row-ico-img" src="/images/ic-gear.svg" mode="aspectFit" /></view>']],
  ['pages/profile/profile.wxml', /<view class="row-ico">ℹ️<\/view>/,
    ['<view class="row-ico"><image class="row-ico-img" src="/images/ic-info.svg" mode="aspectFit" /></view>']],
  // 店员页
  ['pages/staff/staff.wxml', /<view class="av av-boss">👤<\/view>/,
    ['<view class="av av-boss">{{initial}}</view>']],
  ['pages/staff/staff.wxml', /<view class="audit-ico">⏰<\/view>/,
    ['<image class="audit-ico" src="/images/ic-clock.svg" mode="aspectFit" />']],
  // 详情页按钮：去掉 emoji，纯文字更干净
  ['pages/contact-detail/contact-detail.wxml', /📋 分享对账单/g, ['分享对账单']]
];

let changed = 0;
edits.forEach(([file, re, repl]) => {
  const full = P(file);
  const src = fs.readFileSync(full, 'utf8');
  const next = src.replace(re, repl.join('\n'));
  if (next !== src) {
    fs.writeFileSync(full, next);
    changed++;
  } else {
    console.log('!! 未命中: ' + file + ' → ' + re);
  }
});
console.log('WXML 修改 ' + changed + ' 处');

// 3. WXSS 适配（图标从文字换成图片后需要尺寸）
const css = [
  ['app.wxss', /\.empty-ico \{[\s\S]*?\}/, `.empty-ico {\n  width: 88rpx;\n  height: 88rpx;\n  display: block;\n  margin: 0 auto 24rpx;\n  opacity: .45;\n}`],
  ['app.wxss', /(\.row-ico \{[\s\S]*?\})/, `$1\n.row-ico-img {\n  width: 40rpx;\n  height: 40rpx;\n}`],
  ['pages/record/record.wxss', /(\.plus-ico \{[\s\S]*?\})/, `$1\n.plus-ico-img {\n  width: 48rpx;\n  height: 48rpx;\n}`],
  ['pages/record/record.wxss', /(\.ai-bar-hd \{[\s\S]*?\})/, `$1\n.ai-bar-l {\n  display: flex;\n  align-items: center;\n}\n.ai-bar-ico {\n  width: 30rpx;\n  height: 30rpx;\n  margin-right: 8rpx;\n}`],
  ['pages/search/search.wxss', /\.ai-entry-ico \{[\s\S]*?\}/, `.ai-entry-ico {\n  width: 44rpx;\n  height: 44rpx;\n  margin-right: 20rpx;\n}`],
  ['pages/staff/staff.wxss', /\.audit-ico \{[\s\S]*?\}/, `.audit-ico {\n  width: 44rpx;\n  height: 44rpx;\n  margin-right: 22rpx;\n}`]
];
let cssChanged = 0;
css.forEach(([file, re, out]) => {
  const full = P(file);
  const src = fs.readFileSync(full, 'utf8');
  if (!re.test(src)) {
    console.log('!! CSS 未命中: ' + file + ' → ' + re);
    return;
  }
  fs.writeFileSync(full, src.replace(re, out));
  cssChanged++;
});
console.log('WXSS 修改 ' + cssChanged + ' 处');

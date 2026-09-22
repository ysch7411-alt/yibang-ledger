/**
 * _verify/audit-actionsheet.js —— 扫全站 wx.showActionSheet 的项数与 fail 回调
 *
 * 为什么专门扫这个：wx.showActionSheet 的 itemList **数组长度最大为 6**（官方文档），
 * 超出会直接失败。如果不写 fail 回调，失败是**完全静默**的 ——
 * 用户点了没反应，开发者也看不到任何日志。2026-09-22 在"我的页营业日截止时间"
 * 上踩了这个坑（传了 7 项，点了毫无反应）。
 *
 * ⚠️ 第一版只数**内联数组**（itemList: [...]），把 `itemList: options` 这种
 *    写成变量的情况直接跳过 → 漏报了 pages/account 里同样 7 项的那一处，
 *    害我给出了"全站只有一处超限"的错误结论。
 *    现在会顺着同名 const 把数组找出来再数；解析不出来就明确标"需人工确认"，
 *    **宁可报未知，也不报一个假的"通过"**。
 *
 * 用法： node _verify/audit-actionsheet.js <小程序目录>
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || 'yibang-miniprogram';
const MAX = 6;

function walk(d, acc = []) {
  for (const f of fs.readdirSync(d)) {
    if (f === 'node_modules' || f === '.git') continue;
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/**
 * 扫之前**先剥注释**。
 * 这个坑项目里栽过五次了：解释性注释里往往正好写着要查的那段代码 ——
 * 比如 account.js 里解释"为什么删掉营业日那两段"的注释中，
 * 原文引用了 `wx.showActionSheet({ itemList: [7 个选项] })`，
 * 于是扫描把注释当成了真代码，报出一处并不存在的"超限/无 fail"。
 * 注意别把字符串字面量里的 // 当成注释起点（简易处理：只在引号外切）。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      if (ch === '\\') { out += ch + (next || ''); i += 2; continue; }
      if (ch === quote) quote = null;
      out += ch; i++; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i++; continue; }
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; continue;
    }
    out += ch; i++;
  }
  return out;
}

/** 从 `[` 开始配对出整个数组字面量，返回顶层项数 */
function countArrayLiteral(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') {
      depth--;
      if (!depth) {
        const inner = src.slice(openIdx + 1, i);
        return inner.split(',').map((x) => x.trim()).filter(Boolean).length;
      }
    }
  }
  return -1;
}

/** 顺着 identifier 找同文件里的 `const NAME = [...]` */
function resolveIdent(src, name) {
  const re = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*\\[');
  const m = re.exec(src);
  if (!m) return -1;
  const open = src.indexOf('[', m.index);
  return countArrayLiteral(src, open);
}

const files = walk(ROOT).filter((f) => f.endsWith('.js'));
let bad = 0, unknown = 0, total = 0;

for (const f of files) {
  // 剥掉注释再扫：注释里引用的示例代码不是真代码
  const s = stripComments(fs.readFileSync(f, 'utf8'));
  const re = /wx\.showActionSheet\(\s*\{/g;
  let m;
  while ((m = re.exec(s))) {
    const seg = s.slice(m.index, m.index + 1200);
    const li = seg.indexOf('itemList');
    if (li < 0) continue;
    const colon = seg.indexOf(':', li);
    if (colon < 0) continue;
    const after = seg.slice(colon + 1);
    const trimmed = after.trim();

    let count = -1;
    if (trimmed[0] === '[') {
      count = countArrayLiteral(seg, colon + 1 + after.indexOf('['));
    } else {
      const idM = /^([A-Za-z_$][\w$]*)/.exec(trimmed);
      if (idM) count = resolveIdent(s, idM[1]);
    }

    const hasFail = /fail\s*[:(]/.test(seg);
    total++;
    const tag = count < 0 ? '❓ 未知' : (count > MAX ? '❌ 超限' : '✅     ');
    if (count < 0) unknown++;
    if (count > MAX) bad++;
    console.log(
      tag + '  ' + f.replace(/\\/g, '/') +
      '  → ' + (count < 0 ? '解析不出项数（需人工确认）' : count + ' 项') +
      '  ' + (hasFail ? '有 fail 回调' : '⚠️ 无 fail 回调（失败会静默）')
    );
  }
}

console.log('\n共 ' + total + ' 处 showActionSheet；超限 ' + bad + ' 处；解析不出 ' + unknown + ' 处');
if (unknown) console.log('⚠️ 有解析不出的，别当成"通过" —— 手工看一眼上面标 ❓ 的。');
process.exit(bad ? 1 : 0);

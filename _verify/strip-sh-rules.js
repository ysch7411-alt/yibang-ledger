// _verify/strip-sh-rules.js —— 把 record / summary 两页里的 .sh-* 规则块摘掉
//
// 背景：分享报表弹层的 .sh-* 样式在记账页与报表页各写了一份（10 个选择器），
// 已经漂移了 6 个（一个用 var(--t3)、一个用 #667085；一个有 line-height、一个没有）。
// 现在把定义合并到 app.wxss（.sh-* 被 ≥2 个页面用到 → 按项目约定就该住在公共层）。
//
// 本脚本只负责"从页面里摘掉"，摘下来的内容已人工合并进 app.wxss。
// 规则：删除 .sh-* 规则块；**紧贴在它前面的注释块也一起删**（那些注释是在解释这些规则，
// 留着会变成没有归属的孤儿注释）。
//
// 用法： node _verify/strip-sh-rules.js <小程序目录> [--dry]

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || 'yibang-miniprogram';
const DRY = process.argv.includes('--dry');
const FILES = ['pages/record/record.wxss', 'pages/summary/summary.wxss'];

for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  const src = fs.readFileSync(p, 'utf8');
  // 按规则块切分：每块 = 选择器 + { ... }
  const re = /([^\n{}]*\.sh-[a-z-]+(?:\.[a-z-]+)?[^\n{}]*)\{([^{}]*)\}/g;
  const ranges = [];
  let m;
  while ((m = re.exec(src))) {
    let start = m.index;

    /* 把紧邻在上方、中间无空行的注释块也纳入删除范围。
       ⚠️ 这里踩过一次大坑：最初写的是 before.match(/(星号+斜杠 开头[\s\S]*?\*\/\s*)$/)，
       想"往前找最近的注释"，但 [\s\S]*? 配 $ 锚点会一路回溯 ——
       只要文件里存在任意一个块注释并且后面还有内容，它就能从头匹配上，
       于是 start 变成 0，**整个文件被判定为删除范围**。
       试运行显示 record.wxss 会从 886 行变成 3 行，才发现的。
       → 正确做法：只往回跳"缩进 + 一个换行"，确认正好落在注释结束符上，再找配对的开头。
       （注意：这段说明里不能出现真正的注释定界符 —— 会把这个块注释提前闭合，
         写这段话的时候已经栽过一次，node 直接报 SyntaxError。） */
    let s = start;
    while (s > 0 && /[ \t]/.test(src[s - 1])) s--;
    if (src[s - 1] === '\n') {
      const t = s - 1;
      if (src.slice(t - 2, t) === '*/') {
        const open = src.lastIndexOf('/*', t - 2);
        if (open >= 0) start = open;
      }
    }
    ranges.push([start, m.index + m[0].length]);
  }
  if (!ranges.length) { console.log(`   ${rel} 无 .sh-* 规则`); continue; }

  let out = src;
  for (let i = ranges.length - 1; i >= 0; i--) {
    out = out.slice(0, ranges[i][0]) + out.slice(ranges[i][1]);
  }
  // 收拾连续空行
  out = out.replace(/\n{3,}/g, '\n\n');

  console.log(`${DRY ? '[dry] ' : '✅ '}${rel}  摘掉 ${ranges.length} 个 .sh-* 规则块，行数 ${src.split('\n').length} → ${out.split('\n').length}`);
  if (!DRY) fs.writeFileSync(p, out, 'utf8');
}

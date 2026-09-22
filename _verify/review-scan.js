/**
 * _verify/review-scan.js —— 代码审查用的静态扫描
 *
 * 🔴 为什么必须先剥注释：**解释性注释里往往正好写着那个"不许出现"的写法**。
 *    比如项目里到处都有「禁止 `Number(type) || 2`」这类反面教材注释，
 *    直接 grep 会把它们全部当成违规命中 —— 这个库上因此连栽过 6 次。
 *    所以本文件里所有断言都跑在 stripComments() 之后的内容上。
 *
 * 用法：node _verify/review-scan.js <项目根目录>
 */
const fs = require('fs');
const path = require('path');

/* ---------------- 剥注释（JS / WXML / WXSS 通用）----------------
   🔴 **必须保留换行**：注释被删掉多少行，后面所有行号就偏多少 ✗
      第一版没做这件事，报出来的行号全是错的（指到了 AI 提示词文本上），
      **带错行号的审查报告会把人也带沟里** —— 比不报还坏。
      所以注释内容一律替换成等量的空白/换行，只保证"行号一一对应"。
   同理，**不处理字符串/模板串的内容**（只做注释剥离），
   —— 但为了行号准确，字符串里的换行要原样保留。 */
function stripComments(src, ext) {
  const keepNewlines = (text) => text.replace(/[^\n]/g, ' ');
  let s = src;
  if (ext === '.js') {
    let out = '';
    let i = 0, state = null;
    while (i < s.length) {
      const c = s[i], n = s[i + 1];
      if (state === null) {
        if (c === '/' && n === '/') { state = '//'; out += '  '; i += 2; continue; }
        if (c === '/' && n === '*') { state = '/*'; out += '  '; i += 2; continue; }
        if (c === "'" || c === '"' || c === '`') { state = c; out += c; i++; continue; }
        out += c; i++; continue;
      }
      if (state === '//') { if (c === '\n') { state = null; out += c; } else out += ' '; i++; continue; }
      if (state === '/*') {
        if (c === '*' && n === '/') { state = null; out += '  '; i += 2; }
        else { out += (c === '\n' ? c : ' '); i++; }
        continue;
      }
      // 字符串 / 模板串内部：原样保留（但换行必须留着，否则行号漂）
      if (c === '\\') { out += c + (n || ''); i += 2; continue; }
      if (c === state) state = null;
      out += c; i++;
    }
    return out;
  }
  return s
    .replace(/<!--[\s\S]*?-->/g, keepNewlines)
    .replace(/\/\*[\s\S]*?\*\//g, keepNewlines);
}

function walk(dir, exts, acc) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, exts, acc);
    else if (exts.includes(path.extname(name))) acc.push(p);
  }
  return acc;
}

const ROOT = process.argv[2] || '.';
const files = walk(ROOT, ['.js', '.wxml', '.wxss'], []);
const cleaned = files.map((f) => {
  const src = fs.readFileSync(f, 'utf8');
  return { f: path.relative(ROOT, f).replace(/\\/g, '/'), raw: src, code: stripComments(src, path.extname(f)) };
});

const issues = [];
const add = (level, cls, file, line, msg) => issues.push({ level, cls, file, line, msg });
function scan(re, level, cls, msg, filter) {
  for (const { f, code } of cleaned) {
    const lines = code.split('\n');
    lines.forEach((l, i) => {
      if (re.test(l) && (!filter || filter(l))) add(level, cls, f, i + 1, msg);
    });
  }
}

/* ---------- ① SQL：字符串拼进查询 = 注入风险 ---------- */
scan(/pool\.query\(\s*`[^`]*\$\{/, '🔴', 'SQL拼接', 'SQL 里直接插了变量（模板字符串）—— 应改用占位符 ?');
scan(/pool\.query\(\s*'[^']*'\s*\+\s*(req\.|params|data)/, '🔴', 'SQL拼接', 'SQL 里拼接了外部输入');

/* ---------- ② 路由缺鉴权 ---------- */
{
  const routeFiles = cleaned.filter((c) => c.f.startsWith('routes/'));
  for (const { f, code } of routeFiles) {
    const lines = code.split('\n');
    lines.forEach((l, i) => {
      const m = l.match(/router\.(get|post|put|delete)\(\s*'([^']*)'\s*,\s*([^,)]*)/);
      if (!m) return;
      const second = (m[3] || '').trim();
      // 允许：auth / 明确注释说明为什么不需要（已被剥掉，所以这里只认 auth）
      if (second && !/auth/.test(second) && !/=>/.test(second)) {
        add('🔴', '缺鉴权', f, i + 1, `router.${m[1]}('${m[2]}') 的中间件不是 auth：${second.slice(0, 40)}`);
      }
    });
  }
}

/* ---------- ③ 静默吞异常 ---------- */
scan(/catch\s*(\([^)]*\))?\s*\{\s*\}/, '🟡', '空catch', 'catch 块是空的：出错了不留痕（查不出问题）');
scan(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/, '🟡', '空catch', '.catch 是空的：错误被吞掉');

/* ---------- ④ 硬编码密钥 ----------
   ⚠️ 正则要带**词边界**：第一版写 `sk-` 无边界，结果命中了 CSS 里的 `mask-xxx`
   （一次报了 9 个假阳性）。判定密钥这种"一旦误报就很吓人"的规则，宁严勿滥。 */
scan(/\b(sk-[A-Za-z0-9]{16,}|AKID[A-Za-z0-9]{10,}|LTAI5t[A-Za-z0-9]{10,})\b/, '🔴', '硬编码密钥', '疑似硬编码密钥/凭证');
scan(/\bpassword\s*[:=]\s*['"][^'"]{6,}['"]/i, '🔴', '硬编码密钥', '疑似硬编码密码');
/* 兜底型默认口令：`process.env.X || '写死的值'` —— 迁移时最容易漏设环境变量，
   而漏设之后**服务照常启动**，只是用了一个写在代码里的口令（2026-09-22 实测踩到）。 */
scan(/process\.env\.[A-Z_]*(TOKEN|SECRET|PASSWORD|KEY)[A-Z_]*\s*\|\|\s*['"][^'"]+['"]/, '🔴', '默认口令兜底',
  '环境变量没设时会退回代码里写死的值 —— 漏设不报错，等于用公开口令跑线上');

/* ---------- ⑤ 生产路径里的 console.log ---------- */
{
  let n = 0;
  for (const { f, code } of cleaned) {
    if (!f.startsWith('yibang-server') && !f.startsWith('lib/') && !f.startsWith('routes/') && !f.startsWith('scripts/')) continue;
    n += (code.match(/console\.log\(/g) || []).length;
  }
  if (n) add('💭', '日志', 'yibang-server/', 0, `后端有 ${n} 处 console.log（应统一走日志库或降级为 debug）`);
}

/* ---------- ⑥ 循环里 await（N+1 / 串行慢） ---------- */
for (const { f, code } of cleaned) {
  if (!f.endsWith('.js')) continue;
  const lines = code.split('\n');
  let inFor = 0;
  lines.forEach((l, i) => {
    if (/^\s*for\s*\(|^\s*for\s+await|\.forEach\(\s*async/.test(l)) inFor = i + 1;
    if (inFor && i + 1 - inFor < 14 && /await\s+.*pool\.query|await\s+.*fetch\(|await\s+.*axios/.test(l)) {
      add('🟡', '循环内IO', f, i + 1, `循环体内有 await IO（第 ${inFor} 行起）—— 可能是 N+1，考虑批量查`);
    }
    if (inFor && i + 1 - inFor > 14) inFor = 0;
  });
}

/* ---------- ⑦ 重复函数体（同文件内）---------- */
for (const { f, code } of cleaned) {
  if (!f.endsWith('.js')) continue;
  const bodies = {};
  const re = /function\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    // 取函数体（按大括号配平）
    let depth = 0, i = m.index + m[0].length - 1, start = i;
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') { depth--; if (!depth) break; }
    }
    const body = code.slice(start, i + 1).replace(/\s+/g, ' ').trim();
    if (body.length < 120) continue;
    if (bodies[body]) add('🟡', '重复代码', f, 0, `${m[1]}() 与 ${bodies[body]}() 函数体几乎完全相同`);
    else bodies[body] = m[1];
  }
}

/* ---------------- 输出 ---------------- */
const order = { '🔴': 0, '🟡': 1, '💭': 2 };
issues.sort((a, b) => order[a.level] - order[b.level]);
const byLevel = { '🔴': 0, '🟡': 0, '💭': 0 };
issues.forEach((x) => byLevel[x.level]++);

console.log(`扫描 ${files.length} 个文件`);
console.log(`🔴 阻塞 ${byLevel['🔴']}   🟡 建议 ${byLevel['🟡']}   💭 小问题 ${byLevel['💭']}\n`);
let lastLevel = '';
for (const it of issues) {
  if (it.level !== lastLevel) { console.log('──────── ' + it.level + ' ────────'); lastLevel = it.level; }
  console.log(`  [${it.cls}] ${it.file}:${it.line}`);
  console.log(`      ${it.msg}`);
}

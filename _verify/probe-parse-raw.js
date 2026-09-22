// 看模型对「辣椒3包，5块钱一斤」的**原始输出**，搞清为什么 amount 兜底没生效
const path = require('path');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });
const { callModel, extractJson } = require('/www/wwwroot/yibang-server/lib/ledger');

// 直接照抄线上 prompt（改这里的话记得同步 routes/record.js）
const PARSE_PROMPT = require('/www/wwwroot/yibang-server/routes/record.js');
// record.js 只导出 router，prompt 拿不到 —— 改成从文件里抠出来，保证探测用的是线上那一份
const fs = require('fs');
const src = fs.readFileSync('/www/wwwroot/yibang-server/routes/record.js', 'utf8');
const m = src.match(/const PARSE_PROMPT = \[([\s\S]*?)\]\.join\('\\n'\);/);
if (!m) { console.error('没找到 PARSE_PROMPT'); process.exit(1); }
const prompt = eval('[' + m[1] + "].join('\\n')");

const CASES = ['辣椒3包，5块钱一斤', '辣椒3白，5块钱一斤', '辣椒3件，5块钱一斤', '辣椒2袋5块一袋'];

(async () => {
  console.log('prompt 长度 ' + prompt.length + ' 字符\n');
  for (const text of CASES) {
    console.log('=== ' + text + ' ===');
    let raw;
    try {
      raw = await callModel({
        model: 'qwen-flash',
        messages: [
          { role: 'system', content: prompt.replace('__TODAY__', '2026-09-19') },
          { role: 'user', content: text }
        ],
        temperature: 0.1
      }, 45000);
    } catch (e) {
      console.log('  调用失败: ' + e.message);
      continue;
    }
    console.log('  原始输出：' + raw.trim());
    const j = extractJson(raw);
    console.log('  解析后：' + JSON.stringify(j));
    console.log('');
  }
  process.exit(0);
})();

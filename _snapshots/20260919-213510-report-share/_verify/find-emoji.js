// 列出 wxml 中所有 emoji 及其位置
const fs = require('fs');
const path = require('path');
const RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{1F000}-\u{1F2FF}]/gu;
const dir = process.argv[2];
function walk(d, out = []) {
  fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.wxml')) out.push(p);
  });
  return out;
}
let total = 0;
walk(dir).forEach((f) => {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const hits = [];
  lines.forEach((l, i) => {
    const m = l.match(RE);
    if (m) hits.push((i + 1) + ': [' + m.join('') + '] ' + l.trim().slice(0, 90));
  });
  if (hits.length) {
    total += hits.length;
    console.log('\n' + path.relative(dir, f) + '  (' + hits.length + ')');
    hits.forEach((h) => console.log('   ' + h));
  }
});
console.log('\n合计 ' + total + ' 处');

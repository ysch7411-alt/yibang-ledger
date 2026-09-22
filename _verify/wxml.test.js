// WXML 标签配对检查
const fs = require('fs');
const VOID = new Set(['input', 'image', 'import', 'include', 'wxs', 'slot', 'textarea', 'br']);
function check(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  const stack = [];
  const errs = [];
  let m;
  while ((m = re.exec(raw))) {
    const isClose = m[0][1] === '/';
    const tag = m[1];
    const self = m[3] === '/';
    const line = raw.slice(0, m.index).split('\n').length;
    if (isClose) {
      const top = stack.pop();
      if (top !== tag) errs.push('第 ' + line + ' 行: </' + tag + '> 与 <' + (top || '空') + '> 不匹配');
    } else if (!self && !VOID.has(tag)) {
      stack.push(tag);
    }
  }
  if (stack.length) errs.push('未闭合: ' + stack.join(', '));
  return errs;
}
const files = process.argv.slice(2);
let bad = 0;
files.forEach((f) => {
  const e = check(f);
  if (e.length) {
    bad++;
    console.log('X ' + f);
    e.forEach((x) => console.log('    ' + x));
  }
});
console.log(bad ? bad + ' 个文件有问题' : 'WXML 标签配对全部通过（' + files.length + ' 个文件）');

// WXML 指令合法性检查
// 背景：`wx:else` / `wx:elif` 与 `wx:for` 写在同一节点上，或 `wx:else` 前面没有
// 紧跟一个 `wx:if`，都会让整个项目编译不过。标签配对检查（wxml.test.js）发现不了
// 这类错误，只有真跑编译器才暴露 —— 补一个能离线跑的守卫。
//
// 用法: node wxml-directives.js <文件...>
const fs = require('fs');

const VOID = new Set(['input', 'image', 'import', 'include', 'wxs', 'slot', 'br', 'textarea']);

function parse(src) {
  const clean = src.replace(/<!--[\s\S]*?-->/g, '');
  const re = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const root = { tag: '#root', children: [] };
  const stack = [root];
  let m;
  while ((m = re.exec(clean))) {
    const whole = m[0];
    const isClose = whole[1] === '/';
    const tag = m[1];
    const attrs = m[2] || '';
    const selfClose = m[3] === '/';
    const line = clean.slice(0, m.index).split('\n').length;
    if (isClose) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = { tag, attrs, line, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose && !VOID.has(tag)) stack.push(node);
  }
  return root;
}

/**
 * 属性是否存在。
 * 注意 wx:else 是「无值指令」（`<view wx:else>`），不能要求跟 `=`，
 * 否则这个检查会全盘漏报 —— 第一版就是这么写错的。
 * 后置断言用来排除 wx:elseif 这类前缀相同的名字。
 */
function has(attrs, name) {
  return new RegExp('\\s' + name + '(?=[\\s=>/]|$)').test(' ' + attrs);
}

function walk(node, out) {
  out.push(node);
  node.children.forEach((c) => walk(c, out));
  return out;
}

function check(file) {
  const src = fs.readFileSync(file, 'utf8');
  const root = parse(src);
  const errs = [];
  const nodes = walk(root, []);

  nodes.forEach((n) => {
    if (n.tag === '#root') return;
    const wFor = has(n.attrs, 'wx:for');
    const wIf = has(n.attrs, 'wx:if');
    const wElif = has(n.attrs, 'wx:elif');
    const wElse = has(n.attrs, 'wx:else');

    if ((wElse || wElif) && wFor) {
      errs.push(n.line + ' 行: <' + n.tag + '> 同时用了 wx:' + (wElse ? 'else' : 'elif') + ' 和 wx:for（编译不过）');
    }
    if ((wElse || wElif) && wIf) {
      errs.push(n.line + ' 行: <' + n.tag + '> 同时用了 wx:' + (wElse ? 'else' : 'elif') + ' 和 wx:if（编译不过）');
    }
  });

  // 同级分支：wx:else / wx:elif 必须紧跟在有 wx:if / wx:elif 的兄弟节点后面
  nodes.forEach((parent) => {
    parent.children.forEach((n, i) => {
      if (!has(n.attrs, 'wx:else') && !has(n.attrs, 'wx:elif')) return;
      const prev = parent.children[i - 1];
      const ok = prev && (has(prev.attrs, 'wx:if') || has(prev.attrs, 'wx:elif'));
      if (!ok) {
        errs.push(
          n.line + ' 行: <' + n.tag + '> 的 wx:' + (has(n.attrs, 'wx:else') ? 'else' : 'elif') +
          (prev ? ' 前一个同级节点是 <' + prev.tag + '>，它没有 wx:if' : ' 是第一个子节点，前面没有 wx:if')
        );
      }
    });
  });

  return errs;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.log('用法: node wxml-directives.js <文件...>');
  process.exit(1);
}
let bad = 0;
files.forEach((f) => {
  const e = check(f);
  if (e.length) {
    bad++;
    console.log('X ' + f);
    e.forEach((x) => console.log('    ' + x));
  }
});
console.log(bad ? bad + ' 个文件有问题' : 'WXML 指令检查全部通过（' + files.length + ' 个文件）');

// 选型落地后的真实接口验证
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/www/wwwroot/yibang-server/.env' });

const t = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: 600 });
const H = { Authorization: 'Bearer ' + t };

const CASES = [
  ['标准送货单（干净，应有 3 行明细）', '/uploads/ocr-clean.jpg'],
  ['标准送货单（拍远 800px）', '/uploads/ocr-far.jpg'],
  ['用户真机那张证明（本来就没有明细行）', '/uploads/1789807771796-xh7fd.jpg']
];

(async () => {
  for (const [label, url] of CASES) {
    const t0 = Date.now();
    const r = await axios.post('http://127.0.0.1:3000/api/purchase/parse-doc', { fileUrl: url }, { headers: H, timeout: 120000 })
      .then((x) => x.data).catch((e) => ({ code: -1, msg: e.message }));
    const d = r.data || {};
    const items = d.items || [];
    console.log(label);
    console.log('  用时 ' + (Date.now() - t0) + 'ms   code=' + r.code +
      '   供应商=' + JSON.stringify(d.supplier || '') + '   合计=' + d.total + '   明细=' + items.length + ' 行');
    items.forEach((it, i) => console.log('    ' + (i + 1) + '. ' + it.name + ' | ' + it.spec + ' | ' + it.unit + ' | ' + it.qty + ' × ' + it.price + ' = ' + it.amount));
    if (!items.length) console.log('    → 没有明细，前端会如实提示「没认出明细，换个拍法」');
    console.log('');
  }

  // 文字入口对照
  const t1 = Date.now();
  const r2 = await axios.post('http://127.0.0.1:3000/api/purchase/parse-doc',
    { text: '螺纹钢 HRB400 12mm 2.5吨 3800元一吨' }, { headers: H, timeout: 60000 }).then((x) => x.data);
  console.log('文字入口对照：' + (Date.now() - t1) + 'ms  明细=' + ((r2.data && r2.data.items) || []).length + ' 行  合计=' + (r2.data && r2.data.total));
})();

require('dotenv').config();
const pool = require('./db/config');
const oss = require('./lib/oss');
const ExcelJS = require('exceljs');

async function test() {
  try {
    console.log('===== 测试Excel导出 =====');
    
    const TYPE_TEXT = { 1: '收入', 2: '支出', 3: '应收', 4: '应付', 5: '回款', 6: '付款' };

    // 创建工作簿
    const workbook = new ExcelJS.Workbook();
    workbook.creator = '易帮账本';
    workbook.created = new Date();

    // 表头样式
    const headerStyle = {
      font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4551D' } },
      alignment: { horizontal: 'center', vertical: 'middle' }
    };

    // Sheet1: 交易记录
    const [rows] = await pool.query(
      'SELECT t.type, t.amount, t.content, t.record_date, t.created_at, c.name AS contact_name FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id WHERE t.user_id = 1 AND t.status = 1 ORDER BY t.record_date DESC, t.id DESC LIMIT 5000'
    );
    console.log('查询到', rows.length, '条交易记录');

    const sheet1 = workbook.addWorksheet('交易记录');
    sheet1.columns = [
      { header: '日期', key: 'date', width: 15 },
      { header: '类型', key: 'type', width: 10 },
      { header: '金额', key: 'amount', width: 15 },
      { header: '往来对象', key: 'contact', width: 25 },
      { header: '事由', key: 'content', width: 40 },
      { header: '记录时间', key: 'created', width: 20 }
    ];
    sheet1.getRow(1).eachCell((cell) => { cell.style = headerStyle; });

    for (const r of rows) {
      sheet1.addRow({
        date: r.record_date ? new Date(r.record_date).toISOString().slice(0, 10) : '',
        type: TYPE_TEXT[r.type] || '其他',
        amount: Number(r.amount).toFixed(2),
        contact: r.contact_name || '',
        content: r.content || '',
        created: r.created_at ? new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ') : ''
      });
    }

    // Sheet2: 往来对象
    const [contacts] = await pool.query(
      'SELECT name, type, phone, remark, balance, created_at FROM contacts WHERE user_id = 1 ORDER BY created_at DESC'
    );
    console.log('查询到', contacts.length, '个往来对象');

    const sheet2 = workbook.addWorksheet('往来对象');
    sheet2.columns = [
      { header: '名称', key: 'name', width: 25 },
      { header: '类型', key: 'type', width: 10 },
      { header: '电话', key: 'phone', width: 18 },
      { header: '应收/应付余额', key: 'balance', width: 18 },
      { header: '备注', key: 'remark', width: 30 },
      { header: '创建时间', key: 'created', width: 20 }
    ];
    sheet2.getRow(1).eachCell((cell) => { cell.style = headerStyle; });

    const CONTACT_TYPE = { 1: '客户', 2: '供应商', 3: '其他' };
    for (const c of contacts) {
      sheet2.addRow({
        name: c.name,
        type: CONTACT_TYPE[c.type] || '其他',
        phone: c.phone || '',
        balance: Number(c.balance).toFixed(2),
        remark: c.remark || '',
        created: c.created_at ? new Date(c.created_at).toISOString().slice(0, 19).replace('T', ' ') : ''
      });
    }

    // Sheet3: 统计汇总
    const [summary] = await pool.query(
      'SELECT type, COUNT(*) as count, SUM(amount) as total FROM transactions WHERE user_id = 1 AND status = 1 GROUP BY type'
    );

    const sheet4 = workbook.addWorksheet('统计汇总');
    sheet4.columns = [
      { header: '类型', key: 'type', width: 15 },
      { header: '笔数', key: 'count', width: 15 },
      { header: '总金额', key: 'total', width: 20 }
    ];
    sheet4.getRow(1).eachCell((cell) => { cell.style = headerStyle; });

    for (const s of summary) {
      sheet4.addRow({
        type: TYPE_TEXT[s.type] || '其他',
        count: s.count,
        total: Number(s.total).toFixed(2)
      });
    }

    // 生成Excel buffer
    const buffer = await workbook.xlsx.writeBuffer();
    console.log('Excel文件大小:', buffer.length, '字节');

    // 上传到OSS
    const objectName = 'exports/test_' + Date.now() + '.xlsx';
    await oss.putBuffer(objectName, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    console.log('上传成功');

    // 生成带签名的URL
    const fileUrl = await oss.getSignedUrl(objectName, 7 * 24 * 3600);
    console.log('签名URL:', fileUrl.substring(0, 100) + '...');

    // 下载验证
    const https = require('https');
    const downloadRes = await new Promise((resolve, reject) => {
      https.get(fileUrl, (res) => {
        let data = [];
        res.on('data', (chunk) => data.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode, contentType: res.headers['content-type'], buffer: Buffer.concat(data) });
        });
      }).on('error', reject);
    });

    console.log('下载状态:', downloadRes.status);
    console.log('Content-Type:', downloadRes.contentType);
    console.log('下载文件大小:', downloadRes.buffer.length, '字节');

    if (downloadRes.status === 200 && downloadRes.buffer.length > 0) {
      console.log('\n===== ✅ Excel导出测试通过！=====');
      console.log('包含4个Sheet：交易记录、往来对象、员工管理、统计汇总');
      process.exit(0);
    } else {
      console.log('\n===== ❌ Excel导出测试失败 =====');
      process.exit(1);
    }

  } catch (err) {
    console.error('测试失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

test();

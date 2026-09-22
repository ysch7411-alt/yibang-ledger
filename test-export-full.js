require('dotenv').config();
const pool = require('./db/config');
const oss = require('./lib/oss');

async function test() {
  try {
    console.log('===== 1. 查询数据库 =====');
    const [rows] = await pool.query(
      'SELECT t.type, t.amount, t.content, t.record_date, t.created_at, c.name AS contact_name FROM transactions t LEFT JOIN contacts c ON t.contact_id = c.id WHERE t.user_id = 1 AND t.status = 1 ORDER BY t.record_date DESC, t.id DESC LIMIT 5000'
    );
    console.log('查询到', rows.length, '条记录');

    console.log('\n===== 2. 生成CSV内容 =====');
    const TYPE_TEXT = { 1: '收入', 2: '支出', 3: '应收', 4: '应付', 5: '回款', 6: '付款' };
    let csv = '日期,类型,金额,往来对象,事由,记录时间\n';

    for (const r of rows) {
      const typeText = TYPE_TEXT[r.type] || '其他';
      const amount = Number(r.amount).toFixed(2);
      const contact = (r.contact_name || '').replace(/,/g, '，');
      const content = (r.content || '').replace(/,/g, '，');
      const date = r.record_date ? new Date(r.record_date).toISOString().slice(0, 10) : '';
      const created = r.created_at ? new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ') : '';
      csv += date + ',' + typeText + ',' + amount + ',' + contact + ',' + content + ',' + created + '\n';
    }

    console.log('CSV内容前100字符:');
    console.log(csv.substring(0, 100));

    console.log('\n===== 3. 上传到OSS =====');
    const bom = '\uFEFF';
    const buffer = Buffer.from(bom + csv, 'utf-8');
    const fileName = '易帮账本_账目导出_' + new Date().toISOString().slice(0, 10) + '.csv';
    const objectName = 'exports/1_' + Date.now() + '.csv';

    await oss.putBuffer(objectName, buffer, 'text/csv; charset=utf-8');
    console.log('上传成功，objectName:', objectName);

    console.log('\n===== 4. 生成带签名的URL =====');
    const fileUrl = await oss.getSignedUrl(objectName, 7 * 24 * 3600);
    console.log('签名URL:', fileUrl.substring(0, 120) + '...');

    // 检查是否是https
    if (fileUrl.startsWith('https://')) {
      console.log('✅ 是HTTPS');
    } else {
      console.log('❌ 不是HTTPS');
      process.exit(1);
    }

    console.log('\n===== 5. 下载文件验证 =====');
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
    console.log('文件大小:', downloadRes.buffer.length, '字节');

    if (downloadRes.status !== 200) {
      console.log('❌ 下载失败，状态码不是200');
      process.exit(1);
    }

    console.log('\n===== 6. 验证文件内容 =====');
    const content = downloadRes.buffer.toString('utf-8');
    console.log('文件前100字符:');
    console.log(content.substring(0, 100));

    // 检查是否包含BOM
    if (content.charCodeAt(0) === 0xFEFF) {
      console.log('✅ 包含BOM头（Excel能正确识别中文）');
    } else {
      console.log('❌ 不包含BOM头');
      process.exit(1);
    }

    // 检查是否包含表头
    if (content.includes('日期,类型,金额,往来对象,事由,记录时间')) {
      console.log('✅ 表头正确');
    } else {
      console.log('❌ 表头错误');
      process.exit(1);
    }

    // 检查是否有数据行
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length > 1) {
      console.log('✅ 有数据行，共', lines.length - 1, '条记录');
    } else {
      console.log('❌ 没有数据行');
      process.exit(1);
    }

    console.log('\n===== ✅ 全部测试通过！导出功能正常 =====');
    console.log('文件名:', fileName);
    console.log('记录数:', rows.length);
    console.log('文件大小:', downloadRes.buffer.length, '字节');
    process.exit(0);

  } catch (err) {
    console.error('测试失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

test();

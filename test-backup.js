require('dotenv').config();
const pool = require('./db/config');
const oss = require('./lib/oss');

async function test() {
  try {
    console.log('===== 测试数据备份导出 =====');
    
    const userId = 1;

    // 导出用户信息
    const [users] = await pool.query(
      'SELECT id, nickname, shop_name, phone, plan_type, created_at FROM users WHERE id = ?',
      [userId]
    );
    console.log('用户信息:', users[0] ? users[0].nickname : '无');

    // 导出交易记录
    const [transactions] = await pool.query(
      'SELECT * FROM transactions WHERE user_id = ? AND status = 1 ORDER BY record_date DESC, id DESC',
      [userId]
    );
    console.log('交易记录:', transactions.length, '条');

    // 导出往来对象
    const [contacts] = await pool.query(
      'SELECT * FROM contacts WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    console.log('往来对象:', contacts.length, '个');

    // 导出AI纠正记录
    const [aiCorrections] = await pool.query(
      'SELECT * FROM ai_corrections WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    console.log('AI纠正记录:', aiCorrections.length, '条');

    // 导出商户术语
    const [merchantTerms] = await pool.query(
      'SELECT * FROM merchant_terms WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    console.log('商户术语:', merchantTerms.length, '条');

    // 导出文件记录
    const [files] = await pool.query(
      'SELECT id, user_id, transaction_id, file_url, file_type, file_size, created_at FROM files WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    console.log('文件记录:', files.length, '个');

    // 组装备份数据
    const backup = {
      version: '1.0',
      exportTime: new Date().toISOString(),
      app: '易帮账本',
      data: {
        user: users[0] || null,
        transactions,
        contacts,
        aiCorrections,
        merchantTerms,
        files
      },
      summary: {
        transactions: transactions.length,
        contacts: contacts.length,
        aiCorrections: aiCorrections.length,
        merchantTerms: merchantTerms.length,
        files: files.length
      }
    };

    // 生成JSON文件
    const jsonStr = JSON.stringify(backup, null, 2);
    const buffer = Buffer.from(jsonStr, 'utf-8');
    console.log('备份文件大小:', buffer.length, '字节');

    const fileName = '易帮账本_数据备份_' + new Date().toISOString().slice(0, 10) + '.json';
    const objectName = 'backups/test_' + Date.now() + '.json';

    // 上传到OSS
    await oss.putBuffer(objectName, buffer, 'application/json; charset=utf-8');
    console.log('上传成功');

    // 生成带签名的URL
    const fileUrl = await oss.getSignedUrl(objectName, 30 * 24 * 3600);
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
    console.log('下载文件大小:', downloadRes.buffer.length, '字节');

    // 验证JSON内容
    const downloadedBackup = JSON.parse(downloadRes.buffer.toString('utf-8'));
    console.log('备份版本:', downloadedBackup.version);
    console.log('备份应用:', downloadedBackup.app);
    console.log('交易记录数:', downloadedBackup.summary.transactions);
    console.log('往来对象数:', downloadedBackup.summary.contacts);

    if (downloadRes.status === 200 && downloadedBackup.summary.transactions > 0) {
      console.log('\n===== ✅ 数据备份导出测试通过！=====');
      process.exit(0);
    } else {
      console.log('\n===== ❌ 数据备份导出测试失败 =====');
      process.exit(1);
    }

  } catch (err) {
    console.error('测试失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

test();

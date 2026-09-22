require('dotenv').config();
const https = require('https');

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = [];
      res.on('data', (chunk) => data.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, contentType: res.headers['content-type'], buffer: Buffer.concat(data) });
      });
    }).on('error', reject);
  });
}

async function test() {
  try {
    console.log('===== 1. 登录获取token =====');
    const loginBody = JSON.stringify({
      code: 'test_code_123456',
      userInfo: {
        nickName: '测试用户',
        avatarUrl: ''
      }
    });
    
    const loginRes = await request({
      hostname: 'api.dtzai.cn',
      path: '/api/user/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(loginBody)
      }
    }, loginBody);
    
    console.log('登录状态:', loginRes.status);
    console.log('登录返回:', JSON.stringify(loginRes.data).substring(0, 200));
    
    if (!loginRes.data.data || !loginRes.data.data.token) {
      console.log('登录失败，无法继续测试');
      process.exit(1);
    }
    
    const token = loginRes.data.data.token;
    console.log('获取token成功');
    
    console.log('\n===== 2. 调用导出接口 =====');
    const exportRes = await request({
      hostname: 'api.dtzai.cn',
      path: '/api/user/export-csv',
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token
      }
    });
    
    console.log('导出状态:', exportRes.status);
    console.log('导出返回:', JSON.stringify(exportRes.data).substring(0, 300));
    
    if (!exportRes.data.data || !exportRes.data.data.fileUrl) {
      console.log('导出失败，没有返回文件URL');
      process.exit(1);
    }
    
    const fileUrl = exportRes.data.data.fileUrl;
    const fileName = exportRes.data.data.fileName;
    const count = exportRes.data.data.count;
    
    console.log('文件名:', fileName);
    console.log('记录数:', count);
    console.log('文件URL:', fileUrl.substring(0, 100) + '...');
    
    console.log('\n===== 3. 下载文件 =====');
    const downloadRes = await downloadFile(fileUrl);
    
    console.log('下载状态:', downloadRes.status);
    console.log('Content-Type:', downloadRes.contentType);
    console.log('文件大小:', downloadRes.buffer.length, '字节');
    
    if (downloadRes.status !== 200) {
      console.log('下载失败，状态码不是200');
      process.exit(1);
    }
    
    console.log('\n===== 4. 验证文件内容 =====');
    const content = downloadRes.buffer.toString('utf-8');
    console.log('文件前100字符:');
    console.log(content.substring(0, 100));
    
    // 检查是否包含表头
    if (content.includes('日期,类型,金额,往来对象,事由,记录时间')) {
      console.log('\n✅ 表头正确');
    } else {
      console.log('\n❌ 表头错误');
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
    process.exit(0);
    
  } catch (err) {
    console.error('测试失败:', err.message);
    process.exit(1);
  }
}

test();

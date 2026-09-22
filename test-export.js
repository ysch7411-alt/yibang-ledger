require('dotenv').config();
const oss = require('./lib/oss');
async function test() {
  try {
    const buffer = Buffer.from('test,csv,文件\n', 'utf-8');
    const url = await oss.putBuffer('test/test.csv', buffer, 'text/csv');
    console.log('上传成功:', url);
  } catch (e) {
    console.error('上传失败:', e.message);
  }
}
test();

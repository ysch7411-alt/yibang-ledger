/**
 * 阿里云 OSS 客户端（2026-09-21 新增）
 *
 * 为什么用 OSS 而不是本地磁盘：
 * 1. 本地磁盘存文件，服务器重装或扩容就丢了
 * 2. 本地磁盘不适合存用户上传的文件，备份麻烦
 * 3. OSS 有 CDN 加速，图片加载更快
 *
 * 使用方式：
 *   const oss = require('../lib/oss');
 *   await oss.putBuffer('uploads/xxx.mp3', buffer, contentType);
 *   const url = oss.getUrl('uploads/xxx.mp3');
 */

const OSS = require('ali-oss');

let client = null;

function getClient() {
  if (client) return client;

  client = new OSS({
    region: process.env.OSS_REGION || 'oss-cn-beijing',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || 'yibang-ledger'
  });

  return client;
}

/**
 * 上传 Buffer 到 OSS
 * @param {string} objectName - 对象名（比如 uploads/xxx.mp3）
 * @param {Buffer} buffer - 文件内容
 * @param {string} contentType - MIME 类型
 * @returns {Promise<string>} 文件的完整URL
 */
async function putBuffer(objectName, buffer, contentType) {
  const client = getClient();
  await client.put(objectName, buffer, {
    headers: {
      'Content-Type': contentType
    }
  });
  return getUrl(objectName);
}

/**
 * 从 OSS 下载文件为 Buffer
 * @param {string} objectName - 对象名（比如 uploads/xxx.mp3）
 * @returns {Promise<Buffer>}
 */
async function getBuffer(objectName) {
  const client = getClient();
  const result = await client.get(objectName);
  return result.content;
}

/**
 * 获取文件的完整URL（带签名，临时访问）
 * @param {string} objectName - 对象名（比如 uploads/xxx.mp3，或者 /uploads/xxx.mp3）
 * @param {number} expiresSec - 过期时间（秒），默认7天
 * @returns {Promise<string>} 完整URL
 */
async function getSignedUrl(objectName, expiresSec = 7 * 24 * 3600) {
  // 去掉开头的 /，统一格式
  const name = objectName.startsWith('/') ? objectName.slice(1) : objectName;
  
  const client = getClient();
  // 生成带签名的URL，有效期7天
  let url = await client.signatureUrl(name, { expires: expiresSec });
  // 强制用https（微信小程序要求）
  url = url.replace('http://', 'https://');
  return url;
}

/**
 * 获取文件的完整URL（直接拼接，用于CDN）
 * @param {string} objectName - 对象名（比如 uploads/xxx.mp3，或者 /uploads/xxx.mp3）
 * @returns {string} 完整URL
 */
function getUrl(objectName) {
  // 去掉开头的 /，统一格式
  const name = objectName.startsWith('/') ? objectName.slice(1) : objectName;
  
  // 优先使用 CDN 域名
  if (process.env.OSS_CDN_DOMAIN) {
    return `https://${process.env.OSS_CDN_DOMAIN}/${name}`;
  }
  
  // 回退到 OSS 原始域名
  const bucket = process.env.OSS_BUCKET || 'yibang-ledger';
  const region = process.env.OSS_REGION || 'oss-cn-beijing';
  return `https://${bucket}.${region}.aliyuncs.com/${name}`;
}

/**
 * 从 fileUrl 提取 objectName
 * 输入：/uploads/xxx.mp3 或 https://xxx.aliyuncs.com/uploads/xxx.mp3
 * 输出：uploads/xxx.mp3
 */
function parseObjectKey(fileUrl) {
  if (!fileUrl) return null;

  // 如果已经是完整URL，提取路径部分
  if (fileUrl.startsWith('http')) {
    try {
      const url = new URL(fileUrl);
      return url.pathname.slice(1); // 去掉开头的 /
    } catch (e) {
      return null;
    }
  }

  // 如果是相对路径，去掉开头的 /
  return fileUrl.startsWith('/') ? fileUrl.slice(1) : fileUrl;
}

module.exports = {
  putBuffer,
  getBuffer,
  getUrl,
  getSignedUrl,
  parseObjectKey,
  getClient
};

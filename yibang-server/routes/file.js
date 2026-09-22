const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const oss = require('../lib/oss');
const log = require('../lib/log');

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.json({ code: 401, msg: '未登录' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.json({ code: 401, msg: 'token无效' });
  }
}

const EXT_MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.amr': 'audio/amr', '.silk': 'audio/silk', '.pcm': 'audio/L16',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function resolveExt(req, file) {
  let ext = path.extname(file.originalname || '').toLowerCase();
  if (!ext && req.body && req.body.fileName) {
    ext = path.extname(String(req.body.fileName)).toLowerCase();
  }
  return ext;
}

function normalizeMime(req, file) {
  const ext = resolveExt(req, file);
  let mime = String(file.mimetype || '').trim();
  if (!mime || mime === 'application/octet-stream') {
    mime = EXT_MIME[ext] || 'application/octet-stream';
  }
  return mime.slice(0, 64);
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

router.post('/upload', auth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const code = err.code || '';
      if (code === 'LIMIT_FILE_SIZE') {
        return res.json({ code: 413, msg: '文件超过 10MB，请压缩后再传' });
      }
      log.error('上传中间件错误:', code || err.message, '| field:', err.field);
      return res.json({ code: 400, msg: '上传失败：' + (code || err.message) });
    }
    handleUpload(req, res);
  });
});

async function handleUpload(req, res) {
  if (!req.file) {
    return res.json({ code: 400, msg: '请选择文件' });
  }

  try {
    const ext = resolveExt(req, req.file);
    const mime = normalizeMime(req, req.file);
    
    const objectName = 'uploads/' + req.userId + '/' + Date.now() + '-' + Math.random().toString(36).substring(7) + ext;
    
    await oss.putBuffer(objectName, req.file.buffer, mime);
    
    const fileUrl = await oss.getSignedUrl(objectName, 7 * 24 * 3600);
    
    const [result] = await pool.query(
      'INSERT INTO files (user_id, file_url, file_type, file_size) VALUES (?, ?, ?, ?)',
      [req.userId, objectName, mime, req.file.size]
    );

    res.json({
      code: 0,
      msg: '上传成功',
      data: {
        id: result.insertId,
        url: fileUrl,
        objectName: objectName,
        size: req.file.size
      }
    });
  } catch (err) {
    log.error('文件上传OSS失败:', err && err.message, '| file:', req.file && req.file.originalname);
    res.json({ code: 500, msg: '上传失败：' + (err.message || '未知错误') });
  }
}

router.get('/list', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.userId]
    );
    
    for (const row of rows) {
      if (row.file_url && row.file_url.startsWith('uploads/')) {
        try {
          row.file_url = await oss.getSignedUrl(row.file_url, 7 * 24 * 3600);
        } catch (e) {}
      }
    }
    
    res.json({ code: 0, data: rows });
  } catch (err) {
    log.error('获取文件列表失败:', err.message);
    res.json({ code: 500, msg: '获取文件列表失败' });
  }
});

module.exports = router;
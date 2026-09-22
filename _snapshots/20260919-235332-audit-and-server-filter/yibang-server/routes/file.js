const express = require('express');
const router = express.Router();
const pool = require('../db/config');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

// 扩展名 → MIME。wx.uploadFile 大多数情况下不上报 content-type，
// multer 这时会把 mimetype 填成 application/octet-stream，既没信息量、
// 又超过 file_type 列宽，会导致整条 INSERT 失败（上传永远失败）。这里按扩展名兜底。
const EXT_MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.amr': 'audio/amr', '.silk': 'audio/silk', '.pcm': 'audio/L16',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

/** 取扩展名：优先原文件名，其次前端 formData 传的 fileName */
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
  // 列宽兜底：无论客户端报什么，都不让它撑爆字段
  return mime.slice(0, 64);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, process.env.UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = resolveExt(req, file);
    cb(null, Date.now() + '-' + Math.random().toString(36).substring(7) + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// 文件上传
// multer 在路由处理器之前就会抛错（超限、字段名不对等），如果不接住，
// 会掉进全局错误处理变成一句没有信息量的「服务器内部错误」——
// 真机上传失败时就完全查不出原因。这里把中间件错误转成可读的 JSON。
router.post('/upload', auth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const code = err.code || '';
      if (code === 'LIMIT_FILE_SIZE') {
        return res.json({ code: 413, msg: '文件超过 10MB，请压缩后再传' });
      }
      console.error('上传中间件错误:', code || err.message, '| field:', err.field);
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
    const fileUrl = '/uploads/' + req.file.filename;
    const [result] = await pool.query(
      'INSERT INTO files (user_id, file_url, file_type, file_size) VALUES (?, ?, ?, ?)',
      [req.userId, fileUrl, normalizeMime(req, req.file), req.file.size]
    );

    res.json({
      code: 0,
      msg: '上传成功',
      data: {
        id: result.insertId,
        url: fileUrl,
        size: req.file.size
      }
    });
  } catch (err) {
    // 之前这里吞掉了错误，导致上传失败查不到原因
    console.error('文件入库失败:', err && err.message, '| file:', req.file && req.file.filename, '| mime:', req.file && req.file.mimetype);
    res.json({ code: 500, msg: '上传失败' });
  }
}

// 文件列表
router.get('/list', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.userId]
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    res.json({ code: 500, msg: '获取文件列表失败' });
  }
});

module.exports = router;

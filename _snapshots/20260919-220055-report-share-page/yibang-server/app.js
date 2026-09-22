require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 创建上传目录
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 中间件
app.set('trust proxy', 1); // 前面是 nginx
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

/**
 * 请求体解析失败的兜底（必须紧跟在上面的 body 解析中间件之后）。
 *
 * 不加这个，`express.json()` 解析失败会 `next(err)` 一路落到最后的全局错误处理，
 * 变成 HTTP 500「服务器内部错误」—— **客户端发了个坏 body，却报成服务端故障**，
 * 排查时方向完全错。而且它在路由之前执行，连「接口不存在」的 404 都会被它吃掉。
 * 2026-09-19 审计就是靠这个现象发现的：给 GET 发字符串 "null"，全站接口齐刷刷 500。
 */
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    console.error('请求体解析失败:', req.method, req.originalUrl, '|', err.message);
    return res.status(400).json({ code: 400, msg: '请求体不是合法 JSON' });
  }
  next(err);
});

// 健康检测接口
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: '易帮账本后端服务运行中',
    time: new Date().toISOString()
  });
});

// 路由模块
app.use('/api/user', require('./routes/user'));
app.use('/api/record', require('./routes/record'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/promote', require('./routes/promote'));
app.use('/api/purchase', require('./routes/purchase'));
app.use('/api/share', require('./routes/share'));
app.use('/api/file', require('./routes/file'));
app.use('/api/staff', require('./routes/staff'));
// 「越用越懂」的可见账本：把后台默默积累的词表/纠正暴露给用户看
app.use('/api/memory', require('./routes/memory'));
// 客户端错误信标：真机上「服务端看到 200、前端却失败」时，靠它定位断点
app.use('/api/debug', require('./routes/debug'));

// 未匹配路由统一返回 JSON 404 —— 前端据此区分「接口不存在」和「业务失败」
app.use((req, res) => {
  res.status(404).json({ code: 404, msg: '接口不存在: ' + req.method + ' ' + req.path });
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('未捕获错误:', err && err.stack ? err.stack : err);
  res.status(500).json({ code: 500, msg: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log('易帮账本后端服务启动成功，端口: ' + PORT);
});

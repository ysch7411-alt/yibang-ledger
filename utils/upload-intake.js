/**
 * utils/upload-intake.js —— 上传入口归一化
 *
 * 2026-10-15。
 *
 * ── 干什么 ──
 *   小老板真实的工作流是"扔一张小票/一张账单截图/一个 Excel 给我"，
 *   而不是打字。但小程序里"拍照 / 相册 / 聊天文件"是**三套不同的 API**，
 *   返回结构还不一样（chooseMedia vs chooseMessageFile）。
 *   这个模块把它们的返回值**归一化成同一个形状**，
 *   上层（chat.js）就不用写三遍 if。
 *
 * ── 为什么单独一个文件 ──
 *   纯函数、不碰 wx —— 所以能在 Node 里直接单测
 *   （见 cloudrun/yibang-api/test/upload-intake.test.js）。
 *   判断错类型会让"Excel 走图像 OCR"，一眼假，所以必须能测。
 *
 * ── ⚠️ 关于"粘贴" ──
 *   H5 版有全局 Ctrl+V。**小程序没有全局 paste 事件**
 *   （input / textarea 的 bind 事件里都没有 paste）。
 *   所以这里不为它造假入口 —— 粘贴交给系统输入框的默认行为。
 */

/* 文件种类 */
const KIND = {
  IMAGE: 'image',     // 拍照 / 相册 / 图片文件
  TABLE: 'table',     // Excel / CSV —— 走表格解析
  PDF: 'pdf',         // PDF —— 走文档解析
  TEXT: 'text',       // txt —— 走文本解析
  UNKNOWN: 'unknown'
};

/* 可作为图片走的扩展名（chooseMessageFile 可能选到图片） */
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic'];
const TABLE_EXT = ['xls', 'xlsx', 'csv'];
const PDF_EXT = ['pdf'];
const TEXT_EXT = ['txt', 'md'];

/** 取小写扩展名（没有就返回空串） */
function extOf(name) {
  const s = String(name == null ? '' : name);
  const i = s.lastIndexOf('.');
  if (i < 0 || i === s.length - 1) return '';
  return s.slice(i + 1).toLowerCase();
}

/**
 * 按文件名判断种类。**认不出就是 UNKNOWN，不猜**。
 * @param {string} name
 * @returns {string} KIND.*
 */
function kindOfFile(name) {
  const e = extOf(name);
  if (!e) return KIND.UNKNOWN;
  if (IMAGE_EXT.indexOf(e) >= 0) return KIND.IMAGE;
  if (TABLE_EXT.indexOf(e) >= 0) return KIND.TABLE;
  if (PDF_EXT.indexOf(e) >= 0) return KIND.PDF;
  if (TEXT_EXT.indexOf(e) >= 0) return KIND.TEXT;
  return KIND.UNKNOWN;
}

/** 字节数 → 人能读的大小 */
function describeSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** 种类 → 给用户看的短标签 */
const KIND_LABEL = {
  image: '图片',
  table: '表格',
  pdf: 'PDF',
  text: '文本',
  unknown: '文件'
};

/**
 * 归一化一条上传项。
 * @param {{path?:string, name?:string, size?:number, mime?:string, kind?:string, source?:string}} raw
 * @returns {{kind:string, path:string, name:string, size:number, mime:string, source:string, label:string, sizeText:string, sub:string}|null}
 */
function buildItem(raw) {
  const r = raw || {};
  const name = String(r.name == null ? '' : r.name).trim();
  const path = String(r.path == null ? '' : r.path);
  if (!path && !name) return null;

  const kind = r.kind || kindOfFile(name);
  const size = Number(r.size) || 0;
  const label = KIND_LABEL[kind] || KIND_LABEL.unknown;
  const sizeText = describeSize(size);

  /* 副标题：能给什么给什么，不硬凑 */
  let sub = label;
  if (kind === KIND.TABLE || kind === KIND.PDF || kind === KIND.TEXT) {
    const e = extOf(name);
    sub = (e ? e.toUpperCase() : label) + (sizeText ? ' · ' + sizeText : '');
  } else if (sizeText) {
    sub = sizeText;
  }

  return {
    kind: kind,
    path: path,
    name: name || label,
    size: size,
    mime: String(r.mime == null ? '' : r.mime),
    source: String(r.source == null ? '' : r.source),
    label: label,
    sizeText: sizeText,
    sub: sub
  };
}

/**
 * wx.chooseMedia 的回调结果 → 归一化。
 * @param {object} res { tempFiles: [{ tempFilePath, size, fileType }] }
 */
function fromChooseMedia(res) {
  const f = res && res.tempFiles && res.tempFiles[0];
  if (!f) return null;
  const p = String(f.tempFilePath || '');
  /* chooseMedia 给的是临时路径，没有原始文件名 —— 从路径尾巴取一个能看的名字 */
  const tail = p.split('/').pop() || '';
  return buildItem({
    path: p,
    name: tail || (f.fileType === 'video' ? '视频' : '照片'),
    size: f.size,
    mime: f.mimeType || '',
    kind: KIND.IMAGE,
    source: 'media'
  });
}

/**
 * wx.chooseMessageFile 的回调结果 → 归一化。
 * 这是**从微信聊天里选文件**，是小老板拿 Excel/PDF 最自然的路径。
 * @param {object} res { tempFiles: [{ path, name, size, type }] }
 */
function fromChooseMessageFile(res) {
  const f = res && res.tempFiles && res.tempFiles[0];
  if (!f) return null;
  return buildItem({
    path: String(f.path || ''),
    name: String(f.name || ''),
    size: f.size,
    mime: String(f.type || ''),
    source: 'message'
  });
}

/**
 * 这条上传该怎么处理？
 * @returns {'ocr'|'table'|'doc'|'text'|'manual'} manual = 认不出，只能让人工补
 */
function routeOf(kind) {
  if (kind === KIND.IMAGE) return 'ocr';
  if (kind === KIND.TABLE) return 'table';
  if (kind === KIND.PDF) return 'doc';
  if (kind === KIND.TEXT) return 'text';
  return 'manual';
}

/** 给用户的一句处理说明（放进度卡第一行） */
function step0Text(kind) {
  const r = routeOf(kind);
  if (r === 'ocr') return '正在识别图片文字（OCR）';
  if (r === 'table') return '正在解析表格';
  if (r === 'doc') return '正在解析 PDF';
  if (r === 'text') return '正在读取文本';
  return '正在尝试解析';
}

module.exports = {
  KIND: KIND,
  extOf: extOf,
  kindOfFile: kindOfFile,
  describeSize: describeSize,
  buildItem: buildItem,
  fromChooseMedia: fromChooseMedia,
  fromChooseMessageFile: fromChooseMessageFile,
  routeOf: routeOf,
  step0Text: step0Text,
  KIND_LABEL: KIND_LABEL
};

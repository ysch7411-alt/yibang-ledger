const express = require('express');
const router = express.Router();

/**
 * 客户端错误信标（只写日志，不落库、不返回业务数据）。
 *
 * 为什么需要它：真机出问题时，服务端 nginx 只记得到「200 + N 字节」，
 * 前端拿到响应之后断在哪一步完全看不见 —— 2026-09-19 排查「语音转写没成功」
 * 就卡在这里：日志显示 upload/asr 都 200，但后面的 /record/ai-parse 根本没发出，
 * 到底是哪一行代码 return 的，服务器侧无从判断。小程序端又不好抓 console，
 * 所以让前端把「哪一步 + 原因」主动报回来。
 *
 * 纪律：这里永远返回成功，永远不因为信标本身让业务失败。
 */
router.post('/beacon', (req, res) => {
  res.json({ code: 0 });
  try {
    const b = req.body || {};
    const cut = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').slice(0, n);
    console.log('[beacon] ' + JSON.stringify({
      t: new Date().toISOString(),
      step: cut(b.step, 60),
      detail: cut(b.detail, 300),
      page: cut(b.page, 60),
      ver: cut(b.ver, 40)
    }));
  } catch (e) {
    /* 信标本身出错就算了 */
  }
});

module.exports = router;

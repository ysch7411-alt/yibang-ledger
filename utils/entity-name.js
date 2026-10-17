/**
 * utils/entity-name.js —— 从老板的一句话里解析「名称 + 领域」
 *
 * 2026-10-15。
 *
 * ── 🔴 为什么不叫「店名」──
 *   用易帮AI的不一定是"开店的老板"。可能是：
 *     小店（水果店 / 五金铺 / 超市）
 *     公司（XX 建材有限公司）
 *     团队（火星小队）
 *     项目（春晓项目 / 门店改造）
 *   所以引导问的是"**怎么称呼您这边**"，解析的是**通用名称**，
 *   不是狭义的店名。UI 文案和字段语义都按这个来。
 *
 * ── 为什么单独一个文件 ──
 *   纯字符串处理，不碰 wx / 网络 —— 所以能在 Node 里直接单测
 *   （见 cloudrun/yibang-api/test/entity-name.test.js）。
 *   解析错了会让老板看到"你是 XX"，比不解析更糟，所以必须能测。
 *
 * ── 只在"首次引导"里调用 parse() ──
 *   老板平时说的"我开完会再说"不该被当成名称。
 *   调用方（chat.js）只在 needName 为 true 时才走 parse()。
 *
 * ── 铁律 ──
 *   parse() 解析不出来就返回 null，**绝不猜**。
 *   宁可再问一遍，也不能给老板安一个错误的名称。
 */

/* 组织/实体后缀 —— 用来判断一句话是不是在说"名称" */
const ENTITY_SUFFIX =
  '门店|商行|档口|超市|商城|集团|公司|事务所|工作室|工坊|中心|市场|项目|厂|铺|馆|行|摊|店|部|队';
const SUFFIX_RE = new RegExp('(?:' + ENTITY_SUFFIX + ')');

/* 组织关键词（公司/团队/项目…）—— 用于"叫 XX"、"是做 XX 的"两种句式 */
const ORG_WORD = '公司|团队|项目|工作室|事务所|机构|单位|账本|铺子|厂子|店铺|门店';

/* 明确表示"这是在说名字"的关键词 —— 出现就提高置信度 */
const EXPLICIT_ENTITY_RE =
  /(?:店名|名字|名称|公司|团队|项目|工作室|事务所|机构|单位|账本|铺子|厂子)/;

/* 领域关键词 → 标准领域名。注意顺序：越具体的放越前。
 * 例 "水果超市" 要判成"水果"而不是"超市"。
 * 不限于零售 —— 公司/团队/项目常见的领域也收。 */
const INDUSTRY_RULES = [
  /* 零售 / 生鲜 */
  { re: /水果|鲜果|果品/, name: '水果' },
  { re: /蔬菜|青菜|菜摊|卖菜/, name: '蔬菜' },
  { re: /海鲜|水产|鱼虾/, name: '水产' },
  { re: /猪肉|牛肉|羊肉|肉类|鲜肉/, name: '肉类' },
  { re: /粮油|米面/, name: '粮油' },
  { re: /烟酒/, name: '烟酒' },
  { re: /药店|药房|医药/, name: '药店' },
  { re: /花卉|鲜花|绿植/, name: '花卉' },
  { re: /便利|副食|小卖部|杂货|士多/, name: '便利店' },
  { re: /超市/, name: '超市' },
  /* 餐饮 / 服务 */
  { re: /餐饮|饭店|餐馆|小吃|快餐|面馆|米粉|烧烤|火锅|奶茶|咖啡/, name: '餐饮' },
  { re: /理发|美发|美容|美甲/, name: '生活服务' },
  /* 非零售（公司 / 团队 / 项目常见） */
  { re: /建材|五金|水暖|电料/, name: '建材五金' },
  { re: /装修|装饰|工程|施工|建筑/, name: '建筑工程' },
  { re: /物流|运输|货运|配送/, name: '物流运输' },
  { re: /软件|科技|信息|网络|互联网|小程序|系统/, name: '软件科技' },
  { re: /教育|培训|学校|课程/, name: '教育培训' },
  { re: /医疗|诊所|医院|健康/, name: '医疗健康' },
  { re: /服装|衣|鞋|帽/, name: '服装' },
  { re: /食品|零食|烘焙/, name: '食品' },
  { re: /贸易|进出口|商贸/, name: '贸易' },
  { re: /农业|种植|养殖|农场/, name: '农业' },
  { re: /广告|传媒|设计|文化/, name: '文化传媒' },
  { re: /财税|财务|会计|税务|记账|代账/, name: '财税服务' }
];

/* 疑问/否定信号 —— 出现就判定"不是在说名称"（仅 parse 用） */
const NOT_A_NAME_RE = /[吗么呢?？]|不(?:是|开|做|卖|叫)|没有|还没|不知道|忘了/;

/**
 * 从一句话里解析「名称 + 领域」（**严格模式**，用于自由对话）。
 *
 * @param {string} text 老板原话，如
 *        "我开水果店" / "我们公司叫火星科技" / "团队叫火星小队" / "春晓项目"
 * @returns {{name:string, industry:string|null, industryOnly?:boolean}|null}
 */
function parse(text) {
  const raw = String(text == null ? '' : text);
  /* 归一化：去掉标点空白 */
  const s = raw.replace(/[\s，。！!？?、,.~～]/g, '').trim();

  if (!s || s.length > 40) return null;
  if (NOT_A_NAME_RE.test(s)) return null;

  let name = null;
  let explicit = false;   // true = 老板明说了"名字是 X"（置信度高）
  let hasSuffix = false;  // 整句是否带组织后缀（用于硬门槛判断，name 里不一定保留）

  /* ⓪ "公司/团队/项目 + 做/是 Y" → 只给领域
   *    必须排在"叫 X"之前，否则"我们公司是做装修的"会被抓成名称"做装修"。
   *    ⚠️ 只认"能识别出领域"的情况；认不出就往下走，让后面的名称规则试。 */
  {
    const reInd = new RegExp(
      '^(?:我|我们|咱们|俺)?(?:的)?(?:' + ORG_WORD + ')(?:是|做|在做|是做|主要做|专门做)(?:做)?(.{1,14}?)(?:的|生意|行业)?$'
    );
    const mInd = reInd.exec(s);
    if (mInd && mInd[1]) {
      const ind = industryOf(mInd[1]);
      if (ind) return { name: '', industry: ind, industryOnly: true };
    }
  }

  /* ① "我开(的|了)(是)(一家|一个|家|个)X" —— 开店句式（弱） */
  let m = /^(?:我|我们|咱们|俺)?(?:是)?开(?:的|了)?(?:是)?(?:一家|一个|家|个)?(.{2,20})$/.exec(s);
  if (m) name = m[1];

  /* ② "公司名/店名/名字/名称(是|叫)X" —— 显式（强）
   *    覆盖 "公司名是宏图贸易" / "店名是老李水果店" / "名字叫春晓" */
  if (!name) {
    const m2 = new RegExp(
      '^(?:我|我们|咱们|俺)?(?:的)?(?:' + ORG_WORD + ')?(?:店名|名字|名称|名)(?:是|叫|是叫|名叫|叫做)?(.{2,20})$'
    ).exec(s);
    if (m2) { name = m2[1]; explicit = true; }
  }

  /* ③ "公司/团队/项目…(名字)?(叫)X" —— 显式（强）
   *    覆盖 "我们公司叫火星科技" / "团队叫火星小队" / "项目名叫春晓" */
  if (!name) {
    const m3 = new RegExp(
      '^(?:我|我们|咱们|俺)?(?:的)?(?:' + ORG_WORD + ')(?:名字|名称)?(?:叫|名叫|叫做)(.{2,20})$'
    ).exec(s);
    if (m3) { name = m3[1]; explicit = true; }
  }

  /* ④ "叫X" / "名叫X" —— 显式（强） */
  if (!name) {
    const m4 = /^(?:是叫|名叫|叫做|叫)(.{2,20})$/.exec(s);
    if (m4) { name = m4[1]; explicit = true; }
  }

  /* ⑤ 整句就是个带后缀的名称："XX店" / "XX公司" / "春晓项目"
   *    ⚠️ Node.js regex 里 `^(.{N,M}(?:SUFFIX))$` 这种组合有引擎 bug（实测 `.{2,18}` 配
   *       长 alternation 在 ^...$ 里会吞整句，group 1 拿到全串），所以**分两步**：
   *       先看 s 是否以某个后缀结尾 → 整句就是 name（带后缀）。
   *    例 "老李水果店" → name="老李水果店"（后缀是名字的一部分）。 */
  if (!name) {
    const mSuf = new RegExp('(' + ENTITY_SUFFIX + ')$').exec(s);
    if (mSuf) {
      const suf = mSuf[0];
      const candidate = s.slice(0, s.length - suf.length);
      if (candidate.length >= 1 && candidate.length <= 19) {  // 后缀至少 1 字 + 候选最多 19 字 → 总长 ≤ 20
        name = s;          // 整句就是名字（包含后缀）
        hasSuffix = true;
      }
    }
  }

  /* ⑥ "我是做X的" / "我做X生意" —— 只给领域，不给名称 */
  if (!name) {
    const m6 = /^(?:我是|我做|我做的是|我是做|我们是做)(?:做)?(.{1,14}?)(?:的|生意|行业)?$/.exec(s);
    if (m6 && m6[1]) {
      const ind = industryOf(m6[1]);
      if (ind) return { name: '', industry: ind, industryOnly: true };
      return null;
    }
  }

  if (!name) return null;

  /* 清理引导词 —— 总是跑。
   * - pattern ④ 抓的 "叫X" 可能含前缀 "我叫/我们叫"，统一在这里剥一次。
   * - pattern ⑤ 整句带后缀：像 "我们叫火星小队" → 剥 "我们叫" → "火星小队"；
   *   像 "老李水果店" 没有前缀，剥不动。两种都对。
   *
   * ⚠️ JS regex 的 alternation 顺序很关键 —— 必须把长的放前面！
   *   `(?:我|我们|咱们)+` 会先贪"我"然后因下一个字符不匹配而停在"我"，
   *   导致 "我们叫火星小队" 只剥掉"我"变成"们叫火星小队"。
   *   把"我们/咱们"放前面让引擎先试长的。 */
  name = name
    .replace(/^(?:我们|咱们|名叫|叫做|我|是|叫|的)+/, '')
    .replace(/(?:的|了|吧|啊|呢|嘛)+$/, '')
    .trim();

  /* 砍掉后缀之后的尾巴："水果店卖苹果" → "水果店"
   * pattern ⑤ 来的 name 不带后缀（本身就是后缀结尾），这里就退化成空操作。 */
  const cut = SUFFIX_RE.exec(name);
  if (cut) name = name.slice(0, cut.index + cut[0].length);

  name = name.trim();
  if (name.length < 2 || name.length > 20) return null;

  /* 🔴 硬门槛：三条路走通一条才认，否则判定"不是在说名称"。
   *   1) 带组织后缀（水果店 / 火星科技公司）
   *   2) 能识别出领域（老王鲜果 → 水果）
   *   3) 老板**明说**了这是名字（"店名是X" / "我们公司叫X"）→ 且整句有实体关键词
   *
   * 例子：
   *   "我开完会再说" → ① 得到 "完会再说" → 没后缀/领域/显式 → null
   *   "我们公司叫火星科技" → ③ 显式 + "公司"关键词 → 收
   *   "叫我去开会" → ④ 显式 但没后缀/领域/关键词 → null（防误判）
   *   "我叫老李水果店" → ④ 显式 + 有后缀 → 收
   *
   *   🔴 不再加"我叫X无后缀也收"这种放宽：人名（张姐、老王）当店名太危险，
   *      万一老板把"我"打错、或者想"我叫张姐去问她要个报价"也会被收。
   *      想要"自我介绍"作为店铺名，让他加上"私房菜""工作室"这类词。 */
  // 剥离后缀后的 candidate 不再带后缀，但 hasSuffix 已经从 pattern ⑤ 记录了
  const industry = industryOf(name);
  if (!hasSuffix && !industry && !(explicit && EXPLICIT_ENTITY_RE.test(s))) return null;

  return { name: name, industry: industry };
}

/**
 * 从任意文本里识别领域。识别不出返回 null（**不猜**）。
 * @param {string} text
 * @returns {string|null}
 */
function industryOf(text) {
  const s = String(text == null ? '' : text);
  for (let i = 0; i < INDUSTRY_RULES.length; i++) {
    if (INDUSTRY_RULES[i].re.test(s)) return INDUSTRY_RULES[i].name;
  }
  return null;
}

/**
 * 显式输入路径 —— 老板在"改名称"弹窗里手填的内容。
 *
 * ── 和 parse() 的区别 ──
 *   parse() 是**从自由对话里猜**，所以宁严勿松。
 *   本函数是老板**明确**在填名称，所以规则放宽：只要长度合法就收，
 *   领域能认就认（认不出也不拦 —— 名字可以先只有名字）。
 *
 * @param {string} text
 * @returns {{name:string, industry:string|null}|null} 长度不合法返回 null
 */
function fromExplicitInput(text) {
  const name = String(text == null ? '' : text)
    .replace(/[\s，。！!？?、,.~～]+/g, '')
    .trim();

  if (name.length < 2 || name.length > 20) return null;
  return { name: name, industry: industryOf(name) };
}

/**
 * 引导语用：把解析结果拼成给老板看的确认文案。
 * ⚠️ 不要写"你开的店" —— 用的人可能是公司/团队/项目。
 * @param {{name:string, industry:string|null}} r
 */
function confirmText(r) {
  const hasName = !!(r && r.name);
  const name = hasName ? '「' + r.name + '」' : '';
  const ind = r && r.industry ? '（' + r.industry + '）' : '';

  if (!hasName && r && r.industry) {
    return '好嘞 —— 记住了：您是做' + r.industry + '的。以后算账我按这个帮您分类。';
  }
  return '好嘞 —— 记住了：' + name + ind + '。以后算账我按这个帮您分类。';
}

module.exports = {
  parse,
  fromExplicitInput,
  industryOf,
  confirmText,
  INDUSTRY_RULES,
  ENTITY_SUFFIX
};

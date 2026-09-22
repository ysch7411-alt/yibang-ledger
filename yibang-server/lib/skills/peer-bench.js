/**
 * 能力：跟同行比一比
 *
 * 这是**平台独有的资产**：单个老板永远算不出"别人家的成本占比是多少"，
 * 只有把很多店的账脱敏聚合起来才有这个数。用户越多基准越准 —— 所以它同时是护城河。
 *
 * 🔴 但样本不够时**必须诚实说"比不了"**，绝不能拿三五个店的数字当"同行平均"：
 *    那既不准（个别店的特征会变成"行业标准"），又可能反过来**泄露某一家的情况**
 *    （比如总共就 3 家店，平均值等于把别人的账说出来了）。
 *
 * 两道守卫：
 *   ① **够格的店**才算样本：最近 30 天至少 30 笔 —— 把测试号和刚注册的空号挡在外面
 *      （否则基准会被"几乎没有记录"的店拉偏）；
 *   ② **样本量下限**：低于 MIN_STORES 家直接不给对比，只给老板自己的数。
 */
const pool = require('../../db/config');
const { round2 } = require('../ledger');

const MIN_STORES = 20;      // 低于这个数不给对比
const MIN_ROWS = 30;        // 一家店至少这么多笔才算"够格样本"
const WINDOW = 30;          // 观察窗口：最近 30 天

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 中位数比平均数稳：一两家大店就能把平均数拉飞 */
function median(nums) {
  if (!nums.length) return null;
  const a = nums.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : round2((a[m - 1] + a[m]) / 2);
}

module.exports = {
  name: 'peer_bench',
  when: '老板问自己的成本正不正常、跟同行比怎么样、别人家一般多久回款、我这算高还是低。',
  params: {},
  risk: 'read',

  async run(userId) {
    const today = todayStr();

    // 这家店自己的两个关键比率
    const [mine] = await pool.query(
      'SELECT ' +
      'COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END),0) AS income, ' +
      'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END),0) AS expense, ' +
      'COUNT(*) AS cnt ' +
      'FROM transactions WHERE user_id = ? AND status = 1 AND record_date >= DATE_SUB(?, INTERVAL ? DAY)',
      [userId, today, WINDOW]
    );
    const m = mine[0] || {};
    const myIncome = round2(m.income), myExpense = round2(m.expense), myCnt = Number(m.cnt) || 0;
    if (myIncome <= 0 || myCnt < 5) {
      return { enough: false, reason: 'my_data_too_little', myCnt, myIncome, myExpense };
    }
    const myRatio = Math.round((myExpense / myIncome) * 100);

    // 平台聚合（**排除自己**，且只算"够格"的店）
    const [rows] = await pool.query(
      'SELECT user_id, ' +
      'COALESCE(SUM(CASE WHEN type IN (1,5) THEN amount ELSE 0 END),0) AS income, ' +
      'COALESCE(SUM(CASE WHEN type IN (2,6) THEN amount ELSE 0 END),0) AS expense, ' +
      'COUNT(*) AS cnt ' +
      'FROM transactions WHERE status = 1 AND record_date >= DATE_SUB(?, INTERVAL ? DAY) ' +
      'GROUP BY user_id HAVING cnt >= ?',
      [today, WINDOW, MIN_ROWS]
    );

    const peers = rows.filter((r) => Number(r.user_id) !== Number(userId) && Number(r.income) > 0);
    const ratios = peers.map((r) => Math.round((Number(r.expense) / Number(r.income)) * 100));

    return {
      enough: ratios.length >= MIN_STORES,
      sample: ratios.length,
      minStores: MIN_STORES,
      myRatio,
      myIncome, myExpense, myCnt,
      peerRatio: median(ratios),
      window: WINDOW
    };
  },

  summarize(r) {
    if (r.reason === 'my_data_too_little') {
      return '你自己最近 ' + r.window + ' 天的记录还不够（' + r.myCnt + ' 笔），比之前先多记几笔吧。';
    }
    const mine = '你自己最近 ' + r.window + ' 天：收入 ¥' + r.myIncome.toFixed(2) +
      '、支出 ¥' + r.myExpense.toFixed(2) + '，**支出占收入 ' + r.myRatio + '%**。';

    if (!r.enough) {
      // 这是最该守住的一句：样本不够就说不够，不拿别人的账当"行业标准"
      return mine + '暂时比不了同行 —— 平台上有完整记录的店还不够多（需要 ' + r.minStores +
        ' 家以上才算数），现在拿几家的数当"同行平均"既不准、也可能反过来暴露别家的情况。' +
        '等店多起来我会主动告诉你。';
    }
    const gap = r.myRatio - r.peerRatio;
    const verdict = Math.abs(gap) <= 5 ? '基本持平'
      : (gap > 0 ? '高出 ' + gap + ' 个百分点' : '低了 ' + Math.abs(gap) + ' 个百分点');
    return mine + '同行（' + r.sample + ' 家可比门店）的中位数是 ' + r.peerRatio + '%，你' + verdict + '。';
  }
};

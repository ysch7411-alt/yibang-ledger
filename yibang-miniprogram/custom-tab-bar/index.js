// custom-tab-bar/index.js
//
// 列表/显隐/主题由各 tab 页经 getTabBar().setData() 推进来（utils/page-config.js 的
// onShow 包裹里统一做）—— **组件自己不 require utils/config**：自定义组件的模块解析
// 和页面不同，页面里好的 `../../utils/xxx` 路径在组件里解析不到（实测报
// can not find module），这是踩过的坑。data 里的 list 只是配置没拉到时的兜底。
Component({
  options: {
    // 允许页面上的 .container 通过 CSS 变量控制底部留白，避免与 tabBar 高度对不上
    styleIsolation: 'apply-shared'
  },

  data: {
    selected: 0,
    // 兜底列表：和 app.json 的 tabBar 一致，配置没拉到时导航照样能用
    list: [
      { pagePath: '/pages/record/record', text: '记账', icon: '/images/tab-record.svg', iconOn: '/images/tab-record-on.svg' },
      { pagePath: '/pages/summary/summary', text: '报表', icon: '/images/tab-chart.svg', iconOn: '/images/tab-chart-on.svg' },
      { pagePath: '/pages/advisor/advisor', text: 'AI 参谋', icon: '/images/tab-advisor.svg', iconOn: '/images/tab-advisor-on.svg' },
      { pagePath: '/pages/profile/profile', text: '我的', icon: '/images/tab-mine.svg', iconOn: '/images/tab-mine-on.svg' }
    ],
    _cv: '',
    _cfgTabVer: -1
  },

  methods: {
    onTap(e) {
      const { path, index } = e.currentTarget.dataset;
      if (index === this.data.selected) return;
      this.setData({ selected: index });
      wx.switchTab({ url: path });
    }
  }
});

// custom-tab-bar/index.js
Component({
  options: {
    // 允许页面上的 .container 通过 CSS 变量控制底部留白，避免与 tabBar 高度对不上
    styleIsolation: 'apply-shared'
  },

  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/record/record', text: '记账', icon: '/images/tab-record.svg', iconOn: '/images/tab-record-on.svg' },
      { pagePath: '/pages/summary/summary', text: '报表', icon: '/images/tab-chart.svg', iconOn: '/images/tab-chart-on.svg' },
      { pagePath: '/pages/search/search', text: '查询', icon: '/images/tab-search.svg', iconOn: '/images/tab-search-on.svg' },
      { pagePath: '/pages/advisor/advisor', text: '参谋', icon: '/images/tab-advisor.svg', iconOn: '/images/tab-advisor-on.svg' },
      { pagePath: '/pages/profile/profile', text: '我的', icon: '/images/tab-mine.svg', iconOn: '/images/tab-mine-on.svg' }
    ]
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

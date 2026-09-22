// pages/role-manage/role-manage.js
const app = getApp();

Page({
  data: {
    members: [],
    loading: true,
    myId: null,
    isOwner: false,
    myRole: 1,
    showAdd: false,
    adding: false,
    kbLift: 0,
    addForm: {
      phone: '',
      role: 4
    },
    showChangeRole: false,
    changeTarget: {
      id: null,
      name: '',
      role: 4
    }
  },

  onLoad() {
    this.loadMyInfo();
    this.loadMembers();
  },

  onShow() {
    this.loadMembers();
  },

  /**
   * 加载我的信息，判断是否是店主
   */
  async loadMyInfo() {
    try {
      const res = await app.request('/roles/my-role');
      if (res.code === 0) {
        this.setData({
          myId: res.data.id,
          isOwner: res.data.role === 1,
          myRole: res.data.role
        });
      }
    } catch (err) {
      console.error('获取我的角色失败:', err);
    }
  },

  /**
   * 加载成员列表
   */
  async loadMembers() {
    try {
      this.setData({ loading: true });
      const res = await app.request('/roles/members');
      if (res.code === 0) {
        /* 头像首字在 JS 里算好：WXML 的数据绑定**不支持方法调用**，
           模板里原来写的 {{item.nickname.charAt(0)}} 不报错但渲染为空白，
           于是成员头像一直是个空橙圆圈（contacts / contact-detail 同样毛病）。 */
        const members = (res.data || []).map(m => ({
          ...m,
          initial: (m.nickname || '?').slice(0, 1)
        }));
        this.setData({ members });
      }
    } catch (err) {
      console.error('加载成员列表失败:', err);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 打开添加成员弹层
   */
  openAdd() {
    this.setData({
      showAdd: true,
      addForm: { phone: '', role: 4 }
    });
  },

  /**
   * 关闭添加成员弹层
   */
  closeAdd() {
    this.setData({ showAdd: false });
  },

  /**
   * 表单输入
   */
  onAddPhone(e) {
    const val = (e.detail.value || '').replace(/\D/g, '').slice(0, 11);
    this.setData({ 'addForm.phone': val });
  },

  /**
   * 设置添加角色
   */
  setAddRole(e) {
    const role = parseInt(e.currentTarget.dataset.role);
    this.setData({ 'addForm.role': role });
  },

  /**
   * 键盘高度变化
   */
  onKbFocus(e) {
    this.setData({ kbLift: e.detail.height || 0 });
  },
  onKbBlur() {
    this.setData({ kbLift: 0 });
  },
  onKbHeight(e) {
    this.setData({ kbLift: e.detail.height || 0 });
  },

  /**
   * 保存添加成员
   */
  async saveAdd() {
    const { addForm, adding } = this.data;
    if (adding) return;

    if (!addForm.phone.trim()) {
      wx.showToast({ title: '请输入手机号', icon: 'none' });
      return;
    }
    if (!/^1\d{10}$/.test(addForm.phone.trim())) {
      wx.showToast({ title: '手机号格式不正确', icon: 'none' });
      return;
    }

    this.setData({ adding: true });
    try {
      const res = await app.request('/roles/add', {
        method: 'POST',
        data: {
          phone: addForm.phone.trim(),
          role: addForm.role
        }
      });

      if (res.code === 0) {
        wx.showToast({ title: '添加成功', icon: 'success' });
        this.setData({ showAdd: false });
        this.loadMembers();
      } else {
        wx.showToast({ title: res.msg || '添加失败', icon: 'none' });
      }
    } catch (err) {
      console.error('添加成员失败:', err);
      wx.showToast({ title: '添加失败', icon: 'none' });
    } finally {
      this.setData({ adding: false });
    }
  },

  /**
   * 修改角色
   */
  changeRole(e) {
    const { id, role, name } = e.currentTarget.dataset;
    this.setData({
      showChangeRole: true,
      changeTarget: { id, name, role: parseInt(role) }
    });
  },

  /**
   * 关闭修改角色弹层
   */
  closeChangeRole() {
    this.setData({ showChangeRole: false });
  },

  /**
   * 确认修改角色
   */
  async confirmChangeRole(e) {
    const role = parseInt(e.currentTarget.dataset.role);
    const { changeTarget } = this.data;

    try {
      const res = await app.request('/roles/change-role', {
        method: 'POST',
        data: {
          user_id: changeTarget.id,
          role
        }
      });

      if (res.code === 0) {
        wx.showToast({ title: '修改成功', icon: 'success' });
        this.setData({ showChangeRole: false });
        this.loadMembers();
      } else {
        wx.showToast({ title: res.msg || '修改失败', icon: 'none' });
      }
    } catch (err) {
      console.error('修改角色失败:', err);
      wx.showToast({ title: '修改失败', icon: 'none' });
    }
  },

  /**
   * 移除成员
   */
  removeMember(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '确认移除',
      content: `确定要移除「${name || '该成员'}」吗？移除后对方将无法再查看本店账目。`,
      confirmText: '移除',
      confirmColor: '#F04438',
      success: async (res) => {
        if (res.confirm) {
          try {
            const result = await app.request('/roles/remove', {
              method: 'POST',
              data: { user_id: id }
            });
            if (result.code === 0) {
              wx.showToast({ title: '已移除', icon: 'success' });
              this.loadMembers();
            } else {
              wx.showToast({ title: result.msg || '移除失败', icon: 'none' });
            }
          } catch (err) {
            console.error('移除成员失败:', err);
            wx.showToast({ title: '移除失败', icon: 'none' });
          }
        }
      }
    });
  },

  goOperationLogs() {
    wx.navigateTo({ url: '/pages/operation-logs/operation-logs' });
  }
});

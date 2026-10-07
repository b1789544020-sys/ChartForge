/* ===================================================================
 * ChartForge · 图表模板（保存/加载/匹配）
 *   序列化图表配置；下次拖入相同结构的数据时自动应用
 * =================================================================== */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'chartforge:templates';

  const Template = {
    _list: [],

    init: function () {
      // 通过 Store 层读取：自带版本校验与 JSON 损坏兜底。
      // 早期版本直接存裸数组，Store.read 会原样返回，这里做一次归一化。
      const data = global.Store ? Store.read(STORAGE_KEY, []) : [];
      this._list = Array.isArray(data) ? data : [];
      return this;
    },

    list: function () {
      return this._list.slice();
    },

    save: function (name) {
      const tpl = {
        name: name || ('模板 ' + (this._list.length + 1)),
        chartType: State.currentChartType,
        fields: JSON.parse(JSON.stringify(State.fields)),
        style: JSON.parse(JSON.stringify(State.style)),
        columnSignature: DataSource.columnSignature(),
        createdAt: Date.now()
      };
      this._list.unshift(tpl);
      this._persist();
      return tpl;
    },

    remove: function (index) {
      this._list.splice(index, 1);
      this._persist();
    },

    apply: function (tpl) {
      State.currentChartType = tpl.chartType;
      State.fields = JSON.parse(JSON.stringify(tpl.fields));
      State.style = JSON.parse(JSON.stringify(tpl.style || State.style));
    },

    // ---------- 别名：兼容 E2E / 业务层常见命名 ----------
    findMatch: function () { return this.autoMatch(); },

    // 按名称查找并应用模板（兼容 E2E：Template.load(name)）
    load: function (name) {
      const tpl = this._list.find(t => t && t.name === name);
      if (!tpl) return null;
      this.apply(tpl);
      return tpl;
    },

    // ---------- 自动匹配模板 ----------
    // DataSource.columnSignature() 返回字符串形如 "string|number#城市,销量"，
    // 这里统一拆成 token 数组再比较，同时兼容旧模板中存成数组的签名。
    _sigTokens: function (sig) {
      if (Array.isArray(sig)) return sig.map(s => String(s).trim().toLowerCase());
      if (typeof sig !== 'string' || !sig) return [];
      const parts = sig.split('#');
      const types = (parts[0] || '').split('|').filter(Boolean);
      const names = (parts[1] || '').split(',').filter(Boolean);
      // 用「列名:类型」作为 token，既区分列名也区分类型
      if (names.length) return names.map((n, i) => n.trim().toLowerCase() + ':' + (types[i] || '?'));
      return types;
    },

    autoMatch: function () {
      const sig = DataSource.columnSignature();
      const sigTokens = this._sigTokens(sig);
      if (!sigTokens.length) return null;
      // 1) 完全匹配（按顺序）
      const exact = this._list.find(t => {
        const tt = this._sigTokens(t && t.columnSignature);
        return tt.length === sigTokens.length && tt.every((s, i) => s === sigTokens[i]);
      });
      if (exact) return { template: exact, score: 1.0, mode: 'exact' };
      // 2) 列名+类型相似
      let best = null, bestScore = 0;
      this._list.forEach(t => {
        const tt = this._sigTokens(t && t.columnSignature);
        if (!tt.length) return;
        const score = Utils.colSignatureSimilarity(tt, sigTokens);
        if (score > bestScore) { bestScore = score; best = t; }
      });
      if (best && bestScore >= 0.6) return { template: best, score: bestScore, mode: 'similar' };
      return null;
    },

    _persist: function () {
      if (global.Store) {
        Store.write(STORAGE_KEY, this._list);
        return;
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this._list));
      } catch (e) {}
    }
  };

  Template.init();
  global.Template = Template;
})(window);
/* ===================================================================
 * ChartForge · 多图表联动
 *   同数据源多图表，事件总线选中 → 同步高亮
 * =================================================================== */
(function (global) {
  'use strict';

  const bus = {
    _listeners: {},
    on: function (evt, fn) {
      (this._listeners[evt] = this._listeners[evt] || []).push(fn);
    },
    off: function (evt, fn) {
      const arr = this._listeners[evt] || [];
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    emit: function (evt, data) {
      (this._listeners[evt] || []).forEach(fn => {
        try { fn(data); } catch (e) { console.error(e); }
      });
    }
  };

  // 存储多图表配置
  let panels = [];   // { id, chartType, title, fields, style, selectedRowIdx }

  const STORAGE_KEY = 'chartforge:dashboard';

  const Dashboard = {
    enabled: false,
    panels: panels,
    // 恢复时若数据结构不匹配，记录原因供 UI / 诊断使用
    lastRestore: null,

    init: function (rootId) {
      this.root = typeof rootId === 'string' ? document.getElementById(rootId) : rootId;
      this._bindBus();
      this.render();
    },

    _bindBus: function () {
      // 任一图表选中数据 → 其他图表也高亮
      const self = this;
      bus.on('select', function (info) {
        if (!self.enabled) return;
        panels.forEach(p => {
          if (p.id === info.sourceId) return;
          const chart = ChartRenderer.instances[p.id];
          if (!chart) return;
          // 使用 dispatchAction 高亮
          try {
            chart.dispatchAction({
              type: 'downplay'
            });
            if (info.dataIndex != null) {
              chart.dispatchAction({
                type: 'highlight',
                dataIndex: info.dataIndex,
                seriesIndex: info.seriesIndex || 0
              });
            }
          } catch (e) {}
        });
      });
      bus.on('unselect', function () {
        if (!self.enabled) return;
        panels.forEach(p => {
          const chart = ChartRenderer.instances[p.id];
          if (!chart) return;
          try { chart.dispatchAction({ type: 'downplay' }); } catch (e) {}
        });
      });
    },

    setEnabled: function (v) {
      this.enabled = !!v;
      this.render();
      this.persist();
    },

    // 别名：兼容业务层/E2E 常见命名
    addChart: function (config) { return this.addPanel(config); },
    addLinkedChart: function (config) { return this.addPanel(config); },
    enableMulti: function () { this.setEnabled(true); },
    disableMulti: function () { this.setEnabled(false); },
    getPanels: function () { return this.getCurrentPanels(); },

    addPanel: function (config) {
      // config: { id?, chartType, title, fields, style }
      const id = config.id || ('chart_' + Date.now() + '_' + Math.floor(Math.random() * 1000));
      const panel = {
        id: id,
        chartType: config.chartType || 'bar',
        title: config.title || '新图表',
        fields: config.fields || { x: null, y: [] },
        style: config.style || JSON.parse(JSON.stringify(State.style))
      };
      panels.push(panel);
      // 记录这批面板是基于哪套列结构建的，换数据源时用来判断是否还有效
      this.basisSignature = DataSource.columnSignature();
      // render() 内部已经会绘制全部面板，这里不再重复调用 _renderOne
      this.render();
      this.persist();
      return id;
    },

    removePanel: function (id) {
      ChartRenderer.dispose(id);
      // 原地删除，保持 Dashboard.panels 与 panels 指向同一数组
      const i = panels.findIndex(p => p.id === id);
      if (i !== -1) panels.splice(i, 1);
      this.render();
      this.persist();
    },

    updatePanel: function (id, patch) {
      const p = panels.find(x => x.id === id);
      if (!p) return;
      Object.assign(p, patch);
      this._renderOne(p);
      this.persist();
    },

    render: function () {
      if (!this.root) return;
      if (!this.enabled || panels.length === 0) {
        this.root.innerHTML = '';
        return;
      }
      let html = '<div class="dashboard-header"><h3>📊 多图表联动（' + panels.length + '）</h3></div>';
      html += '<div class="dashboard-grid">';
      panels.forEach(p => {
        html += '<div class="dash-panel" data-panel-id="' + p.id + '">';
        html += '<div class="dash-panel-header">';
        html += '<span class="dash-panel-title">' + Utils.escapeHtml(p.title) + '</span>';
        html += '<span class="dash-panel-type">' + p.chartType + '</span>';
        html += '<button class="dash-remove" data-id="' + p.id + '" title="删除图表">×</button>';
        html += '</div>';
        html += '<div class="dash-panel-body"><div id="' + p.id + '" class="dash-chart"></div></div>';
        html += '</div>';
      });
      html += '</div>';
      this.root.innerHTML = html;
      this._bindPanelEvents();
      // 渲染每个图
      panels.forEach(p => this._renderOne(p));
    },

    _bindPanelEvents: function () {
      const self = this;
      this.root.querySelectorAll('.dash-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          if (panels.length > 1 || confirm('确认删除该图表？')) {
            self.removePanel(btn.dataset.id);
          }
        });
      });
    },

    _renderOne: function (p) {
      if (!DataSource.current.columns.length) return;
      // 短暂等待 DOM 渲染完
      setTimeout(() => {
        try {
          ChartRenderer.render(p.id, p.chartType, p.fields, p.style);
          // 绑定选中事件
          const chart = ChartRenderer.instances[p.id];
          if (chart) {
            chart.on('click', function (params) {
              bus.emit('select', { sourceId: p.id, dataIndex: params.dataIndex, seriesIndex: params.seriesIndex });
            });
          }
        } catch (e) {
          console.error('Render dashboard chart failed:', e);
        }
      }, 0);
    },

    getCurrentPanels: function () {
      return panels.slice();
    },

    clear: function () {
      panels.forEach(p => ChartRenderer.dispose(p.id));
      // 原地清空而不是重新赋值，否则 Dashboard.panels 会指向旧数组（成为陈旧引用）
      panels.length = 0;
      this.render();
      this.persist();
    },

    // ================= 布局持久化 =================
    // 面板的 fields 存的是「列索引」，脱离具体数据源就没有意义。
    // 因此连同列签名一起存，恢复时校验，不匹配就不盲目套用。
    persist: function () {
      if (!global.Store) return false;
      // 没有任何面板时直接清掉记录，避免留下空壳
      if (!panels.length && !this.enabled) {
        Store.remove(STORAGE_KEY);
        return true;
      }
      return Store.write(STORAGE_KEY, {
        enabled: this.enabled,
        columnSignature: DataSource.columnSignature(),
        panels: panels.map(p => ({
          id: p.id,
          chartType: p.chartType,
          title: p.title,
          fields: p.fields,
          style: p.style
        })),
        savedAt: Date.now()
      });
    },

    // 读取已保存的布局（不应用）
    peekSaved: function () {
      if (!global.Store) return null;
      const saved = Store.read(STORAGE_KEY, null);
      if (!saved || !Array.isArray(saved.panels)) return null;
      return saved;
    },

    // 单个面板的字段引用是否仍然有效（列索引未越界）
    _fieldsValid: function (fields, colCount) {
      if (!fields) return false;
      const idx = [];
      if (fields.x != null) idx.push(fields.x);
      if (Array.isArray(fields.y)) idx.push.apply(idx, fields.y);
      else if (fields.y != null) idx.push(fields.y);
      if (fields.value != null) idx.push(fields.value);
      if (fields.size != null) idx.push(fields.size);
      if (!idx.length) return false;
      return idx.every(i => Number.isInteger(i) && i >= 0 && i < colCount);
    },

    // 恢复布局。
    // 只在列签名匹配当前数据源时才恢复，否则列索引会指向不相干的列，
    // 画出张冠李戴的图 —— 那比不恢复更糟。
    restore: function (opts) {
      opts = opts || {};
      const saved = this.peekSaved();
      if (!saved) {
        this.lastRestore = { ok: false, reason: 'no-saved-layout', restored: 0 };
        return this.lastRestore;
      }
      const sig = DataSource.columnSignature();
      const sigMatch = saved.columnSignature === sig;
      if (!sigMatch && !opts.force) {
        this.lastRestore = {
          ok: false,
          reason: 'signature-mismatch',
          restored: 0,
          savedSignature: saved.columnSignature,
          currentSignature: sig
        };
        return this.lastRestore;
      }

      // 丢弃列索引已越界的面板（例如换成了列更少的同签名数据）
      const colCount = DataSource.current.columns.length;
      const usable = saved.panels.filter(p => this._fieldsValid(p.fields, colCount));
      const dropped = saved.panels.length - usable.length;

      // 先销毁现有实例，避免旧 canvas 泄漏
      panels.forEach(p => ChartRenderer.dispose(p.id));
      panels.length = 0;
      usable.forEach(p => {
        panels.push({
          id: p.id || ('chart_' + Date.now() + '_' + Math.floor(Math.random() * 1000)),
          chartType: p.chartType || 'bar',
          title: p.title || '图表',
          fields: p.fields,
          style: p.style || JSON.parse(JSON.stringify(State.style))
        });
      });

      this.enabled = !!saved.enabled && panels.length > 0;
      this.basisSignature = sig;
      this.render();
      this.lastRestore = {
        ok: panels.length > 0,
        reason: panels.length ? (sigMatch ? 'restored' : 'restored-forced') : 'all-panels-invalid',
        restored: panels.length,
        dropped: dropped
      };
      // 清理过的结果要写回，否则下次仍会读到失效面板
      if (dropped > 0) this.persist();
      return this.lastRestore;
    },

    // 显式丢弃已保存布局
    clearSaved: function () {
      if (global.Store) Store.remove(STORAGE_KEY);
    },

    // 数据源变化后调用：
    // 面板的 fields 是列索引，一旦换成列结构不同的数据，这些索引就指向了
    // 不相干的列，继续显示等于画错图。这里把过时面板从界面上卸下来，
    // 但**保留 localStorage 存档** —— 用户换回原数据时还能自动恢复。
    syncToData: function () {
      if (!panels.length) return { changed: false, reason: 'no-panels' };
      const sig = DataSource.columnSignature();
      if (this.basisSignature == null) this.basisSignature = sig;
      if (this.basisSignature === sig) return { changed: false, reason: 'signature-unchanged' };

      const colCount = DataSource.current.columns.length;
      const stale = panels.filter(p => !this._fieldsValid(p.fields, colCount));
      // 列数仍然够用但结构不同（例如列名全变了）也视为过时，避免张冠李戴
      const dropAll = stale.length > 0 || this.basisSignature !== sig;
      if (!dropAll) return { changed: false, reason: 'still-valid' };

      const removed = panels.length;
      panels.forEach(p => ChartRenderer.dispose(p.id));
      panels.length = 0;
      this.enabled = false;
      this.basisSignature = sig;
      this.render();
      // 注意：不调用 persist()，否则会把空看板写回去、覆盖掉有效存档
      return { changed: true, reason: 'dropped-stale', removed: removed };
    }
  };

  global.ChartBus = bus;
  global.Dashboard = Dashboard;
  global.ChartDashboard = Dashboard; // alias
})(window);

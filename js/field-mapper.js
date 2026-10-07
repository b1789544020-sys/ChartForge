/* ===================================================================
 * ChartForge · 字段映射（拖拽交互）
 *   字段卡片 → 槽位
 *   槽位：X / Y / Value / Size
 * =================================================================== */
(function (global) {
  'use strict';

  const FieldMapper = {
    el: null,
    chartId: null,

    init: function (containerId, chartId) {
      this.el = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
      this.chartId = chartId || 'mainChart';
      this.render();
      this._bindGlobalDnD();
    },

    render: function () {
      if (!this.el) return;
      const ds = DataSource.current;
      const chartType = State.currentChartType;
      const slots = Recommend.slotsFor(chartType);

      let html = '<div class="field-mapper">';
      // 字段池
      html += '<div class="field-pool">';
      html += '<div class="pool-title">📋 字段（拖到右侧）</div>';
      html += '<div class="pool-list" id="fieldPoolList">';
      if (ds.columns.length === 0) {
        html += '<div class="empty-hint small">请先导入数据</div>';
      } else {
        ds.columns.forEach((col, i) => {
          const type = ds.types[i] || 'text';
          html += '<div class="field-card field-type-' + type + '" draggable="true" data-col="' + i + '" data-name="' + Utils.escapeHtml(col) + '">';
          html += '<span class="field-icon">' + this._typeIcon(type) + '</span>';
          html += '<span class="field-name">' + Utils.escapeHtml(col) + '</span>';
          html += '<span class="field-type-badge">' + this._typeLabel(type) + '</span>';
          html += '</div>';
        });
      }
      html += '</div></div>';

      // 槽位
      html += '<div class="field-slots">';
      html += '<div class="slots-title">🎯 映射槽位</div>';
      slots.forEach(slot => {
        const cur = State.fields[slot];
        // y 槽位是数组（可多列）；其余槽位是单个列索引。
        // 原实现对两者都走 ds.columns[cur]，数组下标会得到 undefined，
        // 导致映射多个 y 字段时槽位退回“拖入字段”占位符。
        const cols = slot === 'y'
          ? (Array.isArray(cur) ? cur : (cur != null ? [cur] : []))
          : (cur != null ? [cur] : []);
        const valid = cols.filter(c => ds.columns[c] != null);

        let content;
        if (valid.length) {
          content = valid.map(c => this._chipHtml(slot, c, ds)).join('');
        } else {
          content = '<div class="slot-placeholder">拖入字段</div>';
        }
        html += '<div class="slot-row">';
        html += '<div class="slot-label">' + this._slotLabel(slot) + (slot === 'y' ? '<span class="multi-hint">（可多个）</span>' : '') + '</div>';
        html += '<div class="slot-drop" data-slot="' + slot + '">' + content + '</div>';
        html += '</div>';
      });
      html += '</div>';
      html += '</div>';

      this.el.innerHTML = html;
      this._bindDnD();
    },

    // 单个已映射字段的 chip。y 槽位额外带一个颜色覆盖色块。
    _chipHtml: function (slot, col, ds) {
      const type = ds.types[col] || 'text';
      const name = ds.columns[col];
      let h = '<div class="slot-chip" draggable="true" data-col="' + col + '" data-name="' + Utils.escapeHtml(name) + '">';
      h += '<span class="field-icon">' + this._typeIcon(type) + '</span>';
      h += '<span class="field-name">' + Utils.escapeHtml(name) + '</span>';
      if (slot === 'y') {
        const cur = this._seriesColor(col);
        h += '<input type="color" class="series-color" data-col="' + col + '"' +
             ' value="' + cur + '" title="自定义该系列颜色（覆盖调色板）" />';
        if (State.style.seriesColors && State.style.seriesColors[name] != null) {
          h += '<button class="series-color-reset" data-col="' + col + '" title="恢复调色板颜色">⟲</button>';
        }
      }
      h += '<button class="slot-remove" data-slot="' + slot + '" data-col="' + col + '" title="移除">×</button>';
      h += '</div>';
      return h;
    },

    // 该列当前生效的颜色：优先自定义覆盖，否则取调色板中的对应位置
    _seriesColor: function (col) {
      const ds = DataSource.current;
      const name = ds.columns[col];
      const overrides = State.style.seriesColors || {};
      if (overrides[name]) return overrides[name];
      const yCols = Array.isArray(State.fields.y) ? State.fields.y : [];
      const idx = Math.max(0, yCols.indexOf(col));
      const palette = ChartRenderer._getPalette(State.style.theme);
      return palette[idx % palette.length] || '#5470c6';
    },

    _slotLabel: function (slot) {
      return { x: 'X 轴', y: 'Y 轴', value: '数值', size: '大小' }[slot] || slot;
    },
    _typeLabel: function (t) {
      return { 'number': '数值', 'time': '时间', 'category': '分类', 'text': '文本' }[t] || t;
    },
    _typeIcon: function (t) {
      return { 'number': '🔢', 'time': '🕐', 'category': '🏷️', 'text': '📝' }[t] || '📌';
    },

    _bindDnD: function () {
      const self = this;
      // 字段卡片
      this.el.querySelectorAll('.field-card').forEach(card => {
        card.addEventListener('dragstart', e => {
          e.dataTransfer.setData('text/plain', JSON.stringify({
            source: 'pool',
            col: card.dataset.col,
            name: card.dataset.name
          }));
          e.dataTransfer.effectAllowed = 'copyMove';
          card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));

        // 双击加入 y 轴
        card.addEventListener('dblclick', () => {
          const col = parseInt(card.dataset.col, 10);
          self.assignTo('y', col);
        });
      });

      // 槽位
      this.el.querySelectorAll('.slot-drop').forEach(slot => {
        slot.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          slot.classList.add('drag-over');
        });
        slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
        slot.addEventListener('drop', e => {
          e.preventDefault();
          slot.classList.remove('drag-over');
          try {
            const data = JSON.parse(e.dataTransfer.getData('text/plain'));
            self.assignTo(slot.dataset.slot, parseInt(data.col, 10));
          } catch (err) {}
        });
      });

      // 已填充的字段（可拖回）
      this.el.querySelectorAll('.slot-chip').forEach(chip => {
        chip.addEventListener('dragstart', e => {
          e.dataTransfer.setData('text/plain', JSON.stringify({
            source: 'slot',
            col: chip.dataset.col,
            name: chip.dataset.name
          }));
          e.dataTransfer.effectAllowed = 'move';
          chip.classList.add('dragging');
        });
        chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
      });

      // 删除按钮
      this.el.querySelectorAll('.slot-remove').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const col = btn.dataset.col != null ? parseInt(btn.dataset.col, 10) : null;
          self.removeFrom(btn.dataset.slot, col);
        });
      });

      // 系列颜色覆盖：input 事件实时预览
      this.el.querySelectorAll('.series-color').forEach(inp => {
        // 阻止色块上的拖拽冒泡到 chip，否则点击取色器会触发 dragstart
        inp.addEventListener('mousedown', e => e.stopPropagation());
        inp.addEventListener('click', e => e.stopPropagation());
        inp.addEventListener('input', e => {
          const col = parseInt(inp.dataset.col, 10);
          self.setSeriesColor(col, e.target.value);
        });
      });

      // 恢复调色板颜色
      this.el.querySelectorAll('.series-color-reset').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          self.clearSeriesColor(parseInt(btn.dataset.col, 10));
        });
      });
    },

    _bindGlobalDnD: function () {
      // 池子本身支持 drop 移除
      const self = this;
      const pool = this.el ? this.el.querySelector('#fieldPoolList') : null;
      if (pool) {
        pool.addEventListener('dragover', e => e.preventDefault());
        pool.addEventListener('drop', e => {
          e.preventDefault();
          try {
            const data = JSON.parse(e.dataTransfer.getData('text/plain'));
            if (data.source === 'slot') {
              // 从所有槽位移除该列
              const col = parseInt(data.col, 10);
              ['x', 'y', 'value', 'size'].forEach(s => {
                if (State.fields[s] === col) State.fields[s] = null;
                if (Array.isArray(State.fields[s]) && State.fields[s].indexOf(col) !== -1) {
                  State.fields[s] = State.fields[s].filter(c => c !== col);
                }
              });
              self.render();
              App.renderCurrentChart();
            }
          } catch (err) {}
        });
      }
    },

    assignTo: function (slot, col) {
      const slots = Recommend.slotsFor(State.currentChartType);
      if (slots.indexOf(slot) === -1) return;
      if (slot === 'y') {
        if (!Array.isArray(State.fields.y)) State.fields.y = [];
        if (State.fields.y.indexOf(col) === -1) {
          // 替换 X 轴的同列引用
          if (State.fields.x === col) State.fields.x = null;
          State.fields.y.push(col);
        }
      } else {
        if (State.fields[slot] === col) return;
        // 如果这个列已经在 y 中，先从 y 移除
        if (Array.isArray(State.fields.y)) {
          State.fields.y = State.fields.y.filter(c => c !== col);
        }
        State.fields[slot] = col;
      }
      this.render();
      App.renderCurrentChart();
    },

    removeFrom: function (slot, col) {
      if (slot === 'y') {
        if (col != null && !isNaN(col) && Array.isArray(State.fields.y)) {
          // 只移除指定列，保留其他已映射的 y 字段
          const name = DataSource.current.columns[col];
          State.fields.y = State.fields.y.filter(c => c !== col);
          // 顺带清掉该列的颜色覆盖，避免残留到下次映射
          if (name != null && State.style.seriesColors) {
            delete State.style.seriesColors[name];
          }
        } else {
          State.fields.y = [];
        }
      } else {
        State.fields[slot] = null;
      }
      this.render();
      App.renderCurrentChart();
    },

    // ---------- 系列颜色覆盖 ----------
    // 按「列名」而非列索引记忆：换数据源后同名列仍能保持配色，
    // 且列顺序变化不会串色。
    setSeriesColor: function (col, color) {
      const name = DataSource.current.columns[col];
      if (name == null) return;
      if (!State.style.seriesColors) State.style.seriesColors = {};
      State.style.seriesColors[name] = color;
      this.render();
      App.renderCurrentChart();
    },

    clearSeriesColor: function (col) {
      const name = DataSource.current.columns[col];
      if (name == null || !State.style.seriesColors) return;
      delete State.style.seriesColors[name];
      this.render();
      App.renderCurrentChart();
    },

    applyDefaults: function (defaults) {
      if (!defaults) return;
      State.fields = { x: null, y: null, value: null, size: null };
      if (defaults.xAxis != null) State.fields.x = defaults.xAxis;
      if (defaults.value != null) State.fields.value = defaults.value;
      if (defaults.size != null) State.fields.size = defaults.size;
      if (defaults.yAxis != null) {
        if (Array.isArray(defaults.yAxis)) {
          State.fields.y = defaults.yAxis.slice();
        } else {
          State.fields.y = [defaults.yAxis];
        }
      }
      this.render();
      App.renderCurrentChart();
    }
  };

  global.FieldMapper = FieldMapper;
})(window);
/* ===================================================================
 * ChartForge · 图表渲染核心
 *   封装 ECharts，支持折线/面积/柱状(分组/堆叠)/饼/散点/雷达/热力图
 *   字段映射 → ECharts option 转换
 *   聚合、过滤、样式
 * =================================================================== */
(function (global) {
  'use strict';

  const ChartRenderer = {
    instances: {},   // chartId → echarts instance

    // ---------- 创建 / 获取实例 ----------
    ensure: function (chartId) {
      const el = document.getElementById(chartId);
      if (!el) return null;
      const cached = this.instances[chartId];
      if (cached) {
        // 容器可能已被重建（如仪表盘 innerHTML 重绘），此时旧实例绑定在已脱离
        // 文档的节点上，必须销毁后重新初始化，否则新容器永远画不出内容。
        let stale = false;
        try {
          stale = cached.isDisposed() || cached.getDom() !== el;
        } catch (e) { stale = true; }
        if (!stale) return cached;
        try { cached.dispose(); } catch (e) {}
        delete this.instances[chartId];
      }
      // 容器上可能残留其它实例（echarts 会警告 "There is a chart instance already"）
      try {
        if (echarts.getInstanceByDom) {
          const prev = echarts.getInstanceByDom(el);
          if (prev) prev.dispose();
        }
      } catch (e) {}
      const chart = echarts.init(el, null, { renderer: 'canvas' });
      this.instances[chartId] = chart;
      return chart;
    },

    // ---------- 仅获取已存在的实例（不创建） ----------
    get: function (chartId) {
      const cached = this.instances[chartId];
      if (cached) {
        try {
          if (!cached.isDisposed()) return cached;
        } catch (e) { return cached; }
        delete this.instances[chartId];
      }
      // 兜底：通过 echarts 全局注册表查找
      try {
        const el = document.getElementById(chartId);
        if (el && echarts && echarts.getInstanceByDom) {
          const inst = echarts.getInstanceByDom(el);
          if (inst) { this.instances[chartId] = inst; return inst; }
        }
      } catch (e) {}
      return null;
    },

    // ---------- 销毁实例 ----------
    dispose: function (chartId) {
      if (this.instances[chartId]) {
        this.instances[chartId].dispose();
        delete this.instances[chartId];
      }
    },

    resize: function (chartId) {
      if (this.instances[chartId]) {
        this.instances[chartId].resize();
      }
    },

    resizeAll: function () {
      Object.keys(this.instances).forEach(id => {
        try { this.instances[id].resize(); } catch (e) {}
      });
    },

    // ---------- 数据聚合 ----------
    aggregate: function (rows, groupCol, valueCol, aggMethod) {
      // groupCol/valueCol 都是列索引；aggMethod: 'sum'/'avg'/'count'/'max'/'min'
      const buckets = new Map();
      for (const r of rows) {
        const key = r[groupCol];
        if (key === null || key === undefined || key === '') continue;
        const numVal = Utils.isNumeric(r[valueCol]) ? Utils.toNumber(r[valueCol]) : NaN;
        if (!buckets.has(key)) {
          buckets.set(key, { values: [], count: 0 });
        }
        const b = buckets.get(key);
        b.count++;
        if (!isNaN(numVal)) b.values.push(numVal);
      }
      const result = [];
      for (const [key, b] of buckets) {
        let val = 0;
        const valid = b.values.length;
        if (aggMethod === 'count') val = b.count;
        else if (valid === 0) val = 0;
        else if (aggMethod === 'sum') val = Utils.sum(b.values);
        else if (aggMethod === 'avg') val = Utils.avg(b.values);
        else if (aggMethod === 'max') val = Utils.max(b.values);
        else if (aggMethod === 'min') val = Utils.min(b.values);
        else val = Utils.sum(b.values);
        result.push({ key, value: val, count: b.count });
      }
      // 排序（按 key 字符串）
      result.sort((a, b) => {
        const an = parseFloat(a.key), bn = parseFloat(b.key);
        if (!isNaN(an) && !isNaN(bn)) return an - bn;
        return String(a.key).localeCompare(String(b.key));
      });
      return result;
    },

    // ---------- 当前用于绘制的数据集 ----------
    // 聚合开启时为聚合后的视图，否则为原始数据集
    _view: null,
    _ds: function () {
      return this._view || DataSource.current;
    },

    // ---------- 构建聚合视图 ----------
    // 按 fields.x 分组，对每个 y 列按 method 聚合，返回与原数据集同构的对象
    buildAggregatedView: function (fields, method) {
      const ds = DataSource.current;
      const xCol = fields && fields.x;
      const yCols = fields && Array.isArray(fields.y) ? fields.y : (fields && fields.y != null ? [fields.y] : []);
      if (xCol == null || !yCols.length || !ds.rows.length) return null;

      // 保持分组首次出现顺序
      const order = [];
      const groups = new Map();
      ds.rows.forEach(r => {
        const key = r[xCol];
        if (key === null || key === undefined || key === '') return;
        if (!groups.has(key)) { groups.set(key, []); order.push(key); }
        groups.get(key).push(r);
      });
      if (!groups.size) return null;

      const rows = order.map(key => {
        const bucket = groups.get(key);
        const row = new Array(ds.columns.length).fill(null);
        row[xCol] = key;
        yCols.forEach(yCol => {
          const nums = bucket
            .map(r => (Utils.isNumeric(r[yCol]) ? Utils.toNumber(r[yCol]) : NaN))
            .filter(v => !isNaN(v));
          let v;
          if (method === 'count') v = bucket.length;
          else if (!nums.length) v = 0;
          else if (method === 'avg') v = Utils.avg(nums);
          else if (method === 'max') v = Utils.max(nums);
          else if (method === 'min') v = Utils.min(nums);
          else v = Utils.sum(nums);
          row[yCol] = v;
        });
        return row;
      });

      const types = ds.types.slice();
      yCols.forEach(yCol => { types[yCol] = 'number'; });
      return { name: ds.name, columns: ds.columns.slice(), rows: rows, types: types, meta: ds.meta || [] };
    },

    // ---------- 构建 ECharts Option ----------
    buildOption: function (chartType, fields, style) {
      const ds = DataSource.current;
      if (!ds.columns.length) return null;

      // 聚合开关：优先取 style.aggregate，其次全局 State.aggregate
      const aggCfg = (style && style.aggregate) ||
        (global.State && global.State.aggregate) || null;
      this._view = (aggCfg && aggCfg.enabled)
        ? this.buildAggregatedView(fields, aggCfg.method || 'sum')
        : null;

      try {
        return this._buildOptionInner(chartType, fields, style);
      } finally {
        this._view = null;   // 避免影响后续（如联动面板）渲染
      }
    },

    _buildOptionInner: function (chartType, fields, style) {
      const ds = this._ds();
      const colors = this._getPalette(style && style.theme);
      const anim = style && style.animation === false ? false : true;
      const showLabel = style ? style.showLabel : false;
      const showLegend = style ? style.showLegend !== false : true;
      // 兼容两种命名：app/State 用 legendPosition，早期渲染器用 legendPos
      const legendPos = style ? (style.legendPosition || style.legendPos || 'top') : 'top';
      const showGrid = style ? style.showGrid !== false : true;
      const showTitle = style ? style.showTitle !== false : true;
      const titleText = showTitle ? ((style && style.title) || ds.name || '') : '';
      // 暗色：显式 darkMode，或跟随 body[data-theme=dark]
      const darkMode = style && style.darkMode != null
        ? !!style.darkMode
        : (global.document && document.body && document.body.dataset.theme === 'dark');

      // 图例定位：上/下为水平居中，左/右为纵向排列
      const legendLayout = { type: 'scroll', data: [] };
      if (legendPos === 'bottom') {
        legendLayout.bottom = 0; legendLayout.left = 'center'; legendLayout.orient = 'horizontal';
      } else if (legendPos === 'left') {
        legendLayout.left = 0; legendLayout.top = 'middle'; legendLayout.orient = 'vertical';
      } else if (legendPos === 'right') {
        legendLayout.right = 0; legendLayout.top = 'middle'; legendLayout.orient = 'vertical';
      } else {
        legendLayout.top = titleText ? 34 : 8; legendLayout.left = 'center'; legendLayout.orient = 'horizontal';
      }

      // 网格需为图例/标题留出空间
      const gridBase = { left: 50, right: 30, top: 70, bottom: 60, containLabel: true };
      if (showLegend) {
        if (legendPos === 'left') gridBase.left = 110;
        else if (legendPos === 'right') gridBase.right = 110;
        else if (legendPos === 'bottom') gridBase.bottom = 70;
      }
      if (!titleText) gridBase.top = showLegend && (legendPos === 'top') ? 50 : 30;

      const baseOption = {
        title: {
          text: titleText,
          show: !!titleText,
          left: 'center',
          top: 8,
          textStyle: { fontSize: 16, fontWeight: 'bold' }
        },
        tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
        legend: showLegend ? legendLayout : { show: false },
        color: colors,
        animation: anim,
        grid: showGrid ? gridBase : { left: 10, right: 10, top: 30, bottom: 10 },
        xAxis: { type: 'category', data: [] },
        yAxis: { type: 'value' },
        series: []
      };

      // 暗色主题适配
      if (darkMode) {
        baseOption.backgroundColor = 'transparent';
        baseOption.title.textStyle = Object.assign({}, baseOption.title.textStyle, { color: '#e5e7eb' });
        baseOption.xAxis.axisLine = { lineStyle: { color: '#9ca3af' } };
        baseOption.yAxis.axisLine = { lineStyle: { color: '#9ca3af' } };
        baseOption.xAxis.axisLabel = { color: '#d1d5db' };
        baseOption.yAxis.axisLabel = { color: '#d1d5db' };
        baseOption.legend.textStyle = { color: '#d1d5db' };
      }

      let option;
      switch (chartType) {
        case 'line':         option = this._buildLine(fields, baseOption, 'line'); break;
        case 'area':         option = this._buildLine(fields, baseOption, 'area'); break;
        case 'bar':          option = this._buildBar(fields, baseOption, 'single'); break;
        case 'bar-grouped':  option = this._buildBar(fields, baseOption, 'grouped'); break;
        case 'bar-stacked':  option = this._buildBar(fields, baseOption, 'stacked'); break;
        case 'pie':          option = this._buildPie(fields, baseOption, false); break;
        case 'doughnut':     option = this._buildPie(fields, baseOption, true); break;
        case 'scatter':      option = this._buildScatter(fields, baseOption); break;
        case 'radar':        option = this._buildRadar(fields, baseOption); break;
        case 'heatmap':      option = this._buildHeatmap(fields, baseOption); break;
        default:             option = this._buildLine(fields, baseOption, 'line');
      }

      // 应用单系列颜色覆盖（优先级高于调色板）
      // 统一在此处注入，而不是散落到各 _buildXxx 分支里：
      // 直角坐标系图按 series.name 匹配，饼图/环形图按 data[i].name 匹配。
      this._applySeriesColors(option, style);

      // 注入标注（均值/阈值线、最值标记点）。同样集中处理，并做能力检测：
      // 饼图/雷达/热力图不支持，直接跳过而不是塞进去静默失效。
      this._applyMarks(option, style, chartType);

      // 应用 showLabel（仅对部分图生效）
      if (showLabel) {
        if (option.series) {
          option.series.forEach(s => {
            s.label = s.label || {};
            s.label.show = true;
            s.label.position = s.type === 'pie' ? 'outside' : 'top';
            s.label.fontSize = 11;
            s.label.color = darkMode ? '#e5e7eb' : '#374151';
          });
        }
      }
      return option;
    },

    _getPalette: function (theme) {
      const t = theme || 'default';
      if (t === 'custom' && global.State && global.State.customColors && global.State.customColors.length) {
        return global.State.customColors;
      }
      return Utils.themes[t] || Utils.themes.default;
    },

    // ---------- 单系列颜色覆盖 ----------
    // overrides 以「列名」为键。饼图的系列名是数值列名、而各扇区名是分类值，
    // 因此饼图按扇区名（data[i].name）匹配，其余按 series.name 匹配。
    _applySeriesColors: function (option, style) {
      const overrides = (style && style.seriesColors) || {};
      if (!option || !option.series || !Object.keys(overrides).length) return option;

      option.series.forEach(s => {
        if (s.type === 'pie') {
          if (!Array.isArray(s.data)) return;
          s.data = s.data.map(d => {
            if (!d || overrides[d.name] == null) return d;
            const item = Object.assign({}, d);
            item.itemStyle = Object.assign({}, item.itemStyle, { color: overrides[d.name] });
            return item;
          });
          return;
        }
        const c = overrides[s.name];
        if (c == null) return;
        s.itemStyle = Object.assign({}, s.itemStyle, { color: c });
        // 折线/面积图的线条与填充色需要单独指定，否则仍走调色板
        if (s.type === 'line') {
          s.lineStyle = Object.assign({}, s.lineStyle, { color: c });
          s.itemStyle.borderColor = c;
          if (s.areaStyle) {
            s.areaStyle = Object.assign({}, s.areaStyle, { color: c });
          }
        }
      });
      return option;
    },

    // ---------- 标注（markLine / markPoint）----------
    // 能力检测：只有直角坐标系图表支持。饼图/雷达/热力图没有 xAxis-yAxis 语义，
    // 硬塞 markLine 不会报错但也不会显示，属于「静默失效」——不如明确拒绝，
    // 同时让 UI 侧据此灰置控件。
    MARK_SUPPORTED_TYPES: ['line', 'area', 'bar', 'bar-grouped', 'bar-stacked', 'scatter'],

    supportsMark: function (chartType) {
      return this.MARK_SUPPORTED_TYPES.indexOf(chartType) !== -1;
    },

    _applyMarks: function (option, style, chartType) {
      if (!option || !Array.isArray(option.series) || !option.series.length) return option;
      if (!this.supportsMark(chartType)) return option;
      const s = style || {};
      const wantMean = !!s.markMean;
      const wantMax = !!s.markMax;
      const wantMin = !!s.markMin;
      // 阈值可能是 0，不能用截断判断
      const thr = s.markThreshold;
      const hasThr = thr != null && thr !== '' && isFinite(Number(thr));
      if (!wantMean && !wantMax && !wantMin && !hasThr) return option;

      option.series.forEach(ser => {
        // 标注挂在数据系列上；辅助系列（如无 data 的占位）跳过
        if (!ser || !Array.isArray(ser.data)) return;

        const lines = [];
        if (wantMean) {
          // 用 ECharts 内置统计类型，避免自己算均值时处理 null/散点二维数据出错
          lines.push({
            type: 'average',
            name: '均值',
            label: { formatter: '均值 {c}', position: 'insideEndTop' },
            lineStyle: { type: 'dashed', width: 1.5 }
          });
        }
        if (hasThr) {
          lines.push({
            // 阈值按 y 轴画水平线，符合「超过某个量级」的直觉
            yAxis: Number(thr),
            name: '阈值',
            label: { formatter: '阈值 ' + Number(thr), position: 'insideEndTop' },
            lineStyle: { type: 'dotted', width: 1.5, color: '#dc2626' }
          });
        }
        if (lines.length) {
          ser.markLine = {
            silent: true,          // 不抢 tooltip
            symbol: ['none', 'none'],
            data: lines
          };
        }

        const points = [];
        if (wantMax) points.push({ type: 'max', name: '最大值' });
        if (wantMin) points.push({ type: 'min', name: '最小值' });
        if (points.length) {
          ser.markPoint = {
            symbolSize: 44,
            label: { fontSize: 10 },
            data: points
          };
        }
      });
      return option;
    },

    // ---------- 折线 / 面积 ----------
    _buildLine: function (fields, base, mode) {
      const ds = this._ds();
      const xCol = fields.x;
      const yCols = Array.isArray(fields.y) ? fields.y : (fields.y != null ? [fields.y] : []);
      if (xCol == null || yCols.length === 0) {
        return Object.assign({}, base, { title: Object.assign({}, base.title, { text: (base.title.text || '') + '（请配置 X/Y 轴）', textStyle: Object.assign({}, base.title.textStyle, { color: '#dc2626' }) }) });
      }

      const xValues = ds.rows.map(r => r[xCol]);
      const legendData = [];
      const series = [];

      // 时间轴：ECharts 的 type:'time' 会完全忽略 xAxis.data，横坐标只认
      // series.data 里的值。若仍按分类轴那样只传 Y 标量，ECharts 会把这些
      // 标量当成时间戳（120 → epoch 120ms），画出错误的刻度与线形。
      // 所以时间轴必须把数据写成 [时间戳, 值] 成对形式。
      let stamps = null;
      if (ds.types[xCol] === 'time') {
        const parsed = xValues.map(v => {
          const d = new Date(String(v).replace(/[/.]/g, '-'));
          return isNaN(d.getTime()) ? null : d.getTime();
        });
        // 只要有一个解析不出来就退回分类轴：宁可失去时间比例，
        // 也不要让部分点落到错误位置。
        if (parsed.every(t => t !== null)) stamps = parsed;
      }

      yCols.forEach((yCol, idx) => {
        const name = ds.columns[yCol] || ('系列' + (idx + 1));
        legendData.push(name);
        const data = ds.rows.map((r, i) => {
          const v = r[yCol];
          const num = (v == null || v === '' || !Utils.isNumeric(v)) ? null : Utils.toNumber(v);
          return stamps ? [stamps[i], num] : num;
        });
        series.push({
          name: name,
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          data: data,
          areaStyle: mode === 'area' ? { opacity: 0.35 } : undefined,
          lineStyle: { width: 2 },
          connectNulls: true
        });
      });

      if (stamps) {
        // 时间轴不使用 data（ECharts 会忽略），横坐标来自 series
        base.xAxis.type = 'time';
        delete base.xAxis.data;
      } else {
        base.xAxis.type = 'category';
        base.xAxis.data = xValues;
      }
      base.legend.data = legendData;
      base.series = series;
      return base;
    },

    // ---------- 柱状（单系列 / 分组 / 堆叠）----------
    _buildBar: function (fields, base, mode) {
      const ds = this._ds();
      const xCol = fields.x;
      let yCols = Array.isArray(fields.y) ? fields.y : (fields.y != null ? [fields.y] : []);
      if (mode === 'single') yCols = yCols.slice(0, 1);
      if (xCol == null || yCols.length === 0) {
        return Object.assign({}, base, { title: Object.assign({}, base.title, { text: (base.title.text || '') + '（请配置 X/Y 轴）' }) });
      }

      const xValues = ds.rows.map(r => r[xCol]);
      const legendData = [];
      const series = [];

      yCols.forEach((yCol, idx) => {
        const name = ds.columns[yCol] || ('系列' + (idx + 1));
        legendData.push(name);
        const data = ds.rows.map(r => {
          const v = r[yCol];
          if (v == null || v === '' || !Utils.isNumeric(v)) return 0;
          return Utils.toNumber(v);
        });
        series.push({
          name: name,
          type: 'bar',
          data: data,
          barMaxWidth: 40,
          itemStyle: { borderRadius: mode === 'single' ? [4, 4, 0, 0] : [2, 2, 0, 0] }
        });
      });

      if (mode !== 'single' && yCols.length > 1) {
        if (mode === 'stacked') {
          series.forEach(s => s.stack = 'total');
        } else {
          // grouped：默认
        }
      }

      base.xAxis.data = xValues;
      base.xAxis.type = 'category';
      base.legend.data = legendData;
      base.series = series;
      return base;
    },

    // ---------- 饼图 / 环形图 ----------
    _buildPie: function (fields, base, isDoughnut) {
      const ds = this._ds();
      const xCol = fields.x;
      const yCol = Array.isArray(fields.y) ? fields.y[0] : fields.y;
      if (xCol == null || yCol == null) {
        return Object.assign({}, base, { title: Object.assign({}, base.title, { text: (base.title.text || '') + '（请配置 X/Y 轴）' }) });
      }
      const data = ds.rows.map(r => {
        const name = r[xCol] == null ? '' : String(r[xCol]);
        const v = r[yCol];
        if (v == null || v === '' || !Utils.isNumeric(v)) return null;
        return { name, value: Utils.toNumber(v) };
      }).filter(Boolean);

      // 合并同名（聚合）
      const merged = {};
      data.forEach(d => {
        if (!merged[d.name]) merged[d.name] = 0;
        merged[d.name] += d.value;
      });
      const pieData = Object.keys(merged).map(k => ({ name: k, value: merged[k] }));

      base.series = [{
        name: ds.columns[yCol] || '占比',
        type: 'pie',
        radius: isDoughnut ? ['45%', '70%'] : '70%',
        center: ['50%', '55%'],
        data: pieData,
        label: { show: true, formatter: '{b}: {d}%' },
        labelLine: { show: true },
        emphasis: {
          itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0, 0, 0, 0.5)' }
        }
      }];
      base.tooltip = { trigger: 'item', formatter: '{a} <br/>{b}: {c} ({d}%)' };
      base.xAxis = undefined;
      base.yAxis = undefined;
      base.grid = undefined;
      base.legend.data = pieData.map(d => d.name);
      if (base.legend && base.legend.top === 30) base.legend.top = 30;
      return base;
    },

    // ---------- 散点图 ----------
    _buildScatter: function (fields, base) {
      const ds = this._ds();
      const xCol = fields.x;
      const yCol = Array.isArray(fields.y) ? fields.y[0] : fields.y;
      const sizeCol = fields.size;
      if (xCol == null || yCol == null) {
        return Object.assign({}, base, { title: Object.assign({}, base.title, { text: (base.title.text || '') + '（请配置 X/Y 轴）' }) });
      }
      const data = ds.rows.map((r, i) => {
        const xv = r[xCol];
        const yv = r[yCol];
        if (xv == null || yv == null || !Utils.isNumeric(xv) || !Utils.isNumeric(yv)) return null;
        const xn = Utils.toNumber(xv);
        const yn = Utils.toNumber(yv);
        if (sizeCol != null && r[sizeCol] != null && Utils.isNumeric(r[sizeCol])) {
          return [xn, yn, Utils.toNumber(r[sizeCol]), i];
        }
        return [xn, yn, i];
      }).filter(Boolean);

      base.series = [{
        name: ds.columns[yCol] || '散点',
        type: 'scatter',
        data: data,
        symbolSize: function (val) {
          if (val.length >= 4 && val[2] != null) {
            // 第三维作为尺寸
            return Math.max(6, Math.min(40, Math.abs(val[2]) * 1.5 + 6));
          }
          return 10;
        },
        emphasis: { focus: 'series' }
      }];
      base.xAxis.name = ds.columns[xCol] || '';
      base.yAxis.name = ds.columns[yCol] || '';
      base.legend.data = [ds.columns[yCol] || '散点'];
      return base;
    },

    // ---------- 雷达图 ----------
    _buildRadar: function (fields, base) {
      const ds = this._ds();
      // x 是分类（每个数据行 = 一个雷达多边形），y 是指标（多个数值列）
      const xCol = fields.x;
      const yCols = Array.isArray(fields.y) ? fields.y : (fields.y != null ? [fields.y] : []);
      if (xCol == null || yCols.length < 3) {
        return Object.assign({}, base, { title: Object.assign({}, base.title, { text: (base.title.text || '') + '（雷达图至少需要 3 个数值列）' }) });
      }
      const indicators = yCols.map(i => ({ name: ds.columns[i] || ('指标' + i), max: 100 }));
      const data = ds.rows.map((r, idx) => {
        const name = r[xCol] == null ? ('系列' + (idx + 1)) : String(r[xCol]);
        const values = yCols.map(i => {
          const v = r[i];
          return (v != null && Utils.isNumeric(v)) ? Utils.toNumber(v) : 0;
        });
        return { name, value: values };
      });
      base.series = [{
        type: 'radar',
        data: data,
        areaStyle: { opacity: 0.25 }
      }];
      base.radar = { indicator: indicators };
      base.xAxis = undefined;
      base.yAxis = undefined;
      base.grid = undefined;
      base.legend.data = data.map(d => d.name);
      base.tooltip = { trigger: 'item' };
      return base;
    },

    // ---------- 热力图 ----------
    _buildHeatmap: function (fields, base) {
      const ds = this._ds();
      const xCol = fields.x;
      // fields.y 是数组（多值槽），第 1 项作 Y 类别轴
      const yCols = Array.isArray(fields.y) ? fields.y : (fields.y != null ? [fields.y] : []);
      const yCol = yCols.length ? yCols[0] : null;
      // 值列优先取 value 槽，否则退化为 y 槽的第 2 项
      const valCol = fields.value != null ? fields.value : (yCols.length > 1 ? yCols[1] : null);
      if (xCol == null || yCol == null || valCol == null) {
        return Object.assign({}, base, { title: Object.assign({}, base.title, { text: (base.title.text || '') + '（热力图需 X/Y/Value）' }) });
      }
      // 提取唯一的 X、Y 类别
      const xCats = [];
      const yCats = [];
      const seenX = new Set(), seenY = new Set();
      ds.rows.forEach(r => {
        const x = String(r[xCol] || '');
        const y = String(r[yCol] || '');
        if (!seenX.has(x)) { seenX.add(x); xCats.push(x); }
        if (!seenY.has(y)) { seenY.add(y); yCats.push(y); }
      });
      // 构造 [xIdx, yIdx, value]
      const xIdx = {}, yIdx = {};
      xCats.forEach((v, i) => xIdx[v] = i);
      yCats.forEach((v, i) => yIdx[v] = i);
      const data = ds.rows.map(r => {
        const x = String(r[xCol] || '');
        const y = String(r[yCol] || '');
        const v = r[valCol];
        const num = (v != null && Utils.isNumeric(v)) ? Utils.toNumber(v) : null;
        if (num == null) return null;
        return [xIdx[x], yIdx[y], num];
      }).filter(Boolean);
      // 计算 max
      const max = data.reduce((m, d) => Math.max(m, d[2]), 0);
      const min = data.reduce((m, d) => Math.min(m, d[2]), Infinity);

      base.xAxis = { type: 'category', data: xCats, splitArea: { show: true } };
      base.yAxis = { type: 'category', data: yCats, splitArea: { show: true } };
      base.series = [{
        name: ds.columns[valCol] || '值',
        type: 'heatmap',
        data: data,
        label: { show: true, fontSize: 11 },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0, 0, 0, 0.5)' } }
      }];
      base.visualMap = {
        min: min,
        max: max,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        inRange: { color: ['#50a3ba', '#eac736', '#d94e5d'] }
      };
      base.legend.data = [ds.columns[valCol] || '值'];
      return base;
    },

    // ---------- 渲染（直接用 option 渲染）----------
    render: function (chartId, chartType, fields, style) {
      const chart = this.ensure(chartId);
      if (!chart) return;
      const option = this.buildOption(chartType, fields, style);
      chart.setOption(option, true);
      return option;
    },

    // ---------- 导出 PNG ----------
    exportPNG: function (chartId, scale, bgColor) {
      const chart = this.get(chartId);
      if (!chart) return Promise.reject(new Error('图表未渲染'));
      const isDark = document.body.dataset.theme === 'dark';
      const url = chart.getDataURL({
        type: 'png',
        pixelRatio: scale || 2,
        backgroundColor: bgColor || (isDark ? '#111827' : '#ffffff')
      });
      return Promise.resolve(url);
    },

    // ---------- 导出 SVG ----------
    exportSVG: function (chartId, bgColor) {
      const chart = this.get(chartId);
      if (!chart) return Promise.reject(new Error('图表未渲染'));
      // ECharts 5 的 zrender 提供了 renderToSVGString
      if (typeof chart.renderToSVGString === 'function') {
        let svg = chart.renderToSVGString();
        if (bgColor) {
          // 在 svg 开头插入背景矩形
          svg = svg.replace(/<svg([^>]*)>/, '<svg$1><rect width="100%" height="100%" fill="' + bgColor + '"/></svg>'.replace('<svg$1>', ''));
        }
        return Promise.resolve(svg);
      }
      // 降级：fallback 到 PNG
      return this.exportPNG(chartId, 2, bgColor).then(dataUrl => {
        return '<svg xmlns="http://www.w3.org/2000/svg"><image href="' + dataUrl + '"/></svg>';
      });
    }
  };

  global.ChartRenderer = ChartRenderer;
})(window);

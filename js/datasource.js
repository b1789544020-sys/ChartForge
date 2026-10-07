/* ===================================================================
 * ChartForge · 数据源 & 列类型检测
 *   - 维护当前数据集（columns + rows）
 *   - 自动检测每列类型（数值 / 时间 / 分类 / 文本）
 *   - 推断列子类型（百分比、评分类等）
 * =================================================================== */
(function (global) {
  'use strict';

  const DataSource = {
    // 当前数据集
    current: {
      name: '',
      columns: [],         // 原始列名
      rows: [],            // 原始行（字符串）
      types: [],           // 每列推断类型: 'number' / 'time' / 'category' / 'text'
      meta: []             // 每列元信息 { type, isPercent, isScore, uniqueCount, total, nullable }
    },

    // ---------- 设置数据 ----------
    // 别名：兼容 E2E / 业务层常见命名
    setData: function (columns, rows, name) { return this.set(columns, rows, name); },
    loadFromArray: function (columns, rows, name) { return this.set(columns, rows, name); },
    columnSignature: function () {
      const d = this.current;
      return (d.types || []).join('|') + '#' + (d.columns || []).map(c => String(c).trim().toLowerCase()).join(',');
    },
    isTime: function (colIndex) {
      const t = this.current.types[colIndex];
      const m = this.current.meta[colIndex] || {};
      return t === 'time' || m.isLikelyTime === true;
    },

    set: function (columns, rows, name) {
      this.current = {
        name: name || '未命名数据',
        columns: columns.slice(),
        rows: rows.slice(),
        types: [],
        meta: []
      };
      this.detectTypes();
      return this.current;
    },

    // ---------- 清空 ----------
    clear: function () {
      this.current = { name: '', columns: [], rows: [], types: [], meta: [] };
    },

    // ---------- 列类型检测 ----------
    detectTypes: function () {
      const data = this.current;
      const n = data.columns.length;
      data.types = new Array(n).fill('text');
      data.meta = [];

      const sampleSize = Math.min(100, data.rows.length);

      for (let c = 0; c < n; c++) {
        const values = [];
        for (let i = 0; i < sampleSize; i++) {
          const v = data.rows[i] ? data.rows[i][c] : null;
          values.push(v);
        }
        const meta = this._analyzeColumn(values);
        data.types[c] = meta.type;
        data.meta.push(meta);
      }
      return data.meta;
    },

    _analyzeColumn: function (values) {
      const nonNull = values.filter(v => v !== null && v !== undefined && v !== '');
      const total = values.length;
      const nonNullCount = nonNull.length;
      const nullable = total - nonNullCount;

      if (nonNullCount === 0) {
        return { type: 'text', isPercent: false, isScore: false, uniqueCount: 0, total, nullable };
      }

      // 1) 判断是否数值
      const numericCount = nonNull.filter(v => Utils.isNumeric(v)).length;
      const numericRatio = numericCount / nonNullCount;
      if (numericRatio >= 0.85) {
        // 进一步判断是否时间（数值其实是时间戳）
        const isLikelyTime = nonNull.every(v => {
          const n = parseFloat(String(v).replace(/,/g, ''));
          // 时间戳范围：约 1973~2100
          return n > 0 && n < 4102444800;
        });
        // 时间列名包含关键词
        const nameLower = ''; // 类型检测一般不依赖列名
        // 数值类型继续判断子类型
        const nums = nonNull.map(v => parseFloat(String(v).replace(/,/g, '').replace(/%$/, '')));
        const minV = Math.min.apply(null, nums);
        const maxV = Math.max.apply(null, nums);
        const isPercent = minV >= 0 && maxV <= 100 && nonNull.every(v => /[%]$/.test(String(v).trim()) || (v >= 0 && v <= 1));
        const isScore = minV >= 0 && maxV <= 100 && !isPercent;

        return {
          type: 'number',
          isPercent,
          isScore,
          uniqueCount: Utils.uniqueCount(nonNull),
          total,
          nullable,
          min: minV,
          max: maxV,
          isLikelyTime
        };
      }

      // 2) 判断是否时间
      const timeCount = nonNull.filter(v => Utils.isDateLike(v)).length;
      if (timeCount / nonNullCount >= 0.85) {
        return {
          type: 'time',
          isPercent: false,
          isScore: false,
          uniqueCount: Utils.uniqueCount(nonNull),
          total,
          nullable
        };
      }

      // 3) 分类 vs 文本：低基数 → 分类，高基数 → 文本
      const unique = Utils.uniqueCount(nonNull);
      const uniqueRatio = unique / nonNullCount;
      if (unique <= Math.max(50, nonNullCount * 0.3) || uniqueRatio < 0.3) {
        return {
          type: 'category',
          isPercent: false,
          isScore: false,
          uniqueCount: unique,
          total,
          nullable
        };
      }
      return {
        type: 'text',
        isPercent: false,
        isScore: false,
        uniqueCount: unique,
        total,
        nullable
      };
    },

    // ---------- 获取某列所有值 ----------
    getColumnValues: function (colIndex) {
      return this.current.rows.map(r => r ? r[colIndex] : null);
    },

    // ---------- 转换为数字（如果是 number 列） ----------
    asNumber: function (colIndex) {
      return this.getColumnValues(colIndex).map(v => {
        if (typeof v === 'number') return v;
        if (v === null || v === undefined || v === '') return null;
        return Utils.isNumeric(v) ? Utils.toNumber(v) : null;
      });
    },

    // ---------- 别名（便于 E2E / 上层调用） ----------
    getColumns: function () { return (this.current && this.current.columns) || []; },
    getColumnTypes: function () { return (this.current && this.current.types) || []; },
    getColumnInfo: function (colIndex) {
      const d = this.current || {};
      if (colIndex === undefined) return d.meta || [];
      return (d.meta || [])[colIndex] || null;
    },
    getRows: function () { return (this.current && this.current.rows) || []; },
    getName: function () { return (this.current && this.current.name) || ''; },

    // ---------- 摘要信息 ----------
    summary: function () {
      const d = this.current;
      return {
        name: d.name,
        rowCount: d.rows.length,
        colCount: d.columns.length,
        types: d.types,
        meta: d.meta
      };
    }
  };

  global.DataSource = DataSource;
})(window);
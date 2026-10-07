/* ===================================================================
 * ChartForge · 智能图表推荐算法
 *   输入：列类型数组（number/time/category/text）
 *   输出：推荐图表列表（按匹配度排序）+ 推荐理由
 * =================================================================== */
(function (global) {
  'use strict';

  const Recommend = {
    // ---------- 主入口 ----------
    recommend: function (types, columns, meta) {
      const nums = [];     // 数值列索引
      const times = [];    // 时间列索引
      const cats = [];     // 分类列索引
      const texts = [];    // 文本列索引
      types.forEach((t, i) => {
        if (t === 'number') nums.push(i);
        else if (t === 'time') times.push(i);
        else if (t === 'category') cats.push(i);
        else texts.push(i);
      });

      const recs = [];
      const nTime = times.length;
      const nNum = nums.length;
      const nCat = cats.length;

      // 规则 1: 1 时间列 + 1~N 数值列 → 折线图
      if (nTime >= 1 && nNum >= 1) {
        recs.push({
          type: 'line',
          score: 100 - (nNum > 1 ? 5 : 0),
          reason: '检测到 ' + nTime + ' 个时间列 + ' + nNum + ' 个数值列 → 推荐折线图（趋势展示）',
          defaults: {
            xAxis: times[0],
            yAxis: nums.slice(0, Math.min(3, nNum))
          }
        });
        // 面积图也是合适的
        if (nNum >= 1) {
          recs.push({
            type: 'area',
            score: 80,
            reason: '时间序列数据 → 面积图（强调累积/总量）',
            defaults: {
              xAxis: times[0],
              yAxis: nums.slice(0, Math.min(3, nNum))
            }
          });
        }
      }

      // 规则 2: 1 分类列 + 1 数值列 → 柱状图（对比）
      if (nCat >= 1 && nNum >= 1) {
        recs.push({
          type: 'bar',
          score: 95,
          reason: '检测到 ' + nCat + ' 个分类列 + ' + nNum + ' 个数值列 → 推荐柱状图（分类对比）',
          defaults: {
            xAxis: cats[0],
            yAxis: nums[0]
          }
        });
      }

      // 规则 3: 1 分类列 + 1 数值列（占比） → 饼图
      if (nCat === 1 && nNum === 1) {
        // 进一步判断：值在 0-100 且列名包含"占比/份额/比例"等
        const numMeta = meta && meta[nums[0]];
        const colName = (columns && columns[nums[0]]) || '';
        const isPercentLike = (numMeta && (numMeta.isPercent || (numMeta.max <= 100 && numMeta.min >= 0))) ||
                              /占比|份额|比例|percent|share/i.test(colName);
        if (isPercentLike) {
          recs.push({
            type: 'pie',
            score: 90,
            reason: '检测到分类列 + 占比数值 → 推荐饼图（占比展示）',
            defaults: {
              xAxis: cats[0],
              yAxis: nums[0]
            }
          });
        }
      }

      // 规则 4: >=2 数值列 → 散点图（相关性）
      // 注意：不要求「无分类列」。「身高/体重/性别」这类数据带一个分类列
      // 仍然是典型的散点图场景，之前 nCat === 0 的硬条件会把它整个排除掉。
      // 时间列仍然排除：有时间轴时折线图表达趋势更合适。
      if (nNum >= 2 && nTime === 0) {
        // 分类列越多，越可能是「分类对比」而非「相关性」，因此降低分数让柱状图靠前
        const scatterScore = nCat === 0 ? 95 : (nCat === 1 ? 70 : 55);
        recs.push({
          type: 'scatter',
          score: scatterScore,
          reason: nCat === 0
            ? '检测到 ' + nNum + ' 个数值列（无时间/分类列）→ 推荐散点图（相关性）'
            : '检测到 ' + nNum + ' 个数值列 → 可用散点图观察相关性',
          defaults: {
            xAxis: nums[0],
            yAxis: nums[1]
          }
        });
      }

      // 规则 5: 1 分类列 + 多个数值列 → 分组柱状图
      if (nCat >= 1 && nNum >= 2) {
        recs.push({
          type: 'bar-grouped',
          score: 88,
          reason: '检测到 1 分类列 + ' + nNum + ' 个数值列 → 推荐分组柱状图（多指标对比）',
          defaults: {
            xAxis: cats[0],
            yAxis: nums.slice(0, Math.min(4, nNum))
          }
        });
        recs.push({
          type: 'bar-stacked',
          score: 75,
          reason: '分类 + 多数值列 → 堆叠柱状图（部分与整体）',
          defaults: {
            xAxis: cats[0],
            yAxis: nums.slice(0, Math.min(4, nNum))
          }
        });
      }

      // 规则 6: 多个数值列（多为评分类，0-100）→ 雷达图
      if (nNum >= 3 && nCat <= 1) {
        const allScoreLike = nums.every(i => {
          const m = meta && meta[i];
          return m && m.isScore;
        });
        if (allScoreLike) {
          recs.push({
            type: 'radar',
            score: 90,
            reason: '多个数值列（评分类，0-100）→ 推荐雷达图（多维评分对比）',
            defaults: {
              xAxis: cats[0] !== undefined ? cats[0] : nums[0],
              yAxis: nums.slice()
            }
          });
        }
      }

      // 规则 7: 2 分类列 + 1 数值列 → 热力图
      if (nCat >= 2 && nNum >= 1) {
        recs.push({
          type: 'heatmap',
          score: 85,
          reason: '检测到 2 个分类列 + 1 个数值列 → 推荐热力图（矩阵展示）',
          defaults: {
            xAxis: cats[0],
            yAxis: cats[1],
            value: nums[0]
          }
        });
      }

      // 兜底：只有 1 数值列 + 没有其他 → 简单条形图
      if (recs.length === 0 && nNum === 1) {
        recs.push({
          type: 'bar',
          score: 60,
          reason: '单数值列 → 推荐柱状图',
          defaults: { xAxis: cats[0] !== undefined ? cats[0] : 0, yAxis: nums[0] }
        });
      }
      if (recs.length === 0) {
        recs.push({
          type: 'bar',
          score: 50,
          reason: '无法智能匹配，使用默认柱状图',
          defaults: { xAxis: 0, yAxis: Math.min(1, types.length - 1) }
        });
      }

      // 按分数排序
      recs.sort((a, b) => b.score - a.score);
      // 统一补全展示/消费字段（chartType / name / icon / fields），
      // 让上层（app.js / FieldMapper）无需关心内部命名
      return recs.map(r => this.normalize(r));
    },

    // ---------- 规范化单条推荐 ----------
    // 输入 { type, score, reason, defaults:{xAxis,yAxis,value,size} }
    // 输出 追加 { chartType, name, icon, fields:{x,y,value,size} }
    normalize: function (rec) {
      if (!rec) return rec;
      rec.chartType = rec.type;
      rec.name = this.typeName(rec.type);
      rec.icon = this.typeIcon(rec.type);
      rec.fields = this.defaultsToFields(rec.defaults);
      return rec;
    },

    // ---------- defaults(xAxis/yAxis/...) → fields(x/y/value/size) ----------
    defaultsToFields: function (defaults) {
      const fields = { x: null, y: [], value: null, size: null };
      if (!defaults) return fields;
      if (defaults.xAxis != null) fields.x = defaults.xAxis;
      if (defaults.value != null) fields.value = defaults.value;
      if (defaults.size != null) fields.size = defaults.size;
      if (defaults.yAxis != null) {
        fields.y = Array.isArray(defaults.yAxis) ? defaults.yAxis.slice() : [defaults.yAxis];
      }
      return fields;
    },

    // 图表类型中文名
    typeName: function (type) {
      const map = {
        'line': '折线图',
        'area': '面积图',
        'bar': '柱状图',
        'bar-grouped': '分组柱状图',
        'bar-stacked': '堆叠柱状图',
        'pie': '饼图',
        'doughnut': '环形图',
        'scatter': '散点图',
        'radar': '雷达图',
        'heatmap': '热力图'
      };
      return map[type] || type;
    },

    typeIcon: function (type) {
      const map = {
        'line': '📈',
        'area': '🏞️',
        'bar': '📊',
        'bar-grouped': '📊',
        'bar-stacked': '📊',
        'pie': '🥧',
        'doughnut': '🍩',
        'scatter': '✨',
        'radar': '🎯',
        'heatmap': '🔥'
      };
      return map[type] || '📊';
    },

    // 全部支持的图表类型清单
    chartTypes: [
      { id: 'line',        name: '折线图',     icon: '📈' },
      { id: 'area',        name: '面积图',     icon: '🏞️' },
      { id: 'bar',         name: '柱状图',     icon: '📊' },
      { id: 'bar-grouped', name: '分组柱状图', icon: '📊' },
      { id: 'bar-stacked', name: '堆叠柱状图', icon: '📊' },
      { id: 'pie',         name: '饼图',       icon: '🥧' },
      { id: 'doughnut',    name: '环形图',     icon: '🍩' },
      { id: 'scatter',     name: '散点图',     icon: '✨' },
      { id: 'radar',       name: '雷达图',     icon: '🎯' },
      { id: 'heatmap',     name: '热力图',     icon: '🔥' }
    ],

    // 图表类型 → 支持的字段槽
    slotsFor: function (type) {
      const map = {
        'line':         ['x', 'y'],
        'area':         ['x', 'y'],
        'bar':          ['x', 'y'],
        'bar-grouped':  ['x', 'y'],
        'bar-stacked':  ['x', 'y'],
        'pie':          ['x', 'y'],
        'doughnut':     ['x', 'y'],
        'scatter':      ['x', 'y', 'size'],
        'radar':        ['x', 'y'],
        'heatmap':      ['x', 'y', 'value']
      };
      return map[type] || ['x', 'y'];
    }
  };

  global.Recommend = Recommend;
})(window);
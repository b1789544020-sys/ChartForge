/* ===================================================================
 * ChartForge · 示例数据
 * 多种结构的示例数据，方便用户快速体验不同图表类型
 * =================================================================== */
(function (global) {
  'use strict';

  // 1) 销售数据：时间 + 多个数值（折线 / 堆叠柱 / 面积图）
  const SALES = {
    key: 'sales-trend',
    name: '月度销售趋势',
    description: '时间序列 + 多指标 → 推荐折线图 / 面积图',
    columns: ['月份', '线上销售', '线下销售', '总销售额'],
    rows: [
      ['2024-01', 120, 80, 200],
      ['2024-02', 145, 95, 240],
      ['2024-03', 178, 102, 280],
      ['2024-04', 165, 115, 280],
      ['2024-05', 210, 130, 340],
      ['2024-06', 248, 152, 400],
      ['2024-07', 285, 165, 450],
      ['2024-08', 320, 180, 500],
      ['2024-09', 295, 175, 470],
      ['2024-10', 350, 200, 550],
      ['2024-11', 410, 230, 640],
      ['2024-12', 480, 280, 760]
    ]
  };

  // 2) 部门业绩：分类 + 数值（柱状 / 饼图）
  const DEPT = {
    key: 'dept-compare',
    name: '部门业绩对比',
    description: '分类 + 数值 → 推荐柱状图 / 饼图',
    columns: ['部门', 'Q1业绩', 'Q2业绩', 'Q3业绩', 'Q4业绩'],
    rows: [
      ['销售部', 320, 380, 410, 480],
      ['市场部', 180, 220, 260, 310],
      ['研发部', 280, 320, 360, 400],
      ['客服部', 150, 180, 200, 230],
      ['运营部', 220, 250, 280, 320],
      ['财务部', 120, 140, 160, 180]
    ]
  };

  // 3) 评分数据：多数值列 → 雷达图
  const RADAR = {
    key: 'product-radar',
    name: '产品能力评分',
    description: '多个数值列（评分类）→ 推荐雷达图',
    columns: ['产品', '性能', '易用性', '稳定性', '扩展性', '安全性', '社区活跃'],
    rows: [
      ['ChartForge', 92, 95, 88, 90, 85, 78],
      ['竞品A', 85, 80, 90, 75, 82, 70],
      ['竞品B', 78, 85, 82, 88, 80, 85],
      ['竞品C', 70, 75, 78, 72, 88, 90]
    ]
  };

  // 4) 散点图：2 个数值列（相关性）
  const SCATTER = {
    key: 'ad-scatter',
    name: '广告投入 vs 销售额',
    description: '2 个数值列 → 推荐散点图（相关性）',
    columns: ['广告投入(万元)', '销售额(万元)', '点击率(%)'],
    rows: [
      [5, 25, 2.1],
      [10, 48, 2.5],
      [15, 65, 2.3],
      [20, 85, 2.8],
      [25, 95, 2.4],
      [30, 110, 2.6],
      [35, 125, 2.9],
      [40, 135, 2.7],
      [45, 145, 3.0],
      [50, 155, 2.8],
      [55, 162, 3.1],
      [60, 170, 2.9],
      [65, 178, 3.2],
      [70, 185, 3.0],
      [75, 190, 3.3]
    ]
  };

  // 5) 占比：分类 + 单个数值 → 饼图
  const PIE = {
    key: 'market-pie',
    name: '市场份额占比',
    description: '分类 + 占比数值 → 推荐饼图 / 环形图',
    columns: ['品牌', '市场份额'],
    rows: [
      ['品牌A', 32],
      ['品牌B', 24],
      ['品牌C', 18],
      ['品牌D', 14],
      ['品牌E', 8],
      ['其他', 4]
    ]
  };

  // 6) 热力图：分类 × 分类 + 数值
  const HEATMAP = {
    key: 'week-heatmap',
    name: '一周各时段温度',
    description: '2 个分类 + 数值 → 推荐热力图',
    columns: ['时段', '周一', '周二', '周三', '周四', '周五', '周六', '周日'],
    rows: [
      ['00:00', 18, 19, 17, 20, 21, 22, 23],
      ['04:00', 16, 17, 15, 18, 19, 20, 21],
      ['08:00', 22, 23, 21, 24, 25, 26, 27],
      ['12:00', 28, 30, 29, 31, 32, 33, 34],
      ['16:00', 30, 32, 31, 33, 34, 35, 36],
      ['20:00', 25, 26, 24, 27, 28, 29, 30]
    ]
  };

  // 7) 时间序列：日期 + 单个数值（折线图最经典场景）
  const TIMESERIES = {
    key: 'daily-visit',
    name: '每日访问量',
    description: '日期 + 数值 → 推荐折线图（趋势）',
    columns: ['日期', '访问量'],
    rows: (function () {
      const out = [];
      const start = new Date('2024-01-01');
      let base = 1000;
      for (let i = 0; i < 30; i++) {
        const d = new Date(start.getTime() + i * 86400000);
        const noise = (Math.sin(i * 0.6) * 200) + (Math.random() * 100 - 50);
        base += (Math.random() * 60 - 20);
        out.push([d.toISOString().slice(0, 10), Math.round(base + noise)]);
      }
      return out;
    })()
  };

  // 给每个样本添加 build() 方法
  function attachBuild(ds) {
    ds.build = function () {
      return { columns: this.columns.slice(), rows: this.rows.map(r => r.slice()), name: this.name };
    };
    return ds;
  }
  [SALES, DEPT, RADAR, SCATTER, PIE, HEATMAP, TIMESERIES].forEach(attachBuild);

  global.SampleData = {
    list: [SALES, DEPT, RADAR, SCATTER, PIE, HEATMAP, TIMESERIES],
    get: function (idx) { return this.list[idx] || this.list[0]; },
    findByKey: function (key) { return this.list.find(s => s.key === key); }
  };

})(window);
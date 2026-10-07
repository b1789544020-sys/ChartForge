/* ===================================================================
 * ChartForge · 主应用入口
 *   串起所有模块，处理 UI 交互、状态变更
 * =================================================================== */
(function (global) {
  'use strict';

  // ---------- 全局 State ----------
  const State = {
    theme: 'light',
    currentChartType: 'line',
    fields: { x: null, y: [], value: null, size: null },
    style: {
      title: '',
      showTitle: true,
      showLegend: true,
      legendPosition: 'top',     // top/right/bottom/left
      showGrid: true,
      showLabel: false,
      animation: true,
      theme: 'default',          // default/dark/cool/warm/vintage
      barMode: 'group',          // group/stack
      pointStyle: 'circle',
      lineStyle: 'solid',
      bgColor: null,
      seriesColors: {},          // { 列名: '#rrggbb' } 单系列颜色覆盖，优先级高于 theme
      // 标注：仅直角坐标系图表（折线/面积/柱状/散点）支持，
      // 饼图/雷达/热力图无 xAxis-yAxis 语义，ECharts 会忽略 markLine/markPoint
      markMean: false,           // 均值参考线
      markMax: false,            // 最大值标记点
      markMin: false,            // 最小值标记点
      markThreshold: null        // 自定义阈值线（数值，null 表示不启用）
    },
    aggregate: { enabled: false, method: 'sum' },
    recommendations: [],
    activeTab: 'recommend'       // recommend/custom
  };
  global.State = State;

  // ---------- 颜色主题 ----------
  // 与 Utils.themes 保持单一数据源：渲染器 _getPalette() 只认 Utils.themes 的键，
  // 若此处另立一套键名（cool/warm/vintage），点击后会静默回退到 default。
  const COLOR_THEMES = (function () {
    const out = {};
    Object.keys(Utils.themes).forEach(k => {
      if (k === 'custom') return;              // custom 需用户自定义颜色，不作为可选主题
      if (!Utils.themes[k] || !Utils.themes[k].length) return;
      out[k] = Utils.themes[k];
    });
    return out;
  })();

  // 主题键 → 中文名
  const THEME_LABELS = {
    default:  '默认',
    vivid:    '明快',
    pastel:   '柔和',
    dark:     '暗色',
    business: '商务'
  };

  // ---------- 主 App ----------
  const App = {
    chart: null,
    resizeListener: null,

    init: function () {
      // 主题恢复（统一走 Store 层）。旧版本存的是裸字符串 "dark"，不是合法 JSON，
      // Store.read 会将其判定为损坏数据并清除 —— 代价仅是主题重置一次，可接受。
      const savedTheme = Store.read('chartforge:theme', null);
      if (savedTheme && typeof savedTheme === 'string') State.theme = savedTheme;
      document.body.dataset.theme = State.theme;
      const themeBtn = document.getElementById('themeToggle');
      if (themeBtn) themeBtn.textContent = State.theme === 'dark' ? '☀️ 亮色' : '🌙 暗色';

      // 绑定模块
      Importer.init();
      FieldMapper.init('fieldMapper', 'mainChart');
      DataTable.render('dataTable');
      Dashboard.init('dashboardArea');

      // 默认加载示例数据
      const sampleKey = 'sales-trend';
      const sample = SampleData.list.find(s => s.key === sampleKey) || SampleData.list[0];
      this.loadSample(sample);

      this.renderChartTypeSelector();
      this.renderStylePanel();
      this.renderTemplateList();
      this.renderDashboardControls();
      this.bindGlobalUI();

      // 恢复上次的仪表盘布局。
      // 必须放在 loadSample() 之后：restore() 要拿当前数据源的列签名做校验，
      // 且 _renderOne 依赖 DataSource.current 有数据才会真正绘图。
      this._restoreDashboard();
    },

    // 恢复已保存的仪表盘布局，并把结果反馈给用户。
    // 列签名不匹配时不静默套用（会画出张冠李戴的图），而是提示可手动恢复。
    _restoreDashboard: function (opts) {
      opts = opts || {};
      if (!Dashboard.peekSaved()) return;
      // 已经有面板时不覆盖用户当前的看板
      if (Dashboard.panels.length) return;
      const res = Dashboard.restore();
      this.renderDashboardControls();
      if (res.ok) {
        let msg = '已恢复上次的 ' + res.restored + ' 个联动图表';
        if (res.dropped) msg += '（' + res.dropped + ' 个因字段失效已丢弃）';
        Utils.toast(msg, 'success');
      } else if (res.reason === 'signature-mismatch' && !opts.quiet) {
        Utils.toast('检测到已保存的看板布局，但与当前数据结构不一致，未自动恢复', 'info');
      }
    },

    loadSample: function (sample) {
      if (!sample) return;
      try {
        const data = sample.build();
        DataSource.loadFromArray(data.columns, data.rows, data.name);
        this.afterDataLoaded(sample.name, true);
      } catch (e) {
        console.error(e);
        Utils.toast('加载示例数据失败: ' + e.message, 'error');
      }
    },

    afterDataLoaded: function (sourceName, isSample) {
      // 重置 fields
      State.fields = { x: null, y: [], value: null, size: null };
      // 计算推荐
      State.recommendations = Recommend.recommend(DataSource.current.types, DataSource.current.columns);
      // 尝试自动匹配模板
      const matched = Template.autoMatch();
      if (matched && matched.score >= 0.95) {
        Template.apply(matched.template);
        Utils.toast('已自动应用模板：「' + matched.template.name + '」', 'info');
      } else if (State.recommendations.length > 0) {
        // 应用首条推荐
        const top = State.recommendations[0];
        State.currentChartType = top.chartType;
        if (top.fields) {
          Object.assign(State.fields, top.fields);
          if (!Array.isArray(State.fields.y)) State.fields.y = State.fields.y != null ? [State.fields.y] : [];
        }
      }
      this.renderChartTypeSelector();
      FieldMapper.render();
      this.renderCurrentChart();
      DataTable.render('dataTable');
      this.renderStylePanel();
      this.renderTemplateList();
      this._renderRecommendPanel();     // 推荐面板需随新数据刷新
      this.renderDashboardControls();   // 有无数据决定联动按钮可用性
      // 顺序要紧：先卸掉列索引已失效的旧面板（否则会拿新数据画旧字段 → 串图），
      // 再尝试恢复与新数据结构匹配的存档。
      const sync = Dashboard.syncToData();
      if (sync.changed) {
        Utils.toast('数据结构已变化，' + sync.removed + ' 个联动图表已卸载（布局已保留）', 'info');
      }
      // 新数据的列结构可能正好匹配已保存的看板（典型场景：刷新后重新导入同一份
      // 数据）。此时自动把看板恢复出来，否则布局持久化在"数据不持久化"的前提下
      // 永远等不到可用时机。quiet：不匹配属常态，不必每次导入都弹提示。
      this._restoreDashboard({ quiet: true });
      this.renderDashboardControls();
      this.updateStatusBar();
      Utils.toast('已加载: ' + (sourceName || '数据') + '（' + DataSource.current.rows.length + ' 行）', 'success');
    },

    // ---------- 底部状态栏 ----------
    updateStatusBar: function () {
      const ds = DataSource.current;
      const info = document.getElementById('statusInfo');
      if (info) {
        info.textContent = ds.columns.length
          ? (ds.name || '数据') + ' · ' + ds.rows.length + ' 行 × ' + ds.columns.length + ' 列'
          : '未加载数据';
      }
      const chartInfo = document.getElementById('statusChart');
      if (chartInfo) {
        const t = Recommend.chartTypes.find(x => x.id === State.currentChartType);
        chartInfo.textContent = t ? t.name : (State.currentChartType || '-');
      }
    },

    renderChartTypeSelector: function () {
      const root = document.getElementById('chartTypeSelector');
      if (!root) return;
      const types = Recommend.chartTypes;
      let html = '';
      types.forEach(t => {
        const active = t.id === State.currentChartType ? ' active' : '';
        html += '<button class="chart-type-btn' + active + '" data-type="' + t.id + '">';
        html += '<span class="ct-icon">' + t.icon + '</span>';
        html += '<span class="ct-name">' + t.name + '</span>';
        html += '</button>';
      });
      root.innerHTML = html;
      const self = this;
      root.querySelectorAll('.chart-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          State.currentChartType = btn.dataset.type;
          // 切换图表类型时，根据新类型重置未使用的槽位
          self._adaptFieldsToNewType();
          self.renderChartTypeSelector();
          FieldMapper.render();
          self.renderCurrentChart();
          self.renderStylePanel();   // 柱形模式等选项依赖当前类型
          self.updateStatusBar();
        });
      });
    },

    _adaptFieldsToNewType: function () {
      const slots = Recommend.slotsFor(State.currentChartType);
      // 把不在新槽位的字段清掉
      ['x', 'y', 'value', 'size'].forEach(s => {
        if (slots.indexOf(s) === -1) State.fields[s] = (s === 'y' ? [] : null);
      });
    },

    renderCurrentChart: function () {
      if (!DataSource.current.columns.length) return;
      try {
        ChartRenderer.render('mainChart', State.currentChartType, State.fields, State.style);
        // 选中联动：每次 render 都会调用本方法，需保证 click 只绑定一次，
        // 否则监听器会累积，一次点击触发 N 次广播
        const chart = ChartRenderer.ensure('mainChart');
        if (chart && !chart.__cfClickBound) {
          chart.__cfClickBound = true;
          chart.on('click', function (params) {
            ChartBus.emit('select', {
              sourceId: 'mainChart',
              dataIndex: params.dataIndex,
              seriesIndex: params.seriesIndex
            });
          });
        }
      } catch (e) {
        console.error('Render failed:', e);
        Utils.toast('图表渲染失败: ' + e.message, 'error');
      }
    },

    renderStylePanel: function () {
      const root = document.getElementById('stylePanel');
      if (!root) return;
      const s = State.style;
      const themes = Object.keys(COLOR_THEMES);
      let html = '<div class="style-section"><h4>📝 标题</h4>';
      html += '<input type="text" id="styleTitle" placeholder="图表标题（留空使用默认）" value="' + Utils.escapeHtml(s.title || '') + '" />';
      html += '<label class="check-line"><input type="checkbox" id="styleShowTitle" ' + (s.showTitle ? 'checked' : '') + ' /> 显示标题</label>';
      html += '</div>';

      html += '<div class="style-section"><h4>🎨 颜色主题</h4><div class="theme-grid">';
      themes.forEach(k => {
        const active = s.theme === k ? ' active' : '';
        html += '<button class="theme-btn' + active + '" data-theme="' + k + '">';
        html += '<span class="theme-colors">';
        COLOR_THEMES[k].slice(0, 5).forEach(c => {
          html += '<span class="theme-color" style="background:' + c + '"></span>';
        });
        html += '</span>';
        html += '<span class="theme-name">' + (THEME_LABELS[k] || k) + '</span>';
        html += '</button>';
      });
      html += '</div></div>';

      html += '<div class="style-section"><h4>📊 图例</h4>';
      html += '<label class="check-line"><input type="checkbox" id="styleShowLegend" ' + (s.showLegend ? 'checked' : '') + ' /> 显示图例</label>';
      html += '<div class="row-line">位置：<select id="styleLegendPos">';
      [['top', '顶部'], ['right', '右侧'], ['bottom', '底部'], ['left', '左侧']].forEach(p => {
        html += '<option value="' + p[0] + '"' + (s.legendPosition === p[0] ? ' selected' : '') + '>' + p[1] + '</option>';
      });
      html += '</select></div></div>';

      html += '<div class="style-section"><h4>🔧 显示</h4>';
      html += '<label class="check-line"><input type="checkbox" id="styleShowGrid" ' + (s.showGrid ? 'checked' : '') + ' /> 显示网格</label>';
      html += '<label class="check-line"><input type="checkbox" id="styleShowLabel" ' + (s.showLabel ? 'checked' : '') + ' /> 显示数据标签</label>';
      html += '<label class="check-line"><input type="checkbox" id="styleAnimation" ' + (s.animation ? 'checked' : '') + ' /> 开启动画</label>';
      html += '</div>';

      // 柱状图模式
      if (State.currentChartType === 'bar' || State.currentChartType === 'area') {
        html += '<div class="style-section"><h4>📊 柱形模式</h4>';
        html += '<div class="row-line">';
        html += '<label><input type="radio" name="barMode" value="group" ' + (s.barMode === 'group' ? 'checked' : '') + '> 分组</label>';
        html += '<label><input type="radio" name="barMode" value="stack" ' + (s.barMode === 'stack' ? 'checked' : '') + '> 堆叠</label>';
        html += '</div></div>';
      }

      // 标注（均值线 / 最值 / 阈值）
      // 能力检测由渲染器统一提供，避免 UI 与渲染逻辑各判一套导致不一致
      const markOk = ChartRenderer.supportsMark(State.currentChartType);
      html += '<div class="style-section' + (markOk ? '' : ' disabled-section') + '"><h4>📌 标注</h4>';
      if (!markOk) {
        html += '<div class="empty-hint small">当前图表类型不支持标注（仅折线/面积/柱状/散点可用）</div>';
      }
      const dis = markOk ? '' : ' disabled';
      html += '<label class="check-line"><input type="checkbox" id="markMean" ' + (s.markMean ? 'checked' : '') + dis + ' /> 均值参考线</label>';
      html += '<label class="check-line"><input type="checkbox" id="markMax" ' + (s.markMax ? 'checked' : '') + dis + ' /> 标记最大值</label>';
      html += '<label class="check-line"><input type="checkbox" id="markMin" ' + (s.markMin ? 'checked' : '') + dis + ' /> 标记最小值</label>';
      html += '<div class="row-line">阈值线：<input type="number" id="markThreshold" class="num-input" placeholder="留空不显示" value="' +
              (s.markThreshold == null ? '' : Utils.escapeHtml(String(s.markThreshold))) + '"' + dis + ' />';
      html += '<button id="markThresholdClear" class="btn-mini" title="清除阈值线"' + dis + '>⟲</button></div>';
      html += '</div>';

      // 聚合
      html += '<div class="style-section"><h4>📐 数据聚合</h4>';
      html += '<label class="check-line"><input type="checkbox" id="aggEnabled" ' + (State.aggregate.enabled ? 'checked' : '') + ' /> 启用分组聚合</label>';
      html += '<div class="row-line">方法：<select id="aggMethod">';
      [['sum', '求和'], ['avg', '平均'], ['count', '计数'], ['max', '最大'], ['min', '最小']].forEach(m => {
        html += '<option value="' + m[0] + '"' + (State.aggregate.method === m[0] ? ' selected' : '') + '>' + m[1] + '</option>';
      });
      html += '</select></div></div>';

      root.innerHTML = html;

      // 绑定
      this._bindStyleEvents();
    },

    _bindStyleEvents: function () {
      const self = this;
      const $ = id => document.getElementById(id);
      const wireInput = (id, prop, parser) => {
        const el = $(id);
        if (!el) return;
        el.addEventListener('input', () => {
          // parser 接收元素本身；缺省取 el.value
          State.style[prop] = parser ? parser(el) : el.value;
          self.renderCurrentChart();
        });
      };
      wireInput('styleTitle', 'title', el => el.value);
      $('styleShowTitle') && $('styleShowTitle').addEventListener('change', e => { State.style.showTitle = e.target.checked; self.renderCurrentChart(); });
      $('styleShowLegend') && $('styleShowLegend').addEventListener('change', e => { State.style.showLegend = e.target.checked; self.renderCurrentChart(); });
      $('styleLegendPos') && $('styleLegendPos').addEventListener('change', e => { State.style.legendPosition = e.target.value; self.renderCurrentChart(); });
      $('styleShowGrid') && $('styleShowGrid').addEventListener('change', e => { State.style.showGrid = e.target.checked; self.renderCurrentChart(); });
      $('styleShowLabel') && $('styleShowLabel').addEventListener('change', e => { State.style.showLabel = e.target.checked; self.renderCurrentChart(); });
      $('styleAnimation') && $('styleAnimation').addEventListener('change', e => { State.style.animation = e.target.checked; self.renderCurrentChart(); });
      $('aggEnabled') && $('aggEnabled').addEventListener('change', e => { State.aggregate.enabled = e.target.checked; self.renderCurrentChart(); });
      $('aggMethod') && $('aggMethod').addEventListener('change', e => { State.aggregate.method = e.target.value; self.renderCurrentChart(); });

      // 标注
      $('markMean') && $('markMean').addEventListener('change', e => { State.style.markMean = e.target.checked; self.renderCurrentChart(); });
      $('markMax') && $('markMax').addEventListener('change', e => { State.style.markMax = e.target.checked; self.renderCurrentChart(); });
      $('markMin') && $('markMin').addEventListener('change', e => { State.style.markMin = e.target.checked; self.renderCurrentChart(); });
      $('markThreshold') && $('markThreshold').addEventListener('input', e => {
        const raw = e.target.value;
        // 空串 → 不启用；注意 0 是合法阈值，不能用 falsy 判断
        State.style.markThreshold = (raw === '' || isNaN(Number(raw))) ? null : Number(raw);
        self.renderCurrentChart();
      });
      $('markThresholdClear') && $('markThresholdClear').addEventListener('click', () => {
        State.style.markThreshold = null;
        const inp = $('markThreshold');
        if (inp) inp.value = '';
        self.renderCurrentChart();
      });

      // bar mode radio
      document.querySelectorAll('input[name="barMode"]').forEach(r => {
        r.addEventListener('change', e => { State.style.barMode = e.target.value; self.renderCurrentChart(); });
      });

      // 主题按钮
      document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          State.style.theme = btn.dataset.theme;
          self.renderStylePanel();
          self.renderCurrentChart();
        });
      });
    },

    renderTemplateList: function () {
      const root = document.getElementById('templateList');
      if (!root) return;
      const list = Template.list();
      if (list.length === 0) {
        root.innerHTML = '<div class="empty-hint small">尚无模板，先做一个图表后点击「保存为模板」</div>';
        return;
      }
      let html = '';
      list.forEach((t, i) => {
        html += '<div class="tpl-item" data-index="' + i + '">';
        html += '<span class="tpl-name">' + Utils.escapeHtml(t.name) + '</span>';
        html += '<span class="tpl-type">' + t.chartType + '</span>';
        html += '<span class="tpl-time">' + new Date(t.createdAt).toLocaleString('zh-CN', { hour12: false }) + '</span>';
        html += '<button class="tpl-apply" data-i="' + i + '">应用</button>';
        html += '<button class="tpl-del" data-i="' + i + '">×</button>';
        html += '</div>';
      });
      root.innerHTML = html;
      const self = this;
      root.querySelectorAll('.tpl-apply').forEach(b => {
        b.addEventListener('click', () => {
          const i = parseInt(b.dataset.i, 10);
          Template.apply(Template.list()[i]);
          self.renderChartTypeSelector();
          FieldMapper.render();
          self.renderCurrentChart();
          Utils.toast('已应用模板', 'success');
        });
      });
      root.querySelectorAll('.tpl-del').forEach(b => {
        b.addEventListener('click', () => {
          const i = parseInt(b.dataset.i, 10);
          if (confirm('确认删除模板？')) {
            Template.remove(i);
            self.renderTemplateList();
          }
        });
      });
    },

    renderDashboardControls: function () {
      const root = document.getElementById('dashboardControls');
      if (!root) return;
      const ds = DataSource.current;
      const hasData = ds.columns.length > 0;
      let html = '<label class="check-line"><input type="checkbox" id="dashEnabled" ' + (Dashboard.enabled ? 'checked' : '') + (hasData ? '' : ' disabled') + ' /> 启用多图表联动</label>';
      html += '<button id="dashAddBtn" class="btn btn-secondary" ' + (hasData && Dashboard.enabled ? '' : 'disabled') + '>+ 添加图表</button>';
      html += '<button id="dashClearBtn" class="btn btn-secondary" ' + (Dashboard.enabled && Dashboard.panels.length ? '' : 'disabled') + '>清空</button>';
      // 有已保存布局但当前没恢复出来时，提供手动恢复入口
      const saved = Dashboard.peekSaved();
      const canRestore = saved && saved.panels && saved.panels.length && !Dashboard.panels.length;
      if (canRestore) {
        html += '<button id="dashRestoreBtn" class="btn btn-secondary" ' + (hasData ? '' : 'disabled') +
                ' title="套用上次保存的看板布局">↺ 恢复布局（' + saved.panels.length + '）</button>';
      }
      root.innerHTML = html;
      const self = this;
      const enabled = document.getElementById('dashEnabled');
      if (enabled) enabled.addEventListener('change', e => {
        Dashboard.setEnabled(e.target.checked);
        self.renderDashboardControls();
      });
      const addBtn = document.getElementById('dashAddBtn');
      if (addBtn) addBtn.addEventListener('click', () => self.addDashboardPanel());
      const clearBtn = document.getElementById('dashClearBtn');
      if (clearBtn) clearBtn.addEventListener('click', () => {
        Dashboard.clear();
        Dashboard.clearSaved();     // 清空是明确意图，连存档一起丢弃
        self.renderDashboardControls();
      });
      const restoreBtn = document.getElementById('dashRestoreBtn');
      if (restoreBtn) restoreBtn.addEventListener('click', () => {
        // force：用户已明确知道结构可能不同，仍要求套用
        const res = Dashboard.restore({ force: true });
        self.renderDashboardControls();
        if (res.ok) {
          Utils.toast('已恢复 ' + res.restored + ' 个图表' +
                      (res.dropped ? '（丢弃 ' + res.dropped + ' 个失效面板）' : ''), 'success');
        } else {
          Utils.toast('恢复失败：保存的面板字段与当前数据不兼容', 'error');
        }
      });
    },

    addDashboardPanel: function () {
      // 用和当前主图一样的配置
      const typeMeta = Recommend.chartTypes.find(t => t.id === State.currentChartType);
      const typeName = typeMeta ? typeMeta.name : (State.currentChartType || '图表');
      Dashboard.addPanel({
        chartType: State.currentChartType,
        title: typeName + ' - ' + (Dashboard.panels.length + 1),
        fields: JSON.parse(JSON.stringify(State.fields)),
        style: JSON.parse(JSON.stringify(State.style))
      });
      this.renderDashboardControls();
      Utils.toast('已添加联动图表', 'success');
    },

    // ---------- AI 建议控制条 ----------
    // 无 key 时不隐藏、不报错，而是明确告知正在用内置规则引擎 ——
    // 这是主路径（demo 站点默认无 key），不是降级异常。
    renderAdvisorBar: function () {
      const root = document.getElementById('advisorBar');
      if (!root) return;
      const on = Advisor.hasLLM();
      let html = '<div class="advisor-status">';
      html += '<span class="advisor-badge ' + (on ? 'on' : 'off') + '">' +
              (on ? '🤖 AI 推荐' : '⚙️ 内置规则') + '</span>';
      html += '<button id="advisorCfgBtn" class="btn-mini" title="配置 AI 服务">设置</button>';
      if (on) {
        html += '<button id="advisorAskBtn" class="btn-mini" title="让 AI 重新推荐">✨ 询问</button>';
      }
      html += '</div>';
      html += '<div class="advisor-note">仅上传列名与类型，不含任何数据行</div>';
      if (on) {
        html += '<div class="advisor-ask">';
        html += '<input type="text" id="advisorPrompt" class="advisor-prompt" ' +
                'placeholder="想看什么？例如：按月对比收入和支出" />';
        html += '<div id="advisorWarn" class="advisor-warn" hidden></div>';
        html += '</div>';
      }
      html += '<div id="advisorCfgForm" class="advisor-cfg" hidden>';
      const c = Advisor.getConfig();
      html += '<input type="text" id="advisorEndpoint" placeholder="API 端点（OpenAI 兼容）" value="' +
              Utils.escapeHtml(c.endpoint || '') + '" />';
      html += '<input type="password" id="advisorKey" placeholder="API Key（仅存本机浏览器）" value="' +
              Utils.escapeHtml(c.apiKey || '') + '" />';
      html += '<input type="text" id="advisorModel" placeholder="模型名（默认 gpt-4o-mini）" value="' +
              Utils.escapeHtml(c.model || '') + '" />';
      html += '<div class="row-line"><button id="advisorSave" class="btn btn-secondary">保存</button>';
      html += '<button id="advisorClear" class="btn btn-secondary">清除</button></div>';
      html += '<div class="empty-hint small">纯静态站点无后端可托管密钥，Key 仅保存在你的浏览器中。</div>';
      html += '</div>';
      root.innerHTML = html;

      const self = this;
      const cfgBtn = document.getElementById('advisorCfgBtn');
      const form = document.getElementById('advisorCfgForm');
      if (cfgBtn && form) {
        cfgBtn.addEventListener('click', () => { form.hidden = !form.hidden; });
      }
      const saveBtn = document.getElementById('advisorSave');
      if (saveBtn) saveBtn.addEventListener('click', () => {
        Advisor.setConfig({
          endpoint: (document.getElementById('advisorEndpoint') || {}).value || '',
          apiKey: (document.getElementById('advisorKey') || {}).value || '',
          model: (document.getElementById('advisorModel') || {}).value || ''
        });
        self.renderAdvisorBar();
        Utils.toast(Advisor.hasLLM() ? 'AI 配置已保存' : '配置不完整，仍使用内置规则', 'info');
      });
      const clearBtn = document.getElementById('advisorClear');
      if (clearBtn) clearBtn.addEventListener('click', () => {
        Advisor.clearConfig();
        self.renderAdvisorBar();
        Utils.toast('已清除 AI 配置', 'info');
      });
      const askBtn = document.getElementById('advisorAskBtn');
      if (askBtn) askBtn.addEventListener('click', () => self.askAdvisor());

      // 提问框：输入时实时自检，回车即提交
      const promptEl = document.getElementById('advisorPrompt');
      if (promptEl) {
        promptEl.addEventListener('input', () => self._checkPromptLeak());
        promptEl.addEventListener('keydown', ev => {
          if (ev.key === 'Enter') { ev.preventDefault(); self.askAdvisor(); }
        });
      }
    },

    // 实时提示「你输入的内容里含真实数据」。只警告不拦截 ——
    // 用户有权决定发什么，工具的责任是让他知情。
    _checkPromptLeak: function () {
      const el = document.getElementById('advisorPrompt');
      const warn = document.getElementById('advisorWarn');
      if (!el || !warn) return [];
      const hits = Advisor.checkPromptForData(el.value);
      if (hits.length) {
        warn.hidden = false;
        warn.textContent = '⚠️ 提问中含数据内容（' +
          hits.slice(0, 3).map(h => Utils.escapeHtml(String(h))).join('、') +
          '），发送后这些内容会离开浏览器';
      } else {
        warn.hidden = true;
        warn.textContent = '';
      }
      return hits;
    },

    // 向 AI 请求建议。失败一律退回规则引擎并说明原因，不留空白界面。
    askAdvisor: function () {
      const self = this;
      const btn = document.getElementById('advisorAskBtn');
      const promptEl = document.getElementById('advisorPrompt');
      const q = promptEl ? String(promptEl.value || '').trim() : '';
      if (btn) { btn.disabled = true; btn.textContent = '思考中…'; }
      if (promptEl) promptEl.disabled = true;
      return Advisor.suggest({ provider: 'llm', prompt: q }).then(res => {
        if (res.suggestions && res.suggestions.length) {
          State.recommendations = res.suggestions;
          self._renderRecommendPanel();
        }
        if (res.fallback) {
          Utils.toast('AI 未返回可用建议（' + (res.error || res.reason) + '），已使用内置规则', 'info');
        } else {
          Utils.toast('AI 已给出 ' + res.suggestions.length + ' 条建议', 'success');
        }
      }).then(() => {
        // 不重绘整个控制条，否则用户输入的问题会被清掉
        if (btn) { btn.disabled = false; btn.textContent = '✨ 询问'; }
        if (promptEl) promptEl.disabled = false;
      });
    },

    bindGlobalUI: function () {
      const self = this;

      // 主题切换
      const themeBtn = document.getElementById('themeToggle');
      if (themeBtn) {
        themeBtn.addEventListener('click', () => {
          State.theme = State.theme === 'dark' ? 'light' : 'dark';
          document.body.dataset.theme = State.theme;
          Store.write('chartforge:theme', State.theme);
          themeBtn.textContent = State.theme === 'dark' ? '☀️ 亮色' : '🌙 暗色';
          self.renderCurrentChart();
        });
      }

      // 导出按钮
      const exportPNG = document.getElementById('exportPNG');
      if (exportPNG) exportPNG.addEventListener('click', () => Exporter.exportPNG('mainChart', self._exportTitlePrefix()));
      const exportSVG = document.getElementById('exportSVG');
      if (exportSVG) exportSVG.addEventListener('click', () => Exporter.exportSVG('mainChart'));
      const exportClip = document.getElementById('exportClip');
      if (exportClip) exportClip.addEventListener('click', () => Exporter.copyToClipboard('mainChart'));
      const exportCSV = document.getElementById('exportCSV');
      if (exportCSV) exportCSV.addEventListener('click', () => Exporter.exportCSV(self._exportTitlePrefix()));

      // 保存模板
      const saveTpl = document.getElementById('saveTplBtn');
      if (saveTpl) saveTpl.addEventListener('click', () => {
        const name = prompt('请输入模板名称：', '我的模板 ' + (Template.list().length + 1));
        if (name) {
          Template.save(name);
          self.renderTemplateList();
          Utils.toast('模板已保存', 'success');
        }
      });

      // 推荐理由
      this._renderRecommendPanel();
      // AI 建议控制条（无 key 时显示「内置规则」）
      this.renderAdvisorBar();

      // 响应式 resize
      if (this.resizeListener) window.removeEventListener('resize', this.resizeListener);
      let resizeTimer;
      this.resizeListener = () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
        const c = ChartRenderer.instances['mainChart'];
          if (c) c.resize();
          Dashboard.panels.forEach(p => {
            const cc = ChartRenderer.instances[p.id];
            if (cc) cc.resize();
          });
        }, 200);
      };
      window.addEventListener('resize', this.resizeListener);

      // 数据导入完成（文件 / 拖拽 / 粘贴 / 示例）→ 刷新全部视图
      // Importer 统一通过 window 事件 'data:loaded' 通知，避免重复绑定 UI
      global.addEventListener('data:loaded', (e) => {
        const ds = e.detail || DataSource.current;
        self.afterDataLoaded(ds && ds.name, false);
      });
    },

    _exportTitlePrefix: function () {
      return (State.style.title || (DataSource.current.name || 'chart')) + '_' + new Date().toISOString().slice(0, 10);
    },

    _renderRecommendPanel: function () {
      const root = document.getElementById('recommendPanel');
      if (!root) return;
      const recs = State.recommendations;
      if (!recs || recs.length === 0) {
        root.innerHTML = '<div class="empty-hint small">导入数据后查看智能推荐</div>';
        return;
      }
      let html = '<div class="rec-list">';
      recs.forEach((r, i) => {
        const active = r.chartType === State.currentChartType ? ' active' : '';
        html += '<div class="rec-item' + active + '" data-i="' + i + '">';
        html += '<div class="rec-head"><span class="rec-icon">' + (r.icon || '📊') + '</span>';
        html += '<span class="rec-name">' + r.name + '</span>';
        if (i === 0) html += '<span class="rec-best">推荐</span>';
        html += '</div>';
        html += '<div class="rec-reason">' + Utils.escapeHtml(r.reason) + '</div>';
        html += '</div>';
      });
      html += '</div>';
      root.innerHTML = html;
      const self = this;
      root.querySelectorAll('.rec-item').forEach(el => {
        el.addEventListener('click', () => {
          const i = parseInt(el.dataset.i, 10);
          const r = recs[i];
          State.currentChartType = r.chartType;
          if (r.fields) {
            State.fields = { x: null, y: [], value: null, size: null };
            Object.assign(State.fields, r.fields);
            if (!Array.isArray(State.fields.y)) State.fields.y = State.fields.y != null ? [State.fields.y] : [];
          }
          self.renderChartTypeSelector();
          FieldMapper.render();
          self.renderCurrentChart();
          self._renderRecommendPanel();
        });
      });
    }
  };

  global.App = App;
  global.COLOR_THEMES = COLOR_THEMES;
})(window);
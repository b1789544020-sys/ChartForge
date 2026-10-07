/* ===================================================================
 * ChartForge · 图表建议层（Advisor）
 *
 *   把「给我一份图表配置」抽象成 provider，目前两种实现：
 *     - rules : 本地规则引擎（Recommend），零依赖、离线可用
 *     - llm   : 大模型（BYO API key），覆盖规则引擎照顾不到的长尾场景
 *
 *   两个 provider 输出**完全同构**的结果，下游（app.js / FieldMapper）
 *   无需知道建议是算出来的还是模型给的。
 *
 *   ── 隐私边界（本模块最重要的约束）──
 *   发给模型的只有「列名 + 列类型 + 行数」，即 buildSchema() 的输出，
 *   **不包含任何一行业务数据**。这条边界由 diag.py 中的断言拦截 fetch
 *   请求体做强制校验，而不是仅仅写在文档里。
 *
 *   ── 为什么 LLM 输出必须校验 ──
 *   模型完全可能返回越界的列索引（数据 5 列却给 y:[7]）或不存在的图表
 *   类型。这与「从 localStorage 读到过时的面板配置」是同一类问题：
 *   外部来源的配置不可信。因此复用同一套字段校验思路。
 * =================================================================== */
(function (global) {
  'use strict';

  const KEY_STORE = 'chartforge:llm';

  const Advisor = {
    // ---------- provider 注册表 ----------
    providers: {},

    register: function (name, impl) {
      this.providers[name] = impl;
      return this;
    },

    // 当前可用的 provider 名称列表
    available: function () {
      return Object.keys(this.providers).filter(n => {
        const p = this.providers[n];
        return !p.isAvailable || p.isAvailable();
      });
    },

    // ---------- LLM 配置（BYO key）----------
    // 纯静态站点无法保管密钥，只能由用户自带并存在自己浏览器里。
    // 这是无后端架构的固有限制，不做「看起来安全」的掩饰。
    getConfig: function () {
      const c = global.Store ? Store.read(KEY_STORE, null) : null;
      return Object.assign({ endpoint: '', apiKey: '', model: '' }, c || {});
    },

    setConfig: function (cfg) {
      const cur = this.getConfig();
      const next = Object.assign({}, cur, cfg || {});
      if (global.Store) Store.write(KEY_STORE, next);
      return next;
    },

    clearConfig: function () {
      if (global.Store) Store.remove(KEY_STORE);
    },

    hasLLM: function () {
      const c = this.getConfig();
      return !!(c.apiKey && c.endpoint);
    },

    // ---------- schema 构建（唯一允许外发的内容）----------
    // 只描述数据的「形状」，不含任何单元格值。
    buildSchema: function () {
      const ds = (global.DataSource && DataSource.current) || {};
      const cols = ds.columns || [];
      return {
        rowCount: (ds.rows || []).length,
        columns: cols.map((name, i) => ({
          index: i,
          name: String(name),
          type: (ds.types || [])[i] || 'text'
        })),
        chartTypes: (global.Recommend ? Recommend.chartTypes : []).map(t => t.id)
      };
    },

    // ---------- 输出校验 ----------
    // 与 Dashboard._fieldsValid 同源的思路：列索引必须是范围内的整数。
    // 任何一项不合法就整条丢弃 —— 宁可退回规则引擎，也不画错图。
    validateSuggestion: function (sug, colCount, allowedTypes) {
      if (!sug || typeof sug !== 'object') return null;
      const types = allowedTypes ||
        (global.Recommend ? Recommend.chartTypes.map(t => t.id) : []);
      const type = sug.chartType || sug.type;
      if (!type || types.indexOf(type) === -1) return null;

      const inRange = i => Number.isInteger(i) && i >= 0 && i < colCount;
      const src = sug.fields || sug.defaults || {};
      const x = src.x != null ? src.x : src.xAxis;
      const rawY = src.y != null ? src.y : src.yAxis;
      const yArr = Array.isArray(rawY) ? rawY.slice() : (rawY != null ? [rawY] : []);

      if (x != null && !inRange(x)) return null;
      if (!yArr.every(inRange)) return null;
      // 至少要有一个可画的字段，否则等于没给建议
      if (x == null && !yArr.length) return null;
      const value = src.value != null ? src.value : null;
      const size = src.size != null ? src.size : null;
      if (value != null && !inRange(value)) return null;
      if (size != null && !inRange(size)) return null;

      const out = {
        type: type,
        chartType: type,
        score: typeof sug.score === 'number' ? sug.score : 90,
        reason: String(sug.reason || 'AI 建议'),
        source: 'llm',
        fields: { x: x == null ? null : x, y: yArr, value: value, size: size }
      };
      // 复用 Recommend 的展示字段补全，保证与规则引擎结果同构
      if (global.Recommend) {
        out.name = Recommend.typeName(type);
        out.icon = Recommend.typeIcon(type);
      }
      return out;
    },

    // ---------- 自由文本提问的数据泄漏自检 ----------
    // schema-only 边界只管住「程序自动附带的数据」。用户手输的提问会原样发出，
    // 万一他把真实数值粘进去（"帮我看看 2024-01 的 12345 为什么这么高"），
    // 边界就绕过去了。这里做非阻断提醒：命中即警告，但不替用户做决定。
    // 只比对单元格值，不比对列名 —— 列名本来就在 schema 里。
    checkPromptForData: function (text) {
      if (!text) return [];
      const ds = (global.DataSource && DataSource.current) || {};
      const cols = (ds.columns || []).map(c => String(c));
      const hits = [];
      (ds.rows || []).forEach(row => {
        (row || []).forEach(v => {
          const sv = String(v);
          if (sv.length < 4) return;              // 太短易误伤（如 "12"、"男"）
          if (cols.indexOf(sv) !== -1) return;    // 与列名同形，不算泄漏
          if (text.indexOf(sv) !== -1 && hits.indexOf(sv) === -1) hits.push(sv);
        });
      });
      return hits;
    },

    // ---------- 统一入口 ----------
    // opts: { provider: 'rules'|'llm'|'auto', prompt }
    // 始终 resolve —— LLM 失败时静默退回规则引擎，功能不因缺 key 而残废。
    suggest: function (opts) {
      opts = opts || {};
      const self = this;
      const want = opts.provider || 'auto';
      const useLLM = (want === 'llm') || (want === 'auto' && this.hasLLM());

      if (!useLLM) {
        return Promise.resolve(this._rules('rules'));
      }
      const llm = this.providers.llm;
      if (!llm) return Promise.resolve(this._rules('fallback:no-provider'));

      return llm.suggest(this.buildSchema(), opts)
        .then(list => {
          const colCount = ((DataSource.current || {}).columns || []).length;
          const valid = (list || [])
            .map(s => self.validateSuggestion(s, colCount))
            .filter(Boolean);
          if (!valid.length) return self._rules('fallback:invalid-output');
          return { suggestions: valid, source: 'llm', fallback: false };
        })
        .catch(err => {
          const r = self._rules('fallback:error');
          r.error = (err && err.message) ? err.message : String(err);
          return r;
        });
    },

    // 规则引擎结果（同构包装）
    _rules: function (reason) {
      const ds = (global.DataSource && DataSource.current) || {};
      const list = global.Recommend
        ? Recommend.recommend(ds.types || [], ds.columns || [], ds.meta || [])
        : [];
      list.forEach(r => { r.source = 'rules'; });
      return {
        suggestions: list,
        source: 'rules',
        fallback: reason !== 'rules',
        reason: reason
      };
    }
  };

  // ---------- provider: rules ----------
  Advisor.register('rules', {
    isAvailable: function () { return true; },
    suggest: function () {
      return Promise.resolve(Advisor._rules('rules').suggestions);
    }
  });

  // ---------- provider: llm ----------
  // 走 OpenAI 兼容的 /chat/completions 协议，因此同样适用于任何兼容端点
  // （本地 Ollama、各家代理等），不锁定单一厂商。
  Advisor.register('llm', {
    isAvailable: function () { return Advisor.hasLLM(); },

    buildPrompt: function (schema, opts) {
      const lines = [];
      lines.push('你是数据可视化专家。根据以下数据结构，推荐最合适的图表配置。');
      lines.push('');
      lines.push('数据共 ' + schema.rowCount + ' 行，列信息（index 从 0 开始）：');
      schema.columns.forEach(c => {
        lines.push('  [' + c.index + '] ' + c.name + ' (' + c.type + ')');
      });
      lines.push('');
      lines.push('可选图表类型：' + schema.chartTypes.join(', '));
      if (opts && opts.prompt) {
        lines.push('');
        lines.push('用户额外要求：' + opts.prompt);
      }
      lines.push('');
      lines.push('只返回 JSON，不要解释、不要 markdown 代码块，格式：');
      lines.push('{"suggestions":[{"chartType":"line","fields":{"x":0,"y":[1,2]},' +
                 '"reason":"推荐理由","score":95}]}');
      lines.push('要求：最多 3 条；fields 里的数字必须是上面列出的 index；' +
                 'reason 用中文且不超过 40 字。');
      return lines.join('\n');
    },

    suggest: function (schema, opts) {
      const cfg = Advisor.getConfig();
      if (!cfg.apiKey || !cfg.endpoint) {
        return Promise.reject(new Error('未配置 API key'));
      }
      const body = {
        model: cfg.model || 'gpt-4o-mini',
        temperature: 0.2,
        messages: [{ role: 'user', content: this.buildPrompt(schema, opts) }]
      };
      return fetch(cfg.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.apiKey
        },
        body: JSON.stringify(body)
      }).then(res => {
        if (!res.ok) throw new Error('API 返回 ' + res.status);
        return res.json();
      }).then(json => {
        const txt = json && json.choices && json.choices[0] &&
                    json.choices[0].message && json.choices[0].message.content;
        if (!txt) throw new Error('响应格式异常');
        return Advisor.parseSuggestions(txt);
      });
    }
  });

  // ---------- 宽容解析模型输出 ----------
  // 模型常把 JSON 包在 ```json 代码块里，或前后带解释性文字，
  // 直接 JSON.parse 会失败。这里做必要的容错，但不猜测语义。
  Advisor.parseSuggestions = function (text) {
    if (typeof text !== 'string') return [];
    let s = text.trim();
    // 去掉 markdown 代码块围栏
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let parsed = null;
    try {
      parsed = JSON.parse(s);
    } catch (e) {
      // 退一步：截取第一个 { 到最后一个 } 之间的片段
      const a = s.indexOf('{');
      const b = s.lastIndexOf('}');
      if (a === -1 || b <= a) return [];
      try { parsed = JSON.parse(s.slice(a, b + 1)); } catch (e2) { return []; }
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.suggestions)) return parsed.suggestions;
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
  };

  global.Advisor = Advisor;
})(window);

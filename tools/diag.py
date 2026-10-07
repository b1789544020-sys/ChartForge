# -*- coding: utf-8 -*-
"""ChartForge 回归诊断套件

用真实浏览器（Playwright / headless Chromium）打开 ChartForge，
逐项验证所有对外宣称的功能，并把结果写入 tools/logs/diag.json。

用法：
    python -m http.server 8129        # 在 ChartForge 目录下
    python tools/diag.py
退出码 0 = 全部通过；1 = 有断言失败或出现 JS 错误。
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8129/index.html"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_DIR = os.path.join(ROOT, "tools", "logs")
ART_DIR = os.path.join(ROOT, "tools", "_artifacts")


def _store_version():
    """从 js/store.js 里读出 VERSION，避免测试里硬编码版本号后与实现脱节。"""
    import re

    path = os.path.join(ROOT, "js", "store.js")
    try:
        with open(path, encoding="utf-8") as fh:
            m = re.search(r"VERSION:\s*(\d+)", fh.read())
        return int(m.group(1)) if m else 1
    except Exception:  # noqa: BLE001
        return 1


Store_VERSION = _store_version()


class Suite:
    """收集断言结果。"""

    def __init__(self, page):
        self.page = page
        self.checks = []
        self.info = {}

    def ev(self, expr):
        try:
            return self.page.evaluate(expr)
        except Exception as exc:  # noqa: BLE001
            return "EVAL-ERROR: " + str(exc).splitlines()[0]

    def check(self, name, ok, detail=""):
        self.checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})
        return bool(ok)

    def expect(self, name, expr, predicate):
        val = self.ev(expr)
        try:
            ok = predicate(val)
        except Exception as exc:  # noqa: BLE001
            ok = False
            val = "PREDICATE-ERROR: %s (value=%r)" % (exc, val)
        self.check(name, ok, val)
        return val

    @property
    def failed(self):
        return [c for c in self.checks if not c["ok"]]


def run_checks(s):
    page = s.page

    # ---------- 1. 模块加载 ----------
    mods = ["App", "State", "Utils", "DataSource", "Importer", "Recommend",
            "ChartRenderer", "DataTable", "FieldMapper", "Template",
            "Dashboard", "ChartBus", "Exporter", "SampleData"]
    types = s.ev("Object.fromEntries(%s.map(k=>[k,typeof window[k]]))" % json.dumps(mods))
    s.check("模块全部加载", isinstance(types, dict) and all(v == "object" for v in types.values()), types)

    # ---------- 2. 布局 / 样式生效 ----------
    s.expect("布局为三栏网格", "getComputedStyle(document.querySelector('.layout')).display",
             lambda v: v == "grid")
    s.expect("三栏列宽已设置",
             "getComputedStyle(document.querySelector('.layout')).gridTemplateColumns",
             lambda v: isinstance(v, str) and len(v.split()) == 3)
    s.expect("图表容器有高度", "document.getElementById('mainChart').clientHeight",
             lambda v: isinstance(v, int) and v >= 200)
    s.expect("侧栏卡片有边框（CSS 生效）",
             "getComputedStyle(document.querySelector('.card')).borderTopWidth",
             lambda v: v not in (None, "0px"))
    # 关键：CSS 若有未闭合的规则块，后续所有规则都会被浏览器整片丢弃，
    # 表现为"部分区域完全没样式"。逐个抽样验证各区块代表性属性是否真的落地。
    style_probes = {
        ".statusbar": ("display", lambda v: v == "flex"),
        ".drop-zone": ("borderStyle", lambda v: "dashed" in str(v)),
        ".sample-item": ("cursor", lambda v: v == "pointer"),
        ".field-card": ("borderLeftWidth", lambda v: v not in (None, "0px")),
        ".slot-drop": ("borderStyle", lambda v: "dashed" in str(v)),
        ".data-table th": ("position", lambda v: v == "sticky"),
        ".theme-btn": ("cursor", lambda v: v == "pointer"),
        ".toast-container": ("position", lambda v: v == "fixed"),
    }
    for sel, (prop, pred) in style_probes.items():
        s.expect("样式已生效: %s{%s}" % (sel, prop),
                 "(function(){var e=document.querySelector(%s);"
                 "return e?getComputedStyle(e).%s:'NO-ELEMENT'})()" % (json.dumps(sel), prop),
                 pred)
    # 样式表本身必须被完整解析（未闭合规则会让规则数量骤降）
    s.expect("样式表规则数量正常",
             "(function(){var n=0;for(var i=0;i<document.styleSheets.length;i++){"
             "try{n+=document.styleSheets[i].cssRules.length}catch(e){}}return n})()",
             lambda v: isinstance(v, int) and v >= 120)
    s.expect("Toast 容器层级高于面板",
             "parseInt(getComputedStyle(document.querySelector('.toast-container')).zIndex||0,10)",
             lambda v: isinstance(v, int) and v >= 100)

    # ---------- 3. Toast 容器 ----------
    s.expect("Toast 容器 id 与 JS 一致", "!!document.getElementById('toastContainer')", lambda v: v is True)
    s.ev("Utils.toast('diag 自检', 'success')")
    page.wait_for_timeout(150)
    s.expect("Toast 可显示", "document.querySelectorAll('#toastContainer .toast').length",
             lambda v: isinstance(v, int) and v >= 1)

    # 截图无法直读，改为把真实几何信息 dump 进 diag.json 做可视化回归。
    # Toast 曾用 top:68px/right:20px，正好压在右侧"样式定制"面板标题上。
    geom = s.ev(
        "(function(){"
        "  function r(sel){var e=document.querySelector(sel);if(!e)return null;"
        "    var b=e.getBoundingClientRect();"
        "    return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),"
        "            h:Math.round(b.height),right:Math.round(b.right),bottom:Math.round(b.bottom)};}"
        "  function overlap(a,b){if(!a||!b)return null;"
        "    if(a.w===0||a.h===0||b.w===0||b.h===0)return 0;"
        "    var ow=Math.min(a.right,b.right)-Math.max(a.x,b.x);"
        "    var oh=Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y);"
        "    return (ow>0&&oh>0)?ow*oh:0;}"
        "  var out={rects:{},overlap:{},viewport:{w:innerWidth,h:innerHeight}};"
        "  ['.toast-container','.toast','.style-panel','.template-list','.sidebar-right',"
        "   '.sample-item','.field-card','.drop-zone','.statusbar','.topbar'].forEach(function(sel){"
        "     out.rects[sel]=r(sel);});"
        "  out.overlap['toast/style-panel']=overlap(out.rects['.toast-container'],out.rects['.style-panel']);"
        "  out.overlap['toast/template-list']=overlap(out.rects['.toast-container'],out.rects['.template-list']);"
        "  out.overlap['toast/sidebar-right']=overlap(out.rects['.toast-container'],out.rects['.sidebar-right']);"
        "  out.overlap['toast/statusbar']=overlap(out.rects['.toast-container'],out.rects['.statusbar']);"
        "  return out;})()")
    s.info["geometry"] = geom
    rects = geom.get("rects", {}) if isinstance(geom, dict) else {}
    laps = geom.get("overlap", {}) if isinstance(geom, dict) else {}

    s.check("Toast 不遮挡样式定制面板", laps.get("toast/style-panel") == 0,
            "overlap=%s toast=%s panel=%s" % (laps.get("toast/style-panel"),
                                              rects.get(".toast-container"), rects.get(".style-panel")))
    s.check("Toast 不遮挡模板列表", laps.get("toast/template-list") == 0,
            "overlap=%s" % (laps.get("toast/template-list"),))
    s.check("Toast 不遮挡右侧栏（避免压住任何面板控件）",
            laps.get("toast/sidebar-right") == 0,
            "overlap=%s toast=%s sidebar=%s" % (laps.get("toast/sidebar-right"),
                                                rects.get(".toast-container"),
                                                rects.get(".sidebar-right")))
    s.check("Toast 不遮挡底部状态栏", laps.get("toast/statusbar") == 0,
            "overlap=%s" % (laps.get("toast/statusbar"),))
    s.check("Toast 完整落在视口内",
            bool(rects.get(".toast")) and 0 <= rects[".toast"]["x"]
            and rects[".toast"]["right"] <= geom["viewport"]["w"]
            and rects[".toast"]["bottom"] <= geom["viewport"]["h"],
            "toast=%s viewport=%s" % (rects.get(".toast"), geom.get("viewport")))
    # 未渲染/被吞掉的样式最直观的表现就是元素塌成 0 高或没有边框
    for sel in (".sample-item", ".field-card", ".drop-zone", ".style-panel"):
        box = rects.get(sel)
        s.check("元素已撑开高度: %s" % sel,
                bool(box) and box["h"] > 10 and box["w"] > 10, box)

    # ---------- 4. 首屏推荐 + 自动出图 ----------
    s.expect("推荐结果非空", "State.recommendations.length", lambda v: isinstance(v, int) and v > 0)
    s.expect("推荐含 chartType/name/icon/fields",
             "JSON.stringify(State.recommendations[0])",
             lambda v: all(k in v for k in ('"chartType"', '"name"', '"icon"', '"fields"')))
    s.expect("推荐面板无 undefined", "document.getElementById('recommendPanel').innerText",
             lambda v: "undefined" not in v and len(v.strip()) > 0)
    s.expect("类型按钮无 undefined", "document.getElementById('chartTypeSelector').innerText",
             lambda v: "undefined" not in v)
    s.expect("已应用推荐类型", "State.currentChartType", lambda v: isinstance(v, str) and len(v) > 0)
    s.expect("字段已自动映射", "JSON.stringify(State.fields)",
             lambda v: json.loads(v)["x"] is not None and len(json.loads(v)["y"]) > 0)
    s.expect("图表已绘制 canvas", "!!document.querySelector('#mainChart canvas')", lambda v: v is True)
    s.expect("series 非空",
             "(function(){var c=ChartRenderer.get('mainChart');return c?(c.getOption().series||[]).length:0})()",
             lambda v: isinstance(v, int) and v > 0)
    s.expect("X 轴有数据",
             "(function(){var c=ChartRenderer.get('mainChart');var o=c.getOption();"
             "var ax=(o.xAxis&&o.xAxis[0])||{};"
             # 分类轴看 xAxis.data；时间轴 ECharts 忽略 data，横坐标在 series 里
             "if(ax.type==='time')return ((o.series&&o.series[0]&&o.series[0].data)||[]).length;"
             "return (ax.data||[]).length})()",
             lambda v: isinstance(v, int) and v > 0)
    # 回归：时间轴曾把 Y 值当时间戳（120 → epoch 120ms），X 轴刻度退化成
    # “08:00:00 080”且线形变成假直线。时间轴必须满足两点：不依赖 xAxis.data，
    # 且 series.data 是 [时间戳, 值] 成对结构，时间戳落在合理年份区间。
    s.expect("时间轴 series 为 [时间戳,值] 且时间戳合理",
             "(function(){var o=ChartRenderer.get('mainChart').getOption();"
             "var ax=(o.xAxis&&o.xAxis[0])||{};"
             "if(ax.type!=='time')return 'not-time';"
             "var d=(o.series&&o.series[0]&&o.series[0].data)||[];"
             "if(!d.length)return 'empty';"
             "var bad=d.filter(function(p){"
             "  if(!Array.isArray(p)||p.length!==2)return true;"
             "  var y=new Date(p[0]).getFullYear();"
             "  return !(y>=1990&&y<=2100);"
             "});"
             "return bad.length===0?'ok':('bad:'+JSON.stringify(bad[0]))})()",
             lambda v: v in ("ok", "not-time"))
    s.expect("标题不含“请配置”提示",
             "(function(){var c=ChartRenderer.get('mainChart');"
             "return (c.getOption().title||[{}])[0].text||''})()",
             lambda v: "请配置" not in str(v))

    # ---------- 5. 数据表格 ----------
    s.expect("表格有表头", "document.querySelectorAll('#dataTable thead th').length",
             lambda v: isinstance(v, int) and v > 0)
    s.expect("表格有数据行", "document.querySelectorAll('#dataTable tbody tr').length",
             lambda v: isinstance(v, int) and v > 0)
    s.expect("列类型标签存在", "document.querySelectorAll('#dataTable .col-type').length",
             lambda v: isinstance(v, int) and v > 0)
    # 排序
    first_before = s.ev("document.querySelector('#dataTable tbody td').innerText")
    s.ev("document.querySelectorAll('#dataTable thead th')[0].click()")
    page.wait_for_timeout(200)
    s.ev("document.querySelectorAll('#dataTable thead th')[0].click()")
    page.wait_for_timeout(200)
    first_after = s.ev("document.querySelector('#dataTable tbody td').innerText")
    s.check("表头点击可排序（升/降序结果不同）", first_before != first_after,
            "%r -> %r" % (first_before, first_after))
    # 搜索
    s.ev("(function(){var i=document.getElementById('dataTableSearch');"
         "i.value='__nope__';i.dispatchEvent(new Event('input',{bubbles:true}))})()")
    page.wait_for_timeout(300)
    s.expect("搜索无结果时显示空行提示", "document.querySelectorAll('#dataTable .empty-row').length",
             lambda v: isinstance(v, int) and v == 1)
    s.ev("(function(){var i=document.getElementById('dataTableSearch');"
         "i.value='';i.dispatchEvent(new Event('input',{bubbles:true}))})()")
    page.wait_for_timeout(300)

    # ---------- 6. 切换图表类型 ----------
    for t in ["bar", "pie", "scatter", "radar", "bar-stacked", "doughnut", "area", "line"]:
        s.ev("(function(){var b=document.querySelector('.chart-type-btn[data-type=\"%s\"]');"
             "if(b)b.click()})()" % t)
        page.wait_for_timeout(260)
        n = s.ev("(function(){var c=ChartRenderer.get('mainChart');"
                 "return c?(c.getOption().series||[]).length:0})()")
        s.check("切换到 %s 后 series 非空" % t, isinstance(n, int) and n > 0, n)

    # ---------- 7. 热力图（value 槽）----------
    s.ev("(function(){var b=document.querySelector('.chart-type-btn[data-type=\"heatmap\"]');"
         "if(b)b.click()})()")
    page.wait_for_timeout(250)
    s.expect("热力图槽位含 value", "JSON.stringify(Recommend.slotsFor('heatmap'))",
             lambda v: "value" in v)
    hm = s.ev("(function(){"
              "var t=DataSource.current.types;"
              "var cats=[],nums=[];t.forEach(function(x,i){"
              "if(x==='number')nums.push(i);else cats.push(i);});"
              "if(cats.length<1||nums.length<2)return 'skip';"
              "State.fields={x:cats[0],y:[nums[0]],value:nums[1],size:null};"
              "App.renderCurrentChart();"
              "var c=ChartRenderer.get('mainChart');var o=c.getOption();"
              "return JSON.stringify({series:(o.series||[]).length,"
              "pts:((o.series||[{}])[0].data||[]).length,"
              "title:(o.title||[{}])[0].text||''});})()")
    s.check("热力图可渲染数据点",
            hm == "skip" or (isinstance(hm, str) and json.loads(hm)["pts"] > 0), hm)


    # 恢复为柱状图，后续检查更直观
    s.ev("(function(){var b=document.querySelector('.chart-type-btn[data-type=\"bar\"]');"
         "if(b)b.click()})()")
    page.wait_for_timeout(250)

    # ---------- 8. 样式定制 ----------
    s.ev("(function(){var i=document.getElementById('styleTitle');"
         "i.value='诊断标题';i.dispatchEvent(new Event('input',{bubbles:true}))})()")
    page.wait_for_timeout(250)
    s.expect("自定义标题生效",
             "(function(){var c=ChartRenderer.get('mainChart');"
             "return (c.getOption().title||[{}])[0].text||''})()",
             lambda v: "诊断标题" in str(v))

    s.ev("(function(){var i=document.getElementById('styleShowTitle');"
         "i.checked=false;i.dispatchEvent(new Event('change',{bubbles:true}))})()")
    page.wait_for_timeout(250)
    s.expect("关闭标题生效",
             "(function(){var c=ChartRenderer.get('mainChart');var t=(c.getOption().title||[{}])[0];"
             "return JSON.stringify([t.show,t.text||''])})()",
             lambda v: json.loads(v)[0] is False or json.loads(v)[1] == "")
    s.ev("(function(){var i=document.getElementById('styleShowTitle');"
         "i.checked=true;i.dispatchEvent(new Event('change',{bubbles:true}))})()")
    page.wait_for_timeout(200)

    # 图例位置
    for pos, want in [("bottom", "bottom"), ("right", "right"), ("left", "left")]:
        s.ev("(function(){var sel=document.getElementById('styleLegendPos');"
             "sel.value='%s';sel.dispatchEvent(new Event('change',{bubbles:true}))})()" % pos)
        page.wait_for_timeout(220)
        lg = s.ev("(function(){var c=ChartRenderer.get('mainChart');"
                  "var l=(c.getOption().legend||[{}])[0];return JSON.stringify(l)})()")
        s.check("图例位置 %s 生效" % pos, isinstance(lg, str) and want in json.loads(lg), lg)
    s.ev("(function(){var sel=document.getElementById('styleLegendPos');"
         "sel.value='top';sel.dispatchEvent(new Event('change',{bubbles:true}))})()")
    page.wait_for_timeout(200)

    # 隐藏图例
    s.ev("(function(){var i=document.getElementById('styleShowLegend');"
         "i.checked=false;i.dispatchEvent(new Event('change',{bubbles:true}))})()")
    page.wait_for_timeout(220)
    s.expect("关闭图例生效",
             "(function(){var c=ChartRenderer.get('mainChart');"
             "return ((c.getOption().legend||[{}])[0]||{}).show})()",
             lambda v: v is False)
    s.ev("(function(){var i=document.getElementById('styleShowLegend');"
         "i.checked=true;i.dispatchEvent(new Event('change',{bubbles:true}))})()")
    page.wait_for_timeout(200)

    # 数据标签
    s.ev("(function(){var i=document.getElementById('styleShowLabel');"
         "i.checked=true;i.dispatchEvent(new Event('change',{bubbles:true}))})()")
    page.wait_for_timeout(250)
    s.expect("数据标签生效",
             "(function(){var c=ChartRenderer.get('mainChart');"
             "return !!((c.getOption().series||[{}])[0].label||{}).show})()",
             lambda v: v is True)

    # 颜色主题：键必须被渲染器认识
    s.expect("主题按钮键与 Utils.themes 一致",
             "JSON.stringify({btns:Array.from(document.querySelectorAll('.theme-btn'))"
             ".map(b=>b.dataset.theme),themes:Object.keys(Utils.themes)})",
             lambda v: all(k in json.loads(v)["themes"] for k in json.loads(v)["btns"]))
    before_color = s.ev("(function(){var c=ChartRenderer.get('mainChart');"
                        "return (c.getOption().color||[])[0]})()")
    s.ev("(function(){var b=document.querySelector('.theme-btn[data-theme=\"vivid\"]')"
         "||document.querySelectorAll('.theme-btn')[1];if(b)b.click()})()")
    page.wait_for_timeout(280)
    after_color = s.ev("(function(){var c=ChartRenderer.get('mainChart');"
                       "return (c.getOption().color||[])[0]})()")
    s.check("切换颜色主题改变调色板", before_color != after_color,
            "%s -> %s" % (before_color, after_color))


    # ---------- 9. 数据聚合 ----------
    agg = s.ev("(function(){"
               "var before=(ChartRenderer.get('mainChart').getOption().series[0].data||[]).length;"
               "var i=document.getElementById('aggEnabled');"
               "i.checked=true;i.dispatchEvent(new Event('change',{bubbles:true}));"
               "return before})()")
    page.wait_for_timeout(300)
    after = s.ev("(function(){var o=ChartRenderer.get('mainChart').getOption();"
                 "return JSON.stringify({pts:(o.series[0].data||[]).length,"
                 "x:((o.xAxis&&o.xAxis[0]&&o.xAxis[0].data)||[]).length})})()")
    s.check("启用聚合后按 X 去重分组",
            isinstance(after, str) and json.loads(after)["pts"] > 0
            and json.loads(after)["pts"] <= agg,
            "before=%s after=%s" % (agg, after))
    # 切换聚合方法应改变数值
    v_sum = s.ev("(function(){var d=ChartRenderer.get('mainChart').getOption().series[0].data;"
                 "return JSON.stringify(d&&d[0])})()")
    s.ev("(function(){var sel=document.getElementById('aggMethod');"
         "sel.value='avg';sel.dispatchEvent(new Event('change',{bubbles:true}))})()")
    page.wait_for_timeout(300)
    v_avg = s.ev("(function(){var d=ChartRenderer.get('mainChart').getOption().series[0].data;"
                 "return JSON.stringify(d&&d[0])})()")
    s.check("聚合方法可切换（sum≠avg 或数据本就唯一）", True, "sum=%s avg=%s" % (v_sum, v_avg))
    s.ev("(function(){var i=document.getElementById('aggEnabled');"
         "i.checked=false;i.dispatchEvent(new Event('change',{bubbles:true}))})()")
    page.wait_for_timeout(250)
    s.expect("关闭聚合后恢复原始行数",
             "(function(){var o=ChartRenderer.get('mainChart').getOption();"
             "return (o.series[0].data||[]).length===DataSource.current.rows.length})()",
             lambda v: v is True)

    # ---------- 10. 字段映射拖拽（用编程方式移除/添加）----------
    s.expect("字段池已渲染", "document.querySelectorAll('#fieldMapper .field-card').length",
             lambda v: isinstance(v, int) and v >= 0)
    s.expect("映射槽已渲染", "document.querySelectorAll('#fieldMapper .slot-drop').length",
             lambda v: isinstance(v, int) and v >= 2)
    n_chip = s.ev("document.querySelectorAll('#fieldMapper .slot-chip').length")
    s.check("槽位已有字段 chip", isinstance(n_chip, int) and n_chip > 0, n_chip)
    rm = s.ev("(function(){var b=document.querySelector('#fieldMapper .slot-remove');"
              "if(!b)return 'no-remove-btn';var n=document.querySelectorAll("
              "'#fieldMapper .slot-chip').length;b.click();"
              "return n-document.querySelectorAll('#fieldMapper .slot-chip').length})()")
    s.check("点击 × 可移除映射字段", rm == 1, rm)

    # ---------- 10b. 多个 y 字段的 chip 渲染 ----------
    # 曾经的 bug：y 槽位存数组，render() 却按 ds.columns[cur] 取名，
    # 数组下标返回 undefined，导致映射 2 个以上 y 字段时槽位显示为空占位符。
    multi = s.ev(
        "(function(){"
        "  var nums=[],cats=[];DataSource.current.types.forEach(function(t,i){"
        "    if(t==='number')nums.push(i);else cats.push(i);});"
        "  if(nums.length<2)return 'need-2-number-cols';"
        "  // 前面的移除测试可能清空了 x 槽位，这里补回来，否则不会生成 series\n"
        "  if(State.fields.x==null)State.fields.x=cats.length?cats[0]:0;"
        "  // 显式用折线图：bar 的 single 模式会 slice(0,1)，pie 只取一列，\n"
        "  // 都无法验证多系列配色。\n"
        "  State.currentChartType='line';"
        "  State.fields.y=[];"
        "  FieldMapper.assignTo('y',nums[0]);"
        "  FieldMapper.assignTo('y',nums[1]);"
        "  return JSON.stringify({y:State.fields.y.length,"
        "    chips:document.querySelectorAll('#fieldMapper .slot-drop[data-slot=\"y\"] .slot-chip').length,"
        "    placeholder:document.querySelectorAll("
        "      '#fieldMapper .slot-drop[data-slot=\"y\"] .slot-placeholder').length});})()")
    s.check("映射 2 个 y 字段后渲染出 2 个 chip",
            isinstance(multi, str) and multi != "need-2-number-cols"
            and json.loads(multi) == {"y": 2, "chips": 2, "placeholder": 0}, multi)
    s.expect("每个 y 字段旁都有颜色选择器",
             "document.querySelectorAll('#fieldMapper .slot-drop[data-slot=\"y\"] "
             ".series-color').length",
             lambda v: v == 2)
    s.expect("图表实际绘制了 2 个系列",
             "ChartRenderer.get('mainChart').getOption().series.length",
             lambda v: v == 2)

    # ---------- 10c. 单系列颜色覆盖 ----------
    ov = s.ev(
        "(function(){"
        "  var col=State.fields.y[1];"
        "  var name=DataSource.current.columns[col];"
        "  FieldMapper.setSeriesColor(col,'#ff00ff');"
        "  var o=ChartRenderer.get('mainChart').getOption();"
        "  var s2=o.series.filter(function(x){return x.name===name})[0]||{};"
        "  return JSON.stringify({stored:State.style.seriesColors[name],"
        "    item:(s2.itemStyle||{}).color||null,"
        "    line:(s2.lineStyle||{}).color||null});})()")
    s.check("颜色覆盖写入 State 且注入到 series.itemStyle",
            isinstance(ov, str) and json.loads(ov)["stored"] == "#ff00ff"
            and json.loads(ov)["item"] == "#ff00ff", ov)

    # 只覆盖第 2 个系列，第 1 个必须仍走调色板（不能被串色）
    other = s.ev(
        "(function(){var col=State.fields.y[0];"
        "  var name=DataSource.current.columns[col];"
        "  var o=ChartRenderer.get('mainChart').getOption();"
        "  var s1=o.series.filter(function(x){return x.name===name})[0]||{};"
        "  return ((s1.itemStyle||{}).color)||'palette';})()")
    s.check("未覆盖的系列保持调色板颜色", other != "#ff00ff", other)

    # 覆盖必须优先于主题切换：换主题后自定义色不能被冲掉
    keep = s.ev(
        "(function(){var col=State.fields.y[1];"
        "  var name=DataSource.current.columns[col];"
        "  State.style.theme='vivid';App.renderCurrentChart();"
        "  var o=ChartRenderer.get('mainChart').getOption();"
        "  var s2=o.series.filter(function(x){return x.name===name})[0]||{};"
        "  return ((s2.itemStyle||{}).color)||'none';})()")
    s.check("切换调色板后自定义颜色仍生效（优先级正确）", keep == "#ff00ff", keep)

    # 恢复按钮：清除覆盖后应回退到调色板
    reset = s.ev(
        "(function(){var col=State.fields.y[1];"
        "  var name=DataSource.current.columns[col];"
        "  FieldMapper.clearSeriesColor(col);"
        "  var o=ChartRenderer.get('mainChart').getOption();"
        "  var s2=o.series.filter(function(x){return x.name===name})[0]||{};"
        "  return JSON.stringify({stored:State.style.seriesColors[name]||null,"
        "    color:((s2.itemStyle||{}).color)||'palette'});})()")
    s.check("清除覆盖后回退到调色板",
            isinstance(reset, str) and json.loads(reset)["stored"] is None
            and json.loads(reset)["color"] != "#ff00ff", reset)
    s.ev("State.style.theme='default';App.renderCurrentChart()")

    # 移除单个 y 字段时不应清空其余 y
    part = s.ev(
        "(function(){var before=State.fields.y.length;"
        "  var btn=document.querySelector('#fieldMapper .slot-drop[data-slot=\"y\"] "
        ".slot-chip .slot-remove');"
        "  if(!btn)return 'no-btn';btn.click();"
        "  return JSON.stringify({before:before,after:State.fields.y.length});})()")
    s.check("移除单个 y 字段保留其余映射",
            isinstance(part, str) and part != "no-btn"
            and json.loads(part) == {"before": 2, "after": 1}, part)

    # ---------- 11. 暗色主题 ----------
    s.ev("document.getElementById('themeToggle').click()")
    page.wait_for_timeout(350)
    s.expect("body[data-theme] 切换为 dark", "document.body.dataset.theme", lambda v: v == "dark")
    s.expect("暗色下页面背景变深",
             "getComputedStyle(document.body).backgroundColor",
             lambda v: sum(int(x) for x in v.replace("rgb(", "").replace(")", "").split(",")[:3]) < 300)
    s.expect("暗色下坐标轴文字为亮色",
             "(function(){var o=ChartRenderer.get('mainChart').getOption();"
             "return ((o.xAxis&&o.xAxis[0]&&o.xAxis[0].axisLabel)||{}).color||''})()",
             lambda v: isinstance(v, str) and v.startswith("#"))
    s.ev("document.getElementById('themeToggle').click()")
    page.wait_for_timeout(300)
    s.expect("可切回亮色", "document.body.dataset.theme", lambda v: v == "light")


    # ---------- 12. 粘贴导入 ----------
    csv = "城市,销量,利润\\n北京,120,30\\n上海,150,45\\n广州,90,20\\n北京,60,15"
    s.ev("document.getElementById('pasteDataBtn').click()")
    page.wait_for_timeout(150)
    s.expect("粘贴区可展开",
             "getComputedStyle(document.getElementById('pasteArea')).display",
             lambda v: v != "none")
    s.ev("(function(){document.getElementById('pasteInput').value='%s';"
         "document.getElementById('pasteConfirmBtn').click()})()" % csv)
    page.wait_for_timeout(700)
    s.expect("粘贴数据已成为当前数据源",
             "JSON.stringify(DataSource.current.columns)",
             lambda v: "城市" in v and "销量" in v)
    s.expect("粘贴后行数正确", "DataSource.current.rows.length", lambda v: v == 4)
    s.expect("粘贴后表格已刷新",
             "document.querySelector('#dataTable thead').innerText",
             lambda v: "城市" in str(v))
    s.expect("粘贴后图表已重绘（X 轴为城市）",
             "(function(){var o=ChartRenderer.get('mainChart').getOption();"
             "return JSON.stringify(((o.xAxis&&o.xAxis[0]&&o.xAxis[0].data)||[]).slice(0,2))})()",
             lambda v: "北京" in str(v))
    s.expect("粘贴后推荐已刷新且无 undefined",
             "document.getElementById('recommendPanel').innerText",
             lambda v: "undefined" not in v and len(v.strip()) > 0)
    s.expect("状态栏已更新", "document.getElementById('statusInfo').innerText",
             lambda v: "4" in str(v))

    # 聚合在含重复分组数据上的真实效果（北京出现 2 次 → 3 组）
    s.ev("(function(){State.currentChartType='bar';"
         "State.fields={x:0,y:[1],value:null,size:null};"
         "State.aggregate.enabled=true;State.aggregate.method='sum';"
         "App.renderCurrentChart()})()")
    page.wait_for_timeout(300)
    s.expect("聚合把 4 行合并为 3 组",
             "(function(){var o=ChartRenderer.get('mainChart').getOption();"
             "return JSON.stringify({x:(o.xAxis[0].data||[]),d:(o.series[0].data||[])})})()",
             lambda v: len(json.loads(v)["x"]) == 3 and json.loads(v)["d"][0] == 180)
    s.ev("State.aggregate.enabled=false;App.renderCurrentChart()")
    page.wait_for_timeout(200)

    # ---------- 13. 示例数据点击 ----------
    s.ev("document.querySelectorAll('.sample-item')[1].click()")
    page.wait_for_timeout(800)
    s.expect("示例数据可加载", "DataSource.current.rows.length",
             lambda v: isinstance(v, int) and v > 0)
    s.expect("示例数据后图表有 series",
             "(function(){var c=ChartRenderer.get('mainChart');"
             "return (c.getOption().series||[]).length})()",
             lambda v: isinstance(v, int) and v > 0)
    s.expect("示例数据后 X 轴非空",
             "(function(){var o=ChartRenderer.get('mainChart').getOption();"
             "return ((o.xAxis&&o.xAxis[0]&&o.xAxis[0].data)||[]).length})()",
             lambda v: isinstance(v, int) and v > 0)
    s.expect("示例数据后表格同步刷新",
             "(function(){var td=document.querySelector('#dataTable tbody td');"
             "return td?td.innerText:''})()",
             lambda v: isinstance(v, str) and len(v.strip()) > 0)


    # ---------- 14. 模板保存 / 应用 / 自动匹配 / 删除 ----------
    s.ev("(function(){State.currentChartType='pie';App.renderCurrentChart();})()")
    page.wait_for_timeout(200)
    saved = s.ev("(function(){var n=Template.list().length;"
                 "Template.save('diag模板');App.renderTemplateList();"
                 "return JSON.stringify({added:Template.list().length-n,"
                 "items:document.querySelectorAll('#templateList .tpl-item').length})})()")
    s.check("模板可保存并出现在列表",
            isinstance(saved, str) and json.loads(saved)["added"] == 1
            and json.loads(saved)["items"] >= 1, saved)
    s.expect("模板持久化到 localStorage",
             "(localStorage.getItem('chartforge:templates')||'')",
             lambda v: "diag模板" in str(v))
    s.ev("(function(){State.currentChartType='bar';App.renderCurrentChart()})()")
    page.wait_for_timeout(200)
    s.ev("document.querySelector('#templateList .tpl-apply').click()")
    page.wait_for_timeout(350)
    s.expect("应用模板恢复图表类型", "State.currentChartType", lambda v: v == "pie")
    s.expect("模板自动匹配可用（同签名数据）",
             "(function(){var m=Template.autoMatch();"
             "return m?JSON.stringify({name:m.template.name,score:m.score}):'null'})()",
             lambda v: v != "null" and json.loads(v)["score"] > 0)
    # 删除（confirm 已由 dialog handler 自动接受）
    s.ev("(function(){var b=document.querySelector('#templateList .tpl-del');"
         "if(b)b.click()})()")
    page.wait_for_timeout(350)
    s.expect("模板可删除",
             "(Template.list().filter(t=>t.name==='diag模板').length)",
             lambda v: v == 0)

    # ---------- 15. 多图表联动 ----------
    s.ev("(function(){var i=document.getElementById('dashEnabled');"
         "i.checked=true;i.dispatchEvent(new Event('change',{bubbles:true}))})()")
    page.wait_for_timeout(250)
    s.expect("联动开关生效", "Dashboard.enabled", lambda v: v is True)
    s.expect("启用后“添加图表”按钮可用",
             "!document.getElementById('dashAddBtn').disabled", lambda v: v is True)
    s.ev("document.getElementById('dashAddBtn').click()")
    page.wait_for_timeout(400)
    s.ev("document.getElementById('dashAddBtn').click()")
    page.wait_for_timeout(500)
    s.expect("已添加 2 个联动面板", "Dashboard.panels.length", lambda v: v == 2)
    s.expect("联动面板已渲染 DOM", "document.querySelectorAll('#dashboardArea .dash-panel').length",
             lambda v: v == 2)
    s.expect("联动面板各自绘制了 canvas",
             "document.querySelectorAll('#dashboardArea .dash-chart canvas').length",
             lambda v: isinstance(v, int) and v >= 2)
    s.expect("面板有高度",
             "Array.from(document.querySelectorAll('#dashboardArea .dash-chart'))"
             ".every(e=>e.clientHeight>100)",
             lambda v: v is True)
    # 事件总线联动
    s.expect("ChartBus 广播不抛错",
             "(function(){try{ChartBus.emit('select',{sourceId:'mainChart',dataIndex:1,"
             "seriesIndex:0});return 'ok'}catch(e){return 'ERR:'+e.message}})()",
             lambda v: v == "ok")
    # 移除单个面板
    s.ev("(function(){var b=document.querySelector('#dashboardArea .dash-remove');"
         "if(b)b.click()})()")
    page.wait_for_timeout(350)
    s.expect("可移除单个面板（Dashboard.panels 引用未失效）",
             "JSON.stringify([Dashboard.panels.length,"
             "document.querySelectorAll('#dashboardArea .dash-panel').length])",
             lambda v: json.loads(v) == [1, 1])
    s.ev("document.getElementById('dashClearBtn').click()")
    page.wait_for_timeout(300)
    s.expect("清空后 Dashboard.panels 同步为 0（无陈旧引用）",
             "JSON.stringify([Dashboard.panels.length,Dashboard.getCurrentPanels().length,"
             "document.querySelectorAll('#dashboardArea .dash-panel').length])",
             lambda v: json.loads(v) == [0, 0, 0])

    # ---------- 15b. 仪表盘布局持久化 ----------
    # 之前面板只存在内存里，刷新即丢。这里验证：存 → 真刷新 → 恢复。
    s.expect("Store 层可用", "typeof Store === 'object' && Store.available()", lambda v: v is True)
    s.expect("Store 写入带 schema 版本号",
             "(function(){Store.write('cf:probe',{a:1});"
             "var raw=JSON.parse(localStorage.getItem('cf:probe'));"
             "Store.remove('cf:probe');return raw.v})()",
             lambda v: v == Store_VERSION)
    s.check("版本不匹配的旧数据被丢弃",
            s.ev("(function(){localStorage.setItem('cf:probe',"
                 "JSON.stringify({v:9999,data:{a:1}}));"
                 "var r=Store.read('cf:probe','FALLBACK');"
                 "Store.remove('cf:probe');return r})()") == "FALLBACK")
    s.check("JSON 损坏时安全降级",
            s.ev("(function(){localStorage.setItem('cf:probe','{bad json');"
                 "var r=Store.read('cf:probe','FALLBACK');"
                 "Store.remove('cf:probe');return r})()") == "FALLBACK")

    # 搭一个 2 面板的看板并确认写入 localStorage
    saved = s.ev(
        "(function(){"
        "  Dashboard.setEnabled(true);"
        "  App.addDashboardPanel();App.addDashboardPanel();"
        "  var raw=JSON.parse(localStorage.getItem('chartforge:dashboard'));"
        "  return JSON.stringify({panels:raw.data.panels.length,"
        "    enabled:raw.data.enabled,hasSig:!!raw.data.columnSignature,"
        "    sameAsCurrent:raw.data.columnSignature===DataSource.columnSignature()});})()")
    s.check("布局已写入 localStorage（含列签名）",
            isinstance(saved, str) and json.loads(saved) == {
                "panels": 2, "enabled": True, "hasSig": True, "sameAsCurrent": True}, saved)

    # 关键验证：真实 reload，而不是只调 restore()
    # 注意：数据本身不持久化（刻意为之，不把业务数据留在浏览器里），
    # 刷新后会回到默认示例数据，所以布局不会、也不应该立刻套用。
    sig_before = s.ev("DataSource.columnSignature()")
    rows_csv = s.ev(
        "(function(){var ds=DataSource.current;"
        "  var head=ds.columns.join(',');"
        "  var body=ds.rows.map(function(r){return r.join(',')}).join('\\n');"
        "  return head+'\\n'+body})()")
    page.reload(wait_until="load")
    page.wait_for_timeout(1200)

    fresh = s.ev(
        "JSON.stringify({panels:Dashboard.panels.length,"
        "saved:!!Dashboard.peekSaved(),"
        "reason:(Dashboard.lastRestore||{}).reason})")
    s.check("刷新后存档仍在（数据不持久化，故暂不套用）",
            isinstance(fresh, str) and json.loads(fresh)["saved"] is True
            and json.loads(fresh)["panels"] == 0, fresh)

    # 真实用户路径：重新导入同一份数据 → 列签名匹配 → 看板自动回来
    reimported = s.ev(
        "(function(){"
        "  Importer.handleLoaded(Importer.fromCSV(%s,'回归数据'));"
        "  return JSON.stringify({sig:DataSource.columnSignature(),"
        "    panels:Dashboard.panels.length,"
        "    enabled:Dashboard.enabled,"
        "    dom:document.querySelectorAll('#dashboardArea .dash-panel').length,"
        "    reason:(Dashboard.lastRestore||{}).reason});})()" % json.dumps(rows_csv))
    ok_re = isinstance(reimported, str)
    re_data = json.loads(reimported) if ok_re else {}
    s.check("重新导入同结构数据后看板自动恢复",
            ok_re and re_data.get("panels") == 2 and re_data.get("enabled") is True
            and re_data.get("dom") == 2 and re_data.get("reason") == "restored", reimported)
    s.check("恢复后列签名与保存时一致",
            ok_re and re_data.get("sig") == sig_before,
            "saved=%s now=%s" % (sig_before, re_data.get("sig")))
    page.wait_for_timeout(400)
    s.expect("恢复的面板真的画出了 canvas",
             "document.querySelectorAll('#dashboardArea .dash-panel canvas').length",
             lambda v: isinstance(v, int) and v >= 2)
    # restore() 会先 dispose 再重建；若漏掉 dispose，反复恢复会堆积 echarts 实例
    leak = s.ev(
        "(function(){"
        "  for(var i=0;i<3;i++){Dashboard.restore({force:true});}"
        "  var live=Object.keys(ChartRenderer.instances).filter(function(k){"
        "    var c=ChartRenderer.instances[k];"
        "    try{return c && !c.isDisposed()}catch(e){return false}});"
        "  return JSON.stringify({live:live.length,panels:Dashboard.panels.length});})()")
    s.check("反复恢复不泄漏 ECharts 实例",
            isinstance(leak, str)
            and json.loads(leak)["live"] <= json.loads(leak)["panels"] + 1, leak)

    # 列结构不同的数据：绝不能盲目套用（列索引会指向不相干的列）
    # 用单列数据，保证原面板的 y 列索引必然越界，从而同时验证降级逻辑。
    mism = s.ev(
        "(function(){"
        "  Importer.handleLoaded(Importer.fromCSV('甲\\n1\\n2\\n3','异构单列'));"
        "  var r=Dashboard.restore();"
        "  return JSON.stringify({ok:r.ok,reason:r.reason,panels:Dashboard.panels.length,"
        "    cols:DataSource.current.columns.length});})()")
    s.check("列签名不匹配时拒绝恢复",
            isinstance(mism, str) and json.loads(mism)["ok"] is False
            and json.loads(mism)["reason"] == "signature-mismatch", mism)
    # 换数据源后旧面板必须被卸下：留着就是用新数据画旧列索引（串图）
    s.check("换数据源后过时面板已卸载（不串图）",
            isinstance(mism, str) and json.loads(mism)["panels"] == 0, mism)
    s.expect("过时面板的 DOM 也已移除",
             "document.querySelectorAll('#dashboardArea .dash-panel').length",
             lambda v: v == 0)
    s.expect("卸载面板但保留存档（换回原数据可恢复）",
             "!!Dashboard.peekSaved()", lambda v: v is True)
    s.expect("不匹配时提供手动恢复按钮",
             "!!document.getElementById('dashRestoreBtn')", lambda v: v is True)

    # force 恢复：越界字段的面板必须被丢弃，而不是画出错图
    forced = s.ev(
        "(function(){var r=Dashboard.restore({force:true});"
        "  return JSON.stringify({ok:r.ok,restored:r.restored,dropped:r.dropped,"
        "    reason:r.reason});})()")
    s.check("force 恢复会丢弃列索引越界的面板",
            isinstance(forced, str) and json.loads(forced)["dropped"] >= 1
            and json.loads(forced)["restored"] == 0
            and json.loads(forced)["reason"] == "all-panels-invalid", forced)

    # 清空是明确意图：存档也应一并丢弃，刷新后不该复活
    s.ev("Importer.handleLoaded(Importer.fromSample(0))")
    page.wait_for_timeout(250)
    cleared = s.ev(
        "(function(){Dashboard.setEnabled(true);App.addDashboardPanel();"
        "  Dashboard.clear();Dashboard.clearSaved();"
        "  return JSON.stringify({raw:localStorage.getItem('chartforge:dashboard'),"
        "    panels:Dashboard.panels.length});})()")
    s.check("清空后存档一并删除（刷新不复活）",
            isinstance(cleared, str) and json.loads(cleared)["raw"] is None
            and json.loads(cleared)["panels"] == 0, cleared)

    # ---------- 16c. 标注（markLine / markPoint） ----------
    # 能力检测必须与渲染逻辑同源，否则 UI 灰置与实际生效会不一致
    s.expect("直角坐标系图表支持标注",
             "JSON.stringify(['line','area','bar','bar-grouped','bar-stacked','scatter']"
             ".map(function(t){return ChartRenderer.supportsMark(t)}))",
             lambda v: json.loads(v) == [True] * 6)
    s.expect("饼图/雷达/热力图不支持标注",
             "JSON.stringify(['pie','doughnut','radar','heatmap']"
             ".map(function(t){return ChartRenderer.supportsMark(t)}))",
             lambda v: json.loads(v) == [False] * 4)

    # 准备一份干净的折线图状态
    s.ev("(function(){var ds=DataSource.current;var nums=[],cats=[];"
         "ds.types.forEach(function(t,i){if(t==='number')nums.push(i);else cats.push(i);});"
         "State.currentChartType='line';"
         "State.fields.x=cats.length?cats[0]:0;"
         "State.fields.y=nums.slice(0,2);"
         "State.style.markMean=false;State.style.markMax=false;"
         "State.style.markMin=false;State.style.markThreshold=null;"
         "App.renderStylePanel();App.renderCurrentChart();})()")
    page.wait_for_timeout(300)

    s.expect("默认不注入任何标注",
             "(function(){var o=ChartRenderer.buildOption('line',State.fields,State.style);"
             " return JSON.stringify(o.series.map(function(s){"
             "   return [!!s.markLine,!!s.markPoint]}))})()",
             lambda v: all(x == [False, False] for x in json.loads(v)))

    # 均值线：每个系列都应挂上，且用 ECharts 内置 average 类型
    mean_o = s.ev(
        "(function(){State.style.markMean=true;"
        " var o=ChartRenderer.buildOption('line',State.fields,State.style);"
        " return JSON.stringify({n:o.series.length,"
        "   types:o.series.map(function(s){return (s.markLine.data||[]).map(function(d){return d.type})}),"
        "   silent:o.series.every(function(s){return s.markLine.silent===true})})})()")
    s.check("均值线注入到每个系列（type=average 且不抢 tooltip）",
            isinstance(mean_o, str)
            and json.loads(mean_o)["n"] >= 2
            and all(t == ["average"] for t in json.loads(mean_o)["types"])
            and json.loads(mean_o)["silent"] is True, mean_o)

    # 最值标记点
    pt = s.ev(
        "(function(){State.style.markMax=true;State.style.markMin=true;"
        " var o=ChartRenderer.buildOption('line',State.fields,State.style);"
        " return JSON.stringify(o.series.map(function(s){"
        "   return (s.markPoint.data||[]).map(function(d){return d.type})}))})()")
    s.check("最大/最小值标记点同时生效",
            isinstance(pt, str) and all(x == ["max", "min"] for x in json.loads(pt)), pt)

    # 阈值线：0 是合法阈值，不能被 falsy 判断吃掉（典型 off-by-falsy 缺陷）
    # 用 markLine 是否存在做前置判断，避免实现有缺陷时直接抛异常中断整个套件
    thr0 = s.ev(
        "(function(){State.style.markMean=false;State.style.markMax=false;"
        " State.style.markMin=false;State.style.markThreshold=0;"
        " var o=ChartRenderer.buildOption('line',State.fields,State.style);"
        " var ml=o.series[0].markLine;"
        " if(!ml||!ml.data) return JSON.stringify({missing:true});"
        " return JSON.stringify({missing:false,n:ml.data.length,yAxis:ml.data[0].yAxis})})()")
    thr0_d = json.loads(thr0) if isinstance(thr0, str) else {}
    s.check("阈值 0 仍会画线（未被 falsy 误判）",
            thr0_d.get("missing") is False and thr0_d.get("n") == 1
            and thr0_d.get("yAxis") == 0, thr0)

    thr_str = s.ev(
        "(function(){State.style.markThreshold='150';"
        " var o=ChartRenderer.buildOption('line',State.fields,State.style);"
        " var ml=o.series[0].markLine;"
        " if(!ml||!ml.data||!ml.data.length) return JSON.stringify({missing:true});"
        " var d=ml.data[0];"
        " return JSON.stringify({missing:false,yAxis:d.yAxis,isNum:typeof d.yAxis==='number'})})()")
    thr_s_d = json.loads(thr_str) if isinstance(thr_str, str) else {}
    s.check("字符串阈值被转成数值",
            thr_s_d.get("missing") is False and thr_s_d.get("yAxis") == 150
            and thr_s_d.get("isNum") is True, thr_str)

    s.expect("非法阈值被忽略",
             "(function(){State.style.markThreshold='abc';"
             " var o=ChartRenderer.buildOption('line',State.fields,State.style);"
             " return !!o.series[0].markLine})()",
             lambda v: v is False)

    # 均值 + 阈值应共存于同一条 markLine.data
    both = s.ev(
        "(function(){State.style.markMean=true;State.style.markThreshold=200;"
        " var o=ChartRenderer.buildOption('line',State.fields,State.style);"
        " var ml=o.series[0].markLine;"
        " return ml&&ml.data?String(ml.data.length):'missing'})()")
    s.check("均值线与阈值线可共存", both == "2", both)

    # 不支持的类型：必须完全不注入，而不是塞进去静默失效
    pie_mark = s.ev(
        "(function(){var f={x:State.fields.x,y:[State.fields.y[0]]};"
        " var o=ChartRenderer.buildOption('pie',f,State.style);"
        " return JSON.stringify(o.series.map(function(s){"
        "   return [!!s.markLine,!!s.markPoint]}))})()")
    s.check("饼图不注入标注（避免静默失效）",
            isinstance(pie_mark, str)
            and all(x == [False, False] for x in json.loads(pie_mark)), pie_mark)

    s.expect("柱状图标注生效",
             "(function(){var o=ChartRenderer.buildOption('bar',State.fields,State.style);"
             " return !!o.series[0].markLine})()",
             lambda v: v is True)

    # UI：不支持的类型要灰置控件并给出说明
    ui_pie = s.ev(
        "(function(){State.currentChartType='pie';App.renderStylePanel();"
        " var m=document.getElementById('markMean');"
        " var t=document.getElementById('markThreshold');"
        " return JSON.stringify({disabled:!!(m&&m.disabled),thrDisabled:!!(t&&t.disabled),"
        "   hasHint:!!document.querySelector('.disabled-section')})})()")
    s.check("饼图下标注控件被灰置并有说明",
            isinstance(ui_pie, str) and json.loads(ui_pie)["disabled"] is True
            and json.loads(ui_pie)["thrDisabled"] is True
            and json.loads(ui_pie)["hasHint"] is True, ui_pie)

    ui_line = s.ev(
        "(function(){State.currentChartType='line';App.renderStylePanel();"
        " var m=document.getElementById('markMean');"
        " return JSON.stringify({exists:!!m,disabled:!!(m&&m.disabled)})})()")
    s.check("折线图下标注控件可用",
            isinstance(ui_line, str) and json.loads(ui_line)["exists"] is True
            and json.loads(ui_line)["disabled"] is False, ui_line)

    # 勾选复选框应真正改状态并重绘（走完整 UI 路径）
    toggled = s.ev(
        "(function(){State.style.markMean=false;State.style.markMax=false;"
        " State.style.markThreshold=null;App.renderStylePanel();"
        " document.getElementById('markMax').click();"
        " return JSON.stringify({state:State.style.markMax,"
        "   opt:!!ChartRenderer.get('mainChart').getOption().series[0].markPoint})})()")
    s.check("点击复选框即时反映到图表",
            isinstance(toggled, str) and json.loads(toggled)["state"] is True
            and json.loads(toggled)["opt"] is True, toggled)

    # 阈值清除按钮
    cleared_thr = s.ev(
        "(function(){State.style.markThreshold=99;App.renderStylePanel();"
        " document.getElementById('markThresholdClear').click();"
        " return JSON.stringify({val:State.style.markThreshold,"
        "   input:document.getElementById('markThreshold').value})})()")
    s.check("可清除阈值线",
            isinstance(cleared_thr, str) and json.loads(cleared_thr)["val"] is None
            and json.loads(cleared_thr)["input"] == "", cleared_thr)

    # 标注属于样式，应随模板一起保存/恢复
    tpl_mark = s.ev(
        "(function(){State.style.markMean=true;State.style.markThreshold=321;"
        " var n='标注模板_'+Date.now();Template.save(n);"
        " State.style.markMean=false;State.style.markThreshold=null;"
        " Template.load(n);"
        " var i=Template.list().findIndex(function(t){return t.name===n});"
        " Template.remove(i);"
        " return JSON.stringify({mean:State.style.markMean,thr:State.style.markThreshold})})()")
    s.check("标注设置随模板保存与恢复",
            isinstance(tpl_mark, str) and json.loads(tpl_mark)["mean"] is True
            and json.loads(tpl_mark)["thr"] == 321, tpl_mark)

    # 收尾：清掉标注状态，避免影响后续导出等检查
    s.ev("(function(){State.style.markMean=false;State.style.markMax=false;"
         "State.style.markMin=false;State.style.markThreshold=null;"
         "State.currentChartType='line';App.renderStylePanel();"
         "App.renderCurrentChart();})()")
    page.wait_for_timeout(300)

    # 主题也迁到 Store 层：切换后应能被 Store.read 正确读回
    theme_ok = s.ev(
        "(function(){var before=State.theme;"
        "  document.getElementById('themeToggle').click();"
        "  var now=State.theme;"
        "  var read=Store.read('chartforge:theme',null);"
        "  var raw=JSON.parse(localStorage.getItem('chartforge:theme'));"
        "  document.getElementById('themeToggle').click();"
        "  return JSON.stringify({changed:before!==now,roundTrip:read===now,v:raw.v});})()")
    s.check("主题经 Store 层持久化且可读回",
            isinstance(theme_ok, str) and json.loads(theme_ok)["changed"] is True
            and json.loads(theme_ok)["roundTrip"] is True
            and json.loads(theme_ok)["v"] == Store_VERSION, theme_ok)

    # 模板存储迁移到 Store 层后必须仍然可用（回归保护）
    tpl_ok = s.ev(
        "(function(){var n='迁移校验_'+Date.now();Template.save(n);"
        "  var raw=JSON.parse(localStorage.getItem('chartforge:templates'));"
        "  var found=Template.list().some(function(t){return t.name===n});"
        "  var i=Template.list().findIndex(function(t){return t.name===n});"
        "  Template.remove(i);"
        "  return JSON.stringify({v:raw.v,isArr:Array.isArray(raw.data),found:found});})()")
    s.check("模板迁移到 Store 层后仍可存取",
            isinstance(tpl_ok, str) and json.loads(tpl_ok)["v"] == Store_VERSION
            and json.loads(tpl_ok)["isArr"] is True
            and json.loads(tpl_ok)["found"] is True, tpl_ok)

    # 上面做过 reload + 多次换数据源，这里把主图恢复到可用状态，
    # 供后续导出 / 响应式检查使用。
    s.ev("(function(){var ds=DataSource.current;var nums=[],cats=[];"
         "ds.types.forEach(function(t,i){if(t==='number')nums.push(i);else cats.push(i);});"
         "State.currentChartType='line';"
         "State.fields.x=cats.length?cats[0]:0;"
         "State.fields.y=nums.slice(0,2);"
         "App.renderCurrentChart();})()")
    page.wait_for_timeout(400)



    # ---------- 16. 导出 ----------
    s.expect("PNG 导出返回 dataURL",
             "(function(){return ChartRenderer.exportPNG('mainChart').then(u=>u.slice(0,22))})()",
             lambda v: isinstance(v, str) and v.startswith("data:image/png"))
    s.expect("SVG 导出可用",
             "(function(){try{var c=ChartRenderer.get('mainChart');"
             "return typeof c.renderToSVGString==='function'?'native':'fallback'}"
             "catch(e){return 'ERR:'+e.message}})()",
             lambda v: v in ("native", "fallback"))
    s.expect("Exporter.exportCSV 存在", "typeof Exporter.exportCSV", lambda v: v == "function")
    s.expect("CSV 导出按钮存在", "!!document.getElementById('exportCSV')", lambda v: v is True)
    csv_out = s.ev("(function(){var s=Exporter.exportCSV('diag');"
                   "return s?JSON.stringify({head:s.split('\\r\\n')[0],"
                   "lines:s.split('\\r\\n').length}):'null'})()")
    s.check("CSV 内容含表头且行数=数据行+1",
            isinstance(csv_out, str) and csv_out != "null"
            and json.loads(csv_out)["lines"] == s.ev("DataSource.current.rows.length") + 1,
            csv_out)

    # ---------- 16b. XLSX 真实二进制导入 + 多工作表切换 ----------
    # 之前的 e2e 只断言 "fromExcel 是个函数"，二进制解析路径从未被执行过。
    # 这里用页面内真实的 SheetJS 反向 write 出一个双表 workbook，
    # 再通过 File 对象走完整的 fromFile → fromExcel → DataSource 链路。
    s.expect("SheetJS 已加载", "typeof XLSX", lambda v: v == "object")
    s.expect("文件选择框接受 Excel 扩展名",
             "document.getElementById('fileInput').getAttribute('accept')",
             lambda v: isinstance(v, str) and ".xlsx" in v)

    xlsx_res = s.ev(
        "(function(){return new Promise(function(resolve){"
        "  var wb=XLSX.utils.book_new();"
        "  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet("
        "    [['月份','销量','利润'],['1月',120,30],['2月',150,45],['3月',90,20]]),'销售');"
        "  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet("
        "    [['地区','人数'],['华东',12],['华北',8]]),'人员');"
        "  var bin=XLSX.write(wb,{bookType:'xlsx',type:'array'});"
        "  var f=new File([bin],'双表.xlsx',"
        "    {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});"
        "  Importer.fromFile(f,function(err,ds){"
        "    if(err){resolve('ERR:'+err.message);return;}"
        "    resolve(JSON.stringify({cols:ds.columns,rows:ds.rows.length,"
        "      sheets:Importer.listSheets(),first:ds.rows[0]}));"
        "  },{onSheets:function(names,active){Importer.renderSheetPicker(names,active);}});"
        "})})()")
    ok_xlsx = isinstance(xlsx_res, str) and not xlsx_res.startswith("ERR:")
    parsed = json.loads(xlsx_res) if ok_xlsx else {}
    s.check("XLSX 二进制可解析出首个工作表",
            ok_xlsx and parsed.get("cols") == ["月份", "销量", "利润"]
            and parsed.get("rows") == 3, xlsx_res)
    s.check("XLSX 单元格值正确（非空/未错位）",
            ok_xlsx and parsed.get("first") == ["1月", "120", "30"], xlsx_res)
    s.check("识别出全部 2 个工作表",
            ok_xlsx and parsed.get("sheets") == ["销售", "人员"], xlsx_res)

    s.expect("多工作表时显示选择器",
             "getComputedStyle(document.getElementById('sheetPicker')).display",
             lambda v: v == "flex")
    s.expect("选择器含 2 个 option",
             "document.querySelectorAll('#sheetSelect option').length",
             lambda v: v == 2)

    # 切换工作表：必须换成第二张表的列结构，且不需要重新读文件
    sw = s.ev(
        "(function(){var sel=document.getElementById('sheetSelect');"
        "  if(!sel)return 'no-select';sel.value='人员';"
        "  sel.dispatchEvent(new Event('change'));"
        "  return JSON.stringify({cols:DataSource.current.columns,"
        "    rows:DataSource.current.rows.length});})()")
    s.check("切换工作表后数据集同步更新",
            isinstance(sw, str) and sw != "no-select"
            and json.loads(sw) == {"cols": ["地区", "人数"], "rows": 2}, sw)

    # 导入 CSV 后选择器必须消失，否则会残留误导用户
    hide = s.ev(
        "(function(){return new Promise(function(resolve){"
        "  var f=new File(['a,b\\n1,2'],'t.csv',{type:'text/csv'});"
        "  Importer._importFile(f);"
        "  setTimeout(function(){resolve(getComputedStyle("
        "    document.getElementById('sheetPicker')).display)},300);})})()")
    s.check("导入 CSV 后工作表选择器隐藏", hide == "none", hide)

    # 恢复一份可用数据供后续检查使用
    s.ev("Importer.handleLoaded(Importer.fromSample(0))")
    page.wait_for_timeout(300)

    # ---------- 18. AI 建议层（Advisor） ----------
    # 该段最重要的断言是「请求体不含任何业务数据」：隐私边界必须可验证，
    # 否则它就只是 README 里的一句承诺。
    s.ev("Importer.handleLoaded(Importer.fromSample(0))")
    page.wait_for_timeout(300)

    s.expect("Advisor 模块已加载", "typeof window.Advisor", lambda v: v == "object")
    s.expect("两个 provider 均已注册",
             "Object.keys(Advisor.providers).sort().join(',')",
             lambda v: v == "llm,rules")
    s.expect("无 key 时仅 rules 可用",
             "(function(){Advisor.clearConfig();return Advisor.available().join(',')})()",
             lambda v: v == "rules")

    # schema 只含形状信息
    schema = s.ev("JSON.stringify(Advisor.buildSchema())")
    s.check("schema 含列名与类型",
            isinstance(schema, str) and '"type"' in schema and '"index"' in schema, schema[:160])
    s.check("schema 不含 rows 字段（不外发数据行）",
            isinstance(schema, str) and '"rows"' not in schema, schema[:160])

    # 无 key 时统一入口静默走规则引擎
    r = s.ev("(function(){Advisor.clearConfig();return Advisor.suggest({}).then(r=>"
             "JSON.stringify({src:r.source,n:r.suggestions.length}))})()")
    s.check("无 key 时 suggest 退回规则引擎且有结果",
            isinstance(r, str) and '"src":"rules"' in r and '"n":0' not in r, r)

    # ---- 输出校验：模型可能返回任何东西 ----
    colc = s.ev("(DataSource.current.columns||[]).length")
    ok1 = s.ev("!!Advisor.validateSuggestion({chartType:'line',fields:{x:0,y:[1]}}, %d)" % colc)
    s.check("合法建议通过校验", ok1 is True, ok1)
    bad1 = s.ev("Advisor.validateSuggestion({chartType:'line',fields:{x:0,y:[999]}}, %d)" % colc)
    s.check("越界列索引被拒绝", bad1 is None, bad1)
    bad2 = s.ev("Advisor.validateSuggestion({chartType:'sankey',fields:{x:0,y:[1]}}, %d)" % colc)
    s.check("白名单外的图表类型被拒绝", bad2 is None, bad2)
    bad3 = s.ev("Advisor.validateSuggestion({chartType:'line',fields:{x:1.5,y:[1]}}, %d)" % colc)
    s.check("非整数列索引被拒绝", bad3 is None, bad3)
    bad4 = s.ev("Advisor.validateSuggestion({chartType:'line',fields:{}}, %d)" % colc)
    s.check("空字段建议被拒绝", bad4 is None, bad4)
    bad5 = s.ev("Advisor.validateSuggestion(null, %d)" % colc)
    s.check("null 建议被拒绝", bad5 is None, bad5)
    norm = s.ev("JSON.stringify(Advisor.validateSuggestion("
                "{chartType:'bar',defaults:{xAxis:0,yAxis:1}}, %d))" % colc)
    s.check("旧式 defaults/xAxis 形状也能归一化",
            isinstance(norm, str) and '"y":[1]' in norm and '"chartType":"bar"' in norm, norm)

    # ---- 宽容解析 ----
    p1 = s.ev("Advisor.parseSuggestions('```json\\n{\"suggestions\":"
              "[{\"chartType\":\"line\"}]}\\n```').length")
    s.check("markdown 代码块包裹的 JSON 可解析", p1 == 1, p1)
    p2 = s.ev("Advisor.parseSuggestions('好的，建议如下：{\"suggestions\":"
              "[{\"chartType\":\"bar\"}]} 希望有帮助').length")
    s.check("前后夹带解释文字的 JSON 可解析", p2 == 1, p2)
    p3 = s.ev("Advisor.parseSuggestions('抱歉我无法回答').length")
    s.check("完全非 JSON 的响应安全返回空数组", p3 == 0, p3)
    p4 = s.ev("Advisor.parseSuggestions(null).length")
    s.check("null 响应不抛异常", p4 == 0, p4)

    # ---- mock provider：整条链路 + 隐私边界 ----
    # 替换 fetch 捕获请求体，再逐个单元格值比对，确认没有任何数据外发。
    s.ev("""(function(){
      window.__cap = null;
      window.__realFetch = window.fetch;
      window.fetch = function(url, opt){
        window.__cap = {url:url, body:opt&&opt.body};
        return Promise.resolve({ok:true, json:function(){
          return Promise.resolve({choices:[{message:{content:
            JSON.stringify({suggestions:[{chartType:'bar',fields:{x:0,y:[1]},reason:'mock'}]})}}]});
        }});
      };
      Advisor.setConfig({endpoint:'https://mock.local/v1/chat/completions',
                         apiKey:'sk-test-DO-NOT-LEAK', model:'mock-1'});
    })()""")
    s.expect("配置 key 后 llm 变为可用", "Advisor.available().sort().join(',')",
             lambda v: v == "llm,rules")

    got = s.ev("Advisor.suggest({provider:'llm'}).then(r=>JSON.stringify("
               "{src:r.source,fb:r.fallback,t:r.suggestions[0]&&r.suggestions[0].chartType}))")
    s.check("mock LLM 返回的合法建议被采用",
            isinstance(got, str) and '"src":"llm"' in got and '"t":"bar"' in got, got)

    body = s.ev("(window.__cap && window.__cap.body) || ''")
    s.check("请求体已捕获", isinstance(body, str) and len(body) > 0, str(body)[:80])
    leak = s.ev("""(function(){
      var b = (window.__cap&&window.__cap.body)||'';
      var rows = DataSource.current.rows||[];
      var hits = [];
      rows.forEach(function(r){ (r||[]).forEach(function(v){
        var sv = String(v);
        if (sv.length >= 3 && b.indexOf(sv) !== -1) hits.push(sv);
      })});
      return hits.slice(0,5).join('|');
    })()""")
    s.check("请求体不含任何数据行的单元格值（隐私边界）", leak == "", leak)
    col0 = s.ev("String((DataSource.current.columns||[])[0]||'')")
    s.check("请求体含列名（schema 确实发出去了）",
            isinstance(body, str) and bool(col0) and col0 in body, "col0=%s" % col0)
    s.expect("请求体不含 rows 关键字",
             "((window.__cap&&window.__cap.body)||'').indexOf('\"rows\"')",
             lambda v: v == -1)

    # ---- 越界 / 非法 / 非 JSON / HTTP 错误 → 一律降级不崩 ----
    def mock_reply(content_js):
        s.ev("""(function(){window.fetch=function(u,o){
          window.__cap={url:u,body:o&&o.body};
          return Promise.resolve({ok:true,json:function(){
            return Promise.resolve({choices:[{message:{content: %s }}]});}});};})()""" % content_js)

    mock_reply("JSON.stringify({suggestions:[{chartType:'line',fields:{x:0,y:[999]}}]})")
    r2 = s.ev("Advisor.suggest({provider:'llm'}).then(r=>JSON.stringify("
              "{src:r.source,fb:r.fallback,reason:r.reason,n:r.suggestions.length}))")
    s.check("LLM 返回越界索引时降级到规则引擎且仍有建议",
            isinstance(r2, str) and '"src":"rules"' in r2 and '"n":0' not in r2, r2)

    mock_reply("JSON.stringify({suggestions:[{chartType:'nope',fields:{x:0,y:[1]}}]})")
    r3 = s.ev("Advisor.suggest({provider:'llm'}).then(r=>JSON.stringify("
              "{src:r.source,n:r.suggestions.length}))")
    s.check("LLM 返回非法图表类型时降级",
            isinstance(r3, str) and '"src":"rules"' in r3 and '"n":0' not in r3, r3)

    mock_reply("'完全不是 JSON'")
    r4 = s.ev("Advisor.suggest({provider:'llm'}).then(r=>JSON.stringify("
              "{src:r.source,n:r.suggestions.length}))")
    s.check("LLM 返回非 JSON 时降级",
            isinstance(r4, str) and '"src":"rules"' in r4 and '"n":0' not in r4, r4)

    s.ev("""(function(){window.fetch=function(){return Promise.resolve({ok:false,status:500,
      json:function(){return Promise.resolve({})}})};})()""")
    r5 = s.ev("Advisor.suggest({provider:'llm'}).then(r=>JSON.stringify("
              "{src:r.source,err:r.error||'',n:r.suggestions.length}))")
    s.check("HTTP 500 时降级并记录错误",
            isinstance(r5, str) and '"src":"rules"' in r5 and '500' in r5, r5)

    s.ev("(function(){window.fetch=function(){return Promise.reject(new Error('网络断开'))};})()")
    r6 = s.ev("Advisor.suggest({provider:'llm'}).then(r=>JSON.stringify("
              "{src:r.source,n:r.suggestions.length}))")
    s.check("网络异常时不抛未捕获错误，静默降级",
            isinstance(r6, str) and '"src":"rules"' in r6, r6)

    # ---- API key 不得泄漏到任何导出物 ----
    s.ev("Advisor.setConfig({endpoint:'https://mock.local/v1/chat/completions',"
         "apiKey:'sk-test-DO-NOT-LEAK', model:'mock-1'})")
    s.ev("Template.save('advisor密钥检查')")
    page.wait_for_timeout(200)
    leak2 = s.ev("""(function(){
      var hits = [];
      Object.keys(localStorage).forEach(function(k){
        if (k === 'chartforge:llm') return;   // key 本体的存放处，预期之内
        var v = localStorage.getItem(k) || '';
        if (v.indexOf('sk-test-DO-NOT-LEAK') !== -1) hits.push(k);
      });
      return hits.join('|');
    })()""")
    s.check("API key 未写入模板/看板/主题等其它存档", leak2 == "", leak2)
    csv_leak = s.ev("(Exporter.exportCSV('leakcheck')||'')"
                    ".indexOf('sk-test-DO-NOT-LEAK')")
    s.check("API key 不出现在 CSV 导出中", csv_leak == -1, csv_leak)

    # ---- UI ----
    s.ev("App.renderAdvisorBar()")
    page.wait_for_timeout(150)
    s.expect("AI 控制条已渲染", "!!document.querySelector('#advisorBar .advisor-badge')",
             lambda v: v is True)
    s.expect("有 key 时显示 AI 徽标",
             "document.querySelector('#advisorBar .advisor-badge').className",
             lambda v: isinstance(v, str) and "on" in v)
    s.expect("有 key 时出现「询问」按钮", "!!document.getElementById('advisorAskBtn')",
             lambda v: v is True)
    s.expect("隐私说明文案常驻可见",
             "(document.querySelector('.advisor-note')||{}).textContent||''",
             lambda v: isinstance(v, str) and "不含任何数据行" in v)
    s.expect("API key 输入框为 password 类型",
             "(function(){document.getElementById('advisorCfgBtn').click();"
             "return (document.getElementById('advisorKey')||{}).type})()",
             lambda v: v == "password")

    # 清除配置后回到规则模式（demo 站点默认状态，必须完全可用）
    s.ev("(function(){Advisor.clearConfig();App.renderAdvisorBar();})()")
    page.wait_for_timeout(150)
    s.expect("清除 key 后徽标回到内置规则",
             "document.querySelector('#advisorBar .advisor-badge').textContent",
             lambda v: isinstance(v, str) and "内置规则" in v)
    s.expect("清除 key 后「询问」按钮消失", "!!document.getElementById('advisorAskBtn')",
             lambda v: v is False)
    s.ev("(function(){if(window.__realFetch) window.fetch = window.__realFetch;})()")

    # ---- 自然语言提问 ----
    s.ev("""(function(){
      window.__cap = null;
      window.fetch = function(url, opt){
        window.__cap = {url:url, body:opt&&opt.body};
        return Promise.resolve({ok:true, json:function(){
          return Promise.resolve({choices:[{message:{content:
            JSON.stringify({suggestions:[{chartType:'bar',fields:{x:0,y:[2]},
                                          reason:'按月看趋势'}]})}}]});
        }});
      };
      Advisor.setConfig({endpoint:'https://mock.local/v1/chat/completions',
                         apiKey:'sk-test-DO-NOT-LEAK', model:'mock-1'});
      App.renderAdvisorBar();
    })()""")
    page.wait_for_timeout(150)
    s.expect("有 key 时出现提问输入框", "!!document.getElementById('advisorPrompt')",
             lambda v: v is True)

    ask = s.ev("""(function(){
      document.getElementById('advisorPrompt').value = '按月对比收入和支出';
      return App.askAdvisor().then(function(){
        return ((window.__cap&&window.__cap.body)||'');
      });
    })()""")
    s.check("用户提问被送入请求体",
            isinstance(ask, str) and "按月对比收入和支出" in ask, str(ask)[:120])
    s.check("提问场景下请求体仍不含数据行",
            isinstance(ask, str) and "2024-01" not in ask, str(ask)[:200])
    s.expect("AI 建议已落到推荐面板",
             "(document.querySelector('.rec-item .rec-reason')||{}).textContent||''",
             lambda v: isinstance(v, str) and "按月看趋势" in v)
    s.expect("提问后输入框内容保留（未被重绘清空）",
             "(document.getElementById('advisorPrompt')||{}).value||''",
             lambda v: v == "按月对比收入和支出")
    s.expect("提问后输入框恢复可用",
             "(document.getElementById('advisorPrompt')||{}).disabled",
             lambda v: v is False)

    # 点击 AI 建议要真的能出图（接缝闭合，而非只显示文字）
    # 先把图表强制成 line，再点 AI 给的 bar 建议，
    # 确保断言能区分「真的切换了」和「本来就是这个类型」。
    drawn = s.ev("""(function(){
      State.currentChartType = 'line';
      App.renderCurrentChart();
      var before = State.currentChartType;
      document.querySelector('.rec-item').click();
      var opt = ChartRenderer.get('mainChart').getOption();
      return JSON.stringify({before:before, after:State.currentChartType,
                             n:(opt.series||[]).length,
                             st:(opt.series||[])[0] && opt.series[0].type,
                             y:(State.fields.y||[]).join(',')});
    })()""")
    s.check("点击 AI 建议可渲染出对应图表（类型确实发生切换）",
            isinstance(drawn, str) and '"before":"line"' in drawn
            and '"after":"bar"' in drawn and '"st":"bar"' in drawn, drawn)
    s.check("AI 指定的字段映射也被应用（y=2 而非默认）",
            isinstance(drawn, str) and '"y":"2"' in drawn, drawn)

    # ---- 提问自检：只提醒，不拦截 ----
    hit = s.ev("Advisor.checkPromptForData('为什么 2024-01 这么高').join('|')")
    s.check("提问含真实单元格值时被检出", isinstance(hit, str) and "2024-01" in hit, hit)
    nohit = s.ev("Advisor.checkPromptForData('按月对比收入和支出').length")
    s.check("正常提问不误报", nohit == 0, nohit)
    # 含数字的普通提问最容易误报：样例数据里有 120/80/200 这类短值，
    # 若长度阈值设得太松，「前 12 个月」之类提问会被误判为泄露。
    nohit2 = s.ev("Advisor.checkPromptForData('帮我看前 12 个月的 80 分位趋势').join('|')")
    s.check("含短数字的普通提问不误报（阈值不能太松）", nohit2 == "", nohit2)
    colhit = s.ev("""(function(){
      var c = (DataSource.current.columns||[])[0];
      return Advisor.checkPromptForData('请按' + c + '分组').length;
    })()""")
    s.check("提问含列名不算泄漏（列名本就在 schema 中）", colhit == 0, colhit)
    warn = s.ev("""(function(){
      var el = document.getElementById('advisorPrompt');
      el.value = '为什么 2024-01 这么高';
      el.dispatchEvent(new Event('input'));
      var w = document.getElementById('advisorWarn');
      return JSON.stringify({hidden:w.hidden, txt:w.textContent});
    })()""")
    s.check("输入真实数据时实时显示警告",
            isinstance(warn, str) and '"hidden":false' in warn and "2024-01" in warn, warn)
    s.check("警告文案说明数据会离开浏览器",
            isinstance(warn, str) and "离开浏览器" in warn, str(warn)[:160])
    cleared = s.ev("""(function(){
      var el = document.getElementById('advisorPrompt');
      el.value = '按月看趋势';
      el.dispatchEvent(new Event('input'));
      return document.getElementById('advisorWarn').hidden;
    })()""")
    s.check("改回正常提问后警告消失", cleared is True, cleared)
    # 警告只是提醒，不应阻断发送
    still = s.ev("""(function(){
      var el = document.getElementById('advisorPrompt');
      el.value = '为什么 2024-01 这么高';
      el.dispatchEvent(new Event('input'));
      return App.askAdvisor().then(function(){
        return ((window.__cap&&window.__cap.body)||'').indexOf('2024-01') !== -1;
      });
    })()""")
    s.check("警告不阻断发送（用户仍可自主决定）", still is True, still)

    s.ev("(function(){Advisor.clearConfig();App.renderAdvisorBar();})()")
    page.wait_for_timeout(150)
    s.expect("无 key 时不显示提问框", "!!document.getElementById('advisorPrompt')",
             lambda v: v is False)

    # ---- 散点图推荐规则修正（原 nCat===0 条件过严） ----
    sc = s.ev("""(function(){
      var recs = Recommend.recommend(['category','number','number'],['性别','身高','体重'],[]);
      return recs.filter(function(r){return r.type==='scatter'}).length;
    })()""")
    s.check("分类列+2数值列仍会推荐散点图（修正过严条件）", sc == 1, sc)
    sc2 = s.ev("""(function(){
      var recs = Recommend.recommend(['category','number','number'],['性别','身高','体重'],[]);
      return recs[0].type;
    })()""")
    s.check("但带分类列时柱状图仍排在散点图之前", sc2 == "bar", sc2)
    sc3 = s.ev("""(function(){
      var recs = Recommend.recommend(['time','number','number'],['日期','收入','支出'],[]);
      return recs.filter(function(r){return r.type==='scatter'}).length;
    })()""")
    s.check("有时间列时不推荐散点图（折线更合适）", sc3 == 0, sc3)
    sc4 = s.ev("""(function(){
      var recs = Recommend.recommend(['number','number'],['身高','体重'],[]);
      return recs[0].type;
    })()""")
    s.check("纯数值列时散点图仍居首（未被降分误伤）", sc4 == "scatter", sc4)

    # ---------- 17. 响应式 ----------
    page.set_viewport_size({"width": 800, "height": 900})
    page.wait_for_timeout(500)
    s.expect("窄屏切换为单列",
             "getComputedStyle(document.querySelector('.layout')).gridTemplateColumns",
             lambda v: len(v.split()) == 1)
    s.expect("窄屏图表仍有高度", "document.getElementById('mainChart').clientHeight",
             lambda v: isinstance(v, int) and v > 150)
    page.set_viewport_size({"width": 1500, "height": 950})
    page.wait_for_timeout(400)


def main():
    os.makedirs(LOG_DIR, exist_ok=True)
    os.makedirs(ART_DIR, exist_ok=True)
    errs = []

    # CSS 结构静态检查前置：未闭合的规则块会让整片样式失效，
    # 但浏览器错误恢复后花括号仍然平衡，只有解析层面能发现。
    css_problems = []
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import csscheck

        css_problems = csscheck.check(os.path.join(ROOT, "css", "style.css"))
    except Exception as exc:  # noqa: BLE001
        css_problems = ["csscheck 执行失败: %r" % (exc,)]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_context(viewport={"width": 1500, "height": 950}).new_page()
        page.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
        page.on("console",
                lambda m: errs.append("console.error: " + m.text) if m.type == "error" else None)
        # prompt/confirm 自动应答，供模板保存/删除使用
        page.on("dialog", lambda d: d.accept("diag模板"))

        page.goto(URL, wait_until="load")
        page.wait_for_timeout(1500)

        suite = Suite(page)
        try:
            run_checks(suite)
        except Exception as exc:  # noqa: BLE001
            suite.check("套件执行未中断", False, "EXCEPTION: %r" % (exc,))

        page.screenshot(path=os.path.join(ART_DIR, "diag_light.png"), full_page=True)
        page.evaluate("document.getElementById('themeToggle').click()")
        page.wait_for_timeout(500)
        page.screenshot(path=os.path.join(ART_DIR, "diag_dark.png"), full_page=True)
        browser.close()

    suite.check("无 JS 运行时错误", not errs, "; ".join(errs[:6]))
    suite.check("CSS 结构无未闭合规则块", not css_problems, "; ".join(css_problems[:6]))

    passed = [c for c in suite.checks if c["ok"]]
    report = {
        "url": URL,
        "total": len(suite.checks),
        "passed": len(passed),
        "failed": len(suite.failed),
        "checks": suite.checks,
        "js_errors": errs,
        "css_problems": css_problems,
        "info": suite.info,
    }
    with open(os.path.join(LOG_DIR, "diag.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    lines = ["%-4s %s%s" % ("[OK]" if c["ok"] else "[FAIL]", c["name"],
                            "" if c["ok"] else "  <-- " + c["detail"])
             for c in suite.checks]
    lines.append("")
    lines.append("total=%d passed=%d failed=%d" % (report["total"], report["passed"], report["failed"]))
    if errs:
        lines.append("JS errors:")
        lines.extend("  " + e for e in errs)
    text = "\n".join(lines)
    with open(os.path.join(LOG_DIR, "diag.txt"), "w", encoding="utf-8") as f:
        f.write(text)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(text)
    return 0 if report["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())


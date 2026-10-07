# -*- coding: utf-8 -*-
"""把 tools/logs/diag.json 汇总成人类可读的 tools/logs/report.txt。

本环境下内联 `python -c` 的长输出会丢失，所有证据都必须先落盘再读取，
因此这里始终写文件（而不只是打印）。

用法: python tools/report.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_DIR = os.path.join(ROOT, "tools", "logs")
SRC = os.path.join(LOG_DIR, "diag.json")
DST = os.path.join(LOG_DIR, "report.txt")

# 关注的关键词：本轮修复集中在样式 / CSS / Toast / 几何
KEYWORDS = ("样式", "CSS", "Toast", "布局", "撑开", "规则", "遮挡", "视口")


def build(rep):
    out = []
    add = out.append
    add("ChartForge 诊断汇总")
    add("=" * 60)
    add("url    : %s" % rep.get("url"))
    add("total  : %s" % rep.get("total"))
    add("passed : %s" % rep.get("passed"))
    add("failed : %s" % rep.get("failed"))
    add("")

    checks = rep.get("checks", [])

    add("-- 失败项 --")
    fails = [c for c in checks if not c.get("ok")]
    if fails:
        for c in fails:
            add("[FAIL] %s" % c["name"])
            add("       detail: %s" % c.get("detail", ""))
    else:
        add("(无)")
    add("")

    add("-- JS 运行时错误 (%d) --" % len(rep.get("js_errors") or []))
    for e in (rep.get("js_errors") or []) or ["(无)"]:
        add("  %s" % e)
    add("")

    add("-- CSS 结构问题 (%d) --" % len(rep.get("css_problems") or []))
    for e in (rep.get("css_problems") or []) or ["(无)"]:
        add("  %s" % e)
    add("")

    add("-- 样式 / CSS / Toast 相关检查 --")
    hit = [c for c in checks if any(k in c["name"] for k in KEYWORDS)]
    for c in hit:
        add("%-6s %s" % ("[OK]" if c["ok"] else "[FAIL]", c["name"]))
        add("       => %s" % c.get("detail", ""))
    add("(共 %d 项，其中失败 %d 项)" % (len(hit), len([c for c in hit if not c["ok"]])))
    add("")

    geom = (rep.get("info") or {}).get("geometry")
    if geom:
        add("-- 关键元素几何 (getBoundingClientRect) --")
        add("viewport: %s" % (geom.get("viewport"),))
        for sel, box in (geom.get("rects") or {}).items():
            add("  %-20s %s" % (sel, box))
        add("重叠面积(px^2，0 表示不重叠):")
        for k, v in (geom.get("overlap") or {}).items():
            add("  %-22s %s" % (k, v))
        add("")

    add("=" * 60)
    add("结论: %s" % ("全部通过" if not fails and not (rep.get("js_errors") or [])
                      and not (rep.get("css_problems") or []) else "存在失败项，见上"))
    return "\n".join(out)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    if not os.path.exists(SRC):
        msg = "找不到 %s，请先运行 python tools/diag.py" % SRC
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(DST, "w", encoding="utf-8") as f:
            f.write(msg + "\n")
        print(msg)
        return 2
    with open(SRC, encoding="utf-8") as f:
        rep = json.load(f)
    text = build(rep)
    with open(DST, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    print(text)
    return 0 if rep.get("failed") == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

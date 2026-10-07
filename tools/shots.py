"""生成 README 用截图（正式资产，输出到 docs/）。

与 diag.py 的临时截图分开：这些图会随仓库发布，需要固定构图与
可控的界面状态（例如展示 AI 控制条时必须先配好 mock key）。
"""
import io
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
URL = "http://127.0.0.1:8131/index.html"

from playwright.sync_api import sync_playwright


def main():
    os.makedirs(DOCS, exist_ok=True)
    srv = subprocess.Popen(
        [sys.executable, "-m", "http.server", "8131"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True, args=["--no-sandbox"])
            pg = b.new_context(viewport={"width": 1440, "height": 900},
                               device_scale_factor=2).new_page()
            pg.goto(URL, wait_until="load")
            pg.wait_for_timeout(1800)
            # 等启动 toast（“已加载…”/“已就绪”）自然消失，否则会遮住数据预览区
            for _ in range(20):
                if pg.evaluate("document.querySelectorAll('.toast').length") == 0:
                    break
                pg.wait_for_timeout(500)
            pg.wait_for_timeout(300)

            # 1) 主界面（亮色）
            pg.screenshot(path=os.path.join(DOCS, "screenshot-light.png"))

            # 2) 暗色
            pg.evaluate("document.getElementById('themeToggle').click()")
            pg.wait_for_timeout(700)
            pg.screenshot(path=os.path.join(DOCS, "screenshot-dark.png"))

            # 3) AI 控制条：配一个假 key 让面板进入「已启用」形态，
            #    并把提问框填成会触发隐私警告的内容 —— 这正是要展示的重点。
            pg.evaluate("document.getElementById('themeToggle').click()")
            pg.wait_for_timeout(600)
            pg.evaluate("""(function(){
              Advisor.setConfig({endpoint:'https://api.example.com/v1/chat/completions',
                                 apiKey:'sk-demo-placeholder', model:'gpt-4o-mini'});
              App.renderAdvisorBar();
            })()""")
            pg.wait_for_timeout(400)
            pg.evaluate("""(function(){
              var el = document.getElementById('advisorPrompt');
              el.value = '为什么 2024-01 的销售这么低';
              el.dispatchEvent(new Event('input'));
            })()""")
            pg.wait_for_timeout(400)
            card = pg.query_selector("#advisorBar")
            if card:
                sec = card.evaluate_handle("el => el.closest('section')").as_element()
                (sec or card).screenshot(path=os.path.join(DOCS, "screenshot-ai.png"))
            # 收尾：清掉假 key，避免留在 localStorage 里
            pg.evaluate("Advisor.clearConfig()")
            b.close()
    finally:
        srv.terminate()

    for n in ("screenshot-light.png", "screenshot-dark.png", "screenshot-ai.png"):
        f = os.path.join(DOCS, n)
        print("%-24s %s" % (n, ("%d KB" % (os.path.getsize(f) // 1024))
                            if os.path.exists(f) else "MISSING"))


if __name__ == "__main__":
    sys.exit(main())

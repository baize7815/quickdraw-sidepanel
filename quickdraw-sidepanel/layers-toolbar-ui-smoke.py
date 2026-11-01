"""Chromium regression for always-accessible layers panel shortcut.
Usage: python quickdraw-sidepanel/layers-toolbar-ui-smoke.py
"""
import http.server
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(
    ("127.0.0.1", 0),
    lambda *args, **kw: Quiet(*args, directory=str(ROOT), **kw),
)
threading.Thread(target=server.serve_forever, daemon=True).start()

try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            headless=True,
        )
        try:
            for width in (960, 360):
                context = browser.new_context(viewport={"width": width, "height": 760})
                context.add_init_script("""() => {
                  window.chrome = {
                    runtime:{id:'layers-test',getURL:p=>location.origin+'/'+p,
                             onMessage:{addListener(){}},
                             getManifest:()=>({version:'3.9.10'})},
                    windows:{getCurrent:async()=>({id:1})},
                    permissions:{contains:async()=>false},
                    tabs:{query:async()=>[],get:async()=>({}),create:async()=>({id:1})},
                    storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}},
                             onChanged:{addListener(){}}}
                  };
                }""")
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(f"http://127.0.0.1:{server.server_port}/sidepanel.html")
                page.wait_for_function("!!window.quickdraw?.fileIndex", timeout=15000)
                page.evaluate("""() => {
                  const b=quickdraw;
                  b.elements=[
                    {id:'shape-1',type:'rect',x:20,y:20,w:60,h:60,
                     fill:'solid',color:'#ff0000'},
                    {id:'shape-2',type:'rect',x:120,y:20,w:60,h:60,
                     fill:'solid',color:'#0000ff'}
                  ];b.render();
                }""")
                button = page.locator("#btn-layers-toggle")
                panel = page.locator("#layers-panel")
                assert button.is_enabled(), "图层入口不应依赖选区"
                assert not page.locator("#btn-ai-compare").is_enabled(), "AI 对比按钮应保留选区条件"
                assert panel.is_hidden()

                button.click()
                assert panel.is_visible(), "左侧图层按钮无法打开面板"
                assert button.get_attribute("aria-pressed") == "true"
                assert page.locator("#layers-tree .layer-row").count() == 2
                bar = button.bounding_box()
                card = panel.bounding_box()
                assert bar and card and card["x"] > bar["x"] + bar["width"], (
                    "面板遮挡了左侧按钮", bar, card
                )
                button.click()
                assert panel.is_hidden(), "左侧图层按钮无法关闭面板"
                assert button.get_attribute("aria-expanded") == "false"

                # Keyboard activation remains available even when the bottom
                # property strip overlaps the dock in a narrow viewport.
                page.locator("#btn-menu").focus()
                page.keyboard.press("Enter")
                page.locator("#btn-layers-panel").focus()
                page.keyboard.press("Enter")
                assert panel.is_visible() and button.get_attribute("aria-pressed") == "true"
                page.locator("#btn-layers-close").click()
                assert panel.is_hidden() and button.get_attribute("aria-pressed") == "false"
                assert not errors, (width, errors)
                context.close()
            print("LAYERS_SHORTCUT_ACCESSIBLE_AND_TOGGLES_PASS")
        finally:
            browser.close()
finally:
    server.shutdown()

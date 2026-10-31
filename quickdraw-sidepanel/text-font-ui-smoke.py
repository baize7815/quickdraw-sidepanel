"""Headless Chromium regression for the font-size field while editing text and notes.
Usage: python quickdraw-sidepanel/text-font-ui-smoke.py
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
            context = browser.new_context(viewport={"width": 960, "height": 720})
            context.add_init_script("""() => {
              window.chrome = {
                runtime: {
                  id:'font-smoke',
                  getURL:path => location.origin + '/' + path,
                  onMessage:{addListener(){}},
                  getManifest:() => ({version:'3.9.8'})
                },
                windows:{getCurrent:async()=>({id:1})},
                permissions:{contains:async()=>false},
                tabs:{query:async()=>[],get:async()=>({}),create:async()=>({id:1})},
                storage:{local:{
                  get:async()=>({}),set:async()=>{},remove:async()=>{}
                },onChanged:{addListener(){}}}
              };
            }""")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(f"http://127.0.0.1:{server.server_port}/sidepanel.html")
            page.wait_for_function("!!window.quickdraw?.fileIndex", timeout=15000)
            toolbar = page.locator("#text-size-control")
            font = page.locator("#text-font-number")
            canvas = page.locator("#canvas-container")

            page.locator('[data-tool="text"]').click()
            canvas.click(position={"x": 220, "y": 170})
            editor = page.locator(".inline-text-editor")
            editor.wait_for()
            editor.fill("Hello")
            font.click()
            assert font.evaluate("(el) => el === document.activeElement"), "字号输入框没有得到焦点"
            assert editor.is_visible(), "点击字号框使文字编辑器消失"
            assert toolbar.is_visible(), "点击字号框使字号工具栏消失"
            font.fill("42")
            font.press("Tab")
            assert page.evaluate("quickdraw.getSelectedElements()[0].fontSize") == 42
            assert editor.is_visible(), "字号修改后文字编辑器消失"
            editor.fill("Hello world")
            canvas.click(position={"x": 510, "y": 320})
            assert editor.count() == 0, "离开工具栏后文字编辑未正常结束"
            assert any(e.get("type") == "text" and e.get("fontSize") == 42 and e.get("text") == "Hello world"
                       for e in page.evaluate("quickdraw.elements")), "文字字号未保存"

            page.locator('[data-tool="note"]').click()
            canvas.click(position={"x": 310, "y": 300})
            note = page.locator(".note-text-editor")
            note.wait_for()
            note.fill("Note")
            font.click()
            assert note.is_visible() and toolbar.is_visible(), "点击字号框使便签编辑器消失"
            font.fill("36")
            font.press("Tab")
            assert page.evaluate("quickdraw.getSelectedElements()[0].fontSize") == 36
            note.fill("Note new")
            canvas.click(position={"x": 600, "y": 420})
            assert note.count() == 0
            assert any(e.get("type") == "note" and e.get("fontSize") == 36 and e.get("text") == "Note new"
                       for e in page.evaluate("quickdraw.elements")), "便签字号未保存"
            assert not errors, errors
            print("TEXT_AND_NOTE_FONT_SIZE_FOCUS_PASS")
        finally:
            browser.close()
finally:
    server.shutdown()

"""Chromium checks: startup zoom defaults to 50%, without destroying saved views.
Usage: python quickdraw-sidepanel/default-zoom-ui-smoke.py
"""
import http.server
import json
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


def stored_document(scale, elements=None, offset_x=0, offset_y=0):
    file_id = "f-zoom"
    return {
        "quickdraw_v2_files": {
            "current": file_id,
            "files": [{"id": file_id, "name": "Untitled", "updatedAt": 1}],
        },
        f"quickdraw_v2_file:{file_id}": {
            "version": 5, "revision": 0, "elements": elements or [], "groups": [],
            "camera": {"scale": scale, "offsetX": offset_x, "offsetY": offset_y},
            "aiTaskReceipts": {},
        },
    }


cases = [
    ("fresh", {}, .5, False),
    ("legacy-empty-10", stored_document(.1), .5, False),
    ("legacy-content-10", stored_document(.1, [
        {"id": "square", "type": "rect", "x": 200, "y": 100, "w": 140, "h": 80,
         "color": "#336699", "fill": "solid"}
    ], 420, 220), .5, True),
    ("saved-content-80", stored_document(.8, [
        {"id": "square", "type": "rect", "x": 200, "y": 100, "w": 140, "h": 80,
         "color": "#336699", "fill": "solid"}
    ], 35, 20), .8, True),
]

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            headless=True,
        )
        try:
            for name, saved, expected, has_content in cases:
                context = browser.new_context(viewport={"width": 960, "height": 720})
                context.add_init_script("window.__fakeStorage = " + json.dumps(saved) + ";\n" + """(() => {
                  window.chrome = {
                    runtime: {id:'zoom-test',getURL:p=>location.origin+'/'+p,
                              onMessage:{addListener(){}},
                              getManifest:()=>({version:'3.9.10'})},
                    windows:{getCurrent:async()=>({id:1})},
                    permissions:{contains:async()=>false},
                    tabs:{query:async()=>[],get:async()=>({}),create:async()=>({id:1})},
                    storage:{local:{
                      get:async keys=>{
                        const output={};
                        for(const k of (Array.isArray(keys)?keys:[keys])){
                          if(Object.hasOwn(window.__fakeStorage,k))output[k]=window.__fakeStorage[k];
                        }
                        return output;
                      },
                      set:async values=>Object.assign(window.__fakeStorage,values),
                      remove:async keys=>{
                        for(const k of (Array.isArray(keys)?keys:[keys]))delete window.__fakeStorage[k];
                      }
                    },onChanged:{addListener(){}}}
                  };
                })();""")
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda err: errors.append(str(err)))
                page.goto(f"http://127.0.0.1:{server.server_port}/sidepanel.html")
                page.wait_for_function("!!window.quickdraw?.fileIndex", timeout=15000)
                actual = page.evaluate("quickdraw.scale")
                label = page.locator("#zoom-level").text_content()
                assert abs(actual - expected) < 1e-9, (name, actual, expected)
                assert label == f"{round(expected*100)}%", (name, label)
                if has_content:
                    original = saved["quickdraw_v2_file:f-zoom"]["camera"]
                    center = page.evaluate("""() => {
                      const b=quickdraw;return b.screenToWorld(b.width/2,b.height/2);
                    }""")
                    center_before = {
                        "x": (page.evaluate("quickdraw.width") / 2 - original["offsetX"])
                             / original["scale"],
                        "y": (page.evaluate("quickdraw.height") / 2 - original["offsetY"])
                             / original["scale"],
                    }
                    assert abs(center["x"] - center_before["x"]) < 1e-6, (name, center)
                    assert abs(center["y"] - center_before["y"]) < 1e-6, (name, center)
                assert not errors, (name, errors)
                context.close()
            print("DEFAULT_STARTUP_ZOOM_50_AND_SAVED_VIEWS_PASS")
        finally:
            browser.close()
finally:
    server.shutdown()

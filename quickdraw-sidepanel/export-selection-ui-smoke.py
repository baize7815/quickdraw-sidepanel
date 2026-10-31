"""Chromium regression for selected-only JPG/PNG/SVG export and Ctrl+E.
Usage: python quickdraw-sidepanel/export-selection-ui-smoke.py
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
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            headless=True,
        )
        try:
            context = browser.new_context(viewport={"width": 960, "height": 720})
            context.add_init_script("""() => {
              window.chrome = {
                runtime:{id:'export-smoke',getURL:path=>location.origin+'/'+path,
                         onMessage:{addListener(){}},getManifest:()=>({version:'3.9.9'})},
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

            menu_ids = page.locator("#menu-popover > button[id^=btn-export-]").evaluate_all(
                "(items) => items.map(item => item.id)"
            )
            assert menu_ids[:3] == [
                "btn-export-sel-jpg", "btn-export-sel-png", "btn-export-sel-svg"
            ], menu_ids
            assert not any(name in menu_ids for name in [
                "btn-export-jpg", "btn-export-transparent", "btn-export-svg"
            ]), menu_ids

            page.evaluate("""() => {
              const b=quickdraw;
              const red={id:'red',type:'rect',x:100,y:90,w:60,h:40,size:1,
                color:'#e11e1e',fillColor:'#e11e1e',fill:'solid',stroke:'none'};
              const blue={id:'blue',type:'rect',x:450,y:330,w:120,h:120,size:1,
                color:'#0011ff',fillColor:'#0011ff',fill:'solid',stroke:'none'};
              b.elements=[red,blue];b.spatialDirty=true;b.setSelection([red]);
              b.render();window.__exports=[];
              b.downloadBlob=async (blob,filename)=>{
                const record={filename,type:blob.type};
                if(blob.type.startsWith('image/svg')){
                  record.svg=await blob.text();
                } else {
                  const bmp=await createImageBitmap(blob);
                  const canvas=document.createElement('canvas');
                  canvas.width=bmp.width;canvas.height=bmp.height;
                  const ctx=canvas.getContext('2d');ctx.drawImage(bmp,0,0);
                  record.width=bmp.width;record.height=bmp.height;
                  record.center=Array.from(ctx.getImageData(
                    Math.floor(bmp.width/2),Math.floor(bmp.height/2),1,1).data);
                  record.corner=Array.from(ctx.getImageData(0,0,1,1).data);
                  bmp.close();
                }
                window.__exports.push(record);
              };
            }""")

            # The shortcut must not silently export the whole board when empty.
            page.evaluate("quickdraw.clearSelection()")
            page.locator("#canvas-container").focus()
            page.keyboard.press("Control+e")
            page.wait_for_timeout(100)
            assert page.evaluate("window.__exports.length") == 0
            page.evaluate("quickdraw.setSelection([quickdraw.elements[0]])")

            # Direct browser keypress, not a hand-called export method.
            page.locator("#canvas-container").focus()
            page.keyboard.press("Control+e")
            page.wait_for_function("window.__exports.length === 1", timeout=3000)
            jpg = page.evaluate("window.__exports[0]")
            assert jpg["filename"].endswith("-所选.jpg"), jpg
            assert jpg["type"] == "image/jpeg", jpg
            assert jpg["width"] < 200 and jpg["height"] < 200, jpg
            assert jpg["center"][0] > 150 and jpg["center"][2] < 100, jpg
            assert jpg["corner"][3] == 255, jpg

            page.locator("#btn-menu").click()
            page.locator("#btn-export-sel-png").click()
            page.wait_for_function("window.__exports.length === 2")
            png = page.evaluate("window.__exports[1]")
            assert png["filename"].endswith("-所选.png") and png["type"] == "image/png", png
            assert png["width"] < 200 and png["height"] < 200, png
            assert png["center"][0] > 150 and png["center"][2] < 100, png

            page.locator("#btn-menu").click()
            page.locator("#btn-export-sel-svg").click()
            page.wait_for_function("window.__exports.length === 3")
            svg = page.evaluate("window.__exports[2]")
            assert svg["filename"].endswith("-所选.svg"), svg
            assert svg["type"].startswith("image/svg+xml"), svg
            assert "#e11e1e" in svg["svg"] and "#0011ff" not in svg["svg"], svg
            assert not errors, errors
            print("SELECTED_JPG_PNG_SVG_AND_CTRL_E_PASS")
        finally:
            browser.close()
finally:
    server.shutdown()

"""Chromium regression for speech bubble, bold down arrow, translucent shapes and corners.
Usage: python quickdraw-sidepanel/shape-presets-ui-smoke.py
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
            context = browser.new_context(viewport={"width": 1024, "height": 800})
            context.add_init_script("""() => {
              window.chrome = {
                runtime:{id:'shape-smoke',getURL:p=>location.origin+'/'+p,
                         onMessage:{addListener(){}},getManifest:()=>({version:'3.9.10'})},
                windows:{getCurrent:async()=>({id:1})},
                permissions:{contains:async()=>false},
                tabs:{query:async()=>[],get:async()=>({}),create:async()=>({id:1})},
                storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}},
                         onChanged:{addListener(){}}}
              };
            }""")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda err: errors.append(str(err)))
            page.goto(f"http://127.0.0.1:{server.server_port}/sidepanel.html")
            page.wait_for_function("!!window.quickdraw?.fileIndex", timeout=15000)
            page.locator("#btn-shape-menu").click()
            grid = page.locator("#shape-popover .shape-grid")
            assert grid.is_visible()
            positions = grid.locator(".shape-option").evaluate_all("""items =>
              items.map(el => {
                const r=el.getBoundingClientRect();
                return {x:Math.round(r.x),y:Math.round(r.y)};
              })
            """)
            assert len(positions) == 10, positions
            assert len(set(p["y"] for p in positions)) == 2, positions
            assert len(set(p["x"] for p in positions[:5])) == 5, positions
            assert len(set(p["y"] for p in positions[:5])) == 1, positions
            assert len(set(p["y"] for p in positions[5:])) == 1, positions
            page.locator("#btn-shape-menu").click()
            box = page.locator("#canvas-container").bounding_box()
            assert box is not None

            def select_option(selector):
                if not page.locator("#shape-popover").is_visible():
                    page.locator("#btn-shape-menu").click()
                page.locator(selector).click()

            def drag(x, y, width=140, height=105):
                x += box["x"]
                y += box["y"]
                page.mouse.move(x, y)
                page.mouse.down()
                page.mouse.move(x+width, y+height, steps=8)
                page.mouse.up()

            assert page.locator('.fill-option.active').get_attribute('data-fill') == 'solid'
            assert page.locator('.stroke-option.active').get_attribute('data-stroke') == 'none'
            select_option('[data-shape="rect"]')
            drag(60, 80, 105, 75)
            default_rect = page.evaluate("""() => {
              const b=quickdraw,e=b.elements.at(-1);
              return {type:e.type,fill:e.fill,stroke:e.stroke,
                fillOpacity:e.fillOpacity??1,svg:b.svgShapeMarkup(e)};
            }""")
            assert default_rect["type"] == "rect" and default_rect["fill"] == "solid", default_rect
            assert default_rect["stroke"] == "none" and default_rect["fillOpacity"] == 1, default_rect
            assert 'stroke="none"' in default_rect["svg"], default_rect

            select_option('[data-shape="speechbubble"]')
            drag(250, 180)
            bubble = page.evaluate("""() => {
              const b=quickdraw,e=b.elements.at(-1);
              return {type:e.type,svg:b.svgShapeMarkup(e),commands:b.shapePathCommands(e)};
            }""")
            assert bubble["type"] == "speechbubble", bubble
            assert bubble["svg"].count(" C ") >= 2 and " Z" in bubble["svg"], bubble
            assert len(bubble["commands"]) == 9

            select_option('[data-shape="downarrow"]')
            drag(460, 170)
            arrow = page.evaluate("""() => {
              const b=quickdraw,e=b.elements.at(-1);
              return {type:e.type,svg:b.svgShapeMarkup(e),commands:b.shapePathCommands(e)};
            }""")
            assert arrow["type"] == "downarrow", arrow
            assert " L " in arrow["svg"] and " Z" in arrow["svg"], arrow
            assert len(arrow["commands"]) == 8
            assert page.evaluate("""() => {
              const b=quickdraw,e=b.elements.at(-1),c=document.createElement('canvas');
              c.width=500;c.height=500;
              const ctx=c.getContext('2d');b.geometryPath(ctx,e);
              const x=Math.min(e.x,e.x+e.w),y=Math.min(e.y,e.y+e.h),w=Math.abs(e.w),h=Math.abs(e.h);
              return ctx.isPointInPath(x+w*.5,y+h*.5)
                && ctx.isPointInPath(x+w*.5,y+h*.95)
                && !ctx.isPointInPath(x+w*.1,y+h*.1);
            }"""), "向下粗箭头的命中范围不正确"

            select_option('[data-shape="roundrect"]')
            drag(250, 360, 180, 120)
            initial = page.evaluate("""() => {
              const b=quickdraw,e=b.elements.at(-1);
              return {type:e.type,corner:e.cornerSize,selected:b.getSelectedElements().map(x=>x.id)};
            }""")
            assert initial["type"] == "roundrect" and initial["corner"] == "M", initial
            # Opening the shape menu with a selected roundrect must NOT deselect it.
            page.locator("#btn-shape-menu").click()
            assert page.locator("#shape-popover").is_visible()
            page.locator('[data-corner-size="S"]').click()
            small = page.evaluate("quickdraw.roundedCornerRadius(quickdraw.elements.at(-1))")
            page.locator('[data-corner-size="XL"]').click()
            largest = page.evaluate("""() => {
              const b=quickdraw,e=b.elements.at(-1);
              return {size:e.cornerSize,r:b.roundedCornerRadius(e),
                min:Math.min(Math.abs(e.w),Math.abs(e.h))/2,svg:b.svgShapeMarkup(e)};
            }""")
            assert largest["size"] == "XL" and largest["r"] > small, (small, largest)
            assert abs(largest["r"] - largest["min"]) < 1e-9, largest
            assert f'rx="{largest["r"]:g}"' in largest["svg"], largest

            # Five presets: four translucent circles and one rounded rectangle.
            for index, (name, shape, color) in enumerate([
                ("blue","ellipse","#85b8fa"),("purple","ellipse","#aa96f5"),
                ("pink","ellipse","#e89beb"),("orange","ellipse","#ffb47f"),
                ("blue-round","roundrect","#65b9ff")
            ]):
                select_option(f'[data-shape-preset="{name}"]')
                drag(200+index*135, 545, 115, 93)
                record = page.evaluate("""() => {
                  const b=quickdraw,e=b.elements.at(-1);
                  return {type:e.type,fill:e.fill,opacity:e.fillOpacity,
                    strokeOpacity:e.strokeOpacity,color:e.fillColor,
                    svg:b.svgShapeMarkup(e),r:b.roundedCornerRadius(e)};
                }""")
                assert record["type"] == shape and record["fill"] == "solid", (name,record)
                assert record["color"] == color and record["opacity"] == .24, (name,record)
                assert record["strokeOpacity"] == 1 and 'fill-opacity="0.24"' in record["svg"]
                if name == "blue-round":
                    assert record["r"] > 12, record

            # PNG must preserve translucent pixels and fully opaque boundaries.
            pixel = page.evaluate("""async () => {
              const b=quickdraw,e=b.elements.find(x=>x.type==='ellipse'&&x.fillOpacity===.24);
              const blob=await b.createPNGBlob(true,[e],0);
              const image=await createImageBitmap(blob);
              const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
              const ctx=c.getContext('2d');ctx.drawImage(image,0,0);
              const center=Array.from(ctx.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data);
              image.close();
              return {mime:blob.type,center};
            }""")
            assert pixel["mime"] == "image/png", pixel
            assert 45 <= pixel["center"][3] <= 85, pixel
            preserved = page.evaluate("""() => {
              const doc=QuickdrawDocumentModel.normalizeDocument(quickdraw.serializeDocument());
              return {
                bubble:doc.elements.some(e=>e.type==='speechbubble'),
                arrow:doc.elements.some(e=>e.type==='downarrow'),
                round:doc.elements.some(e=>e.type==='roundrect'&&e.cornerSize==='XL'),
                translucent:doc.elements.filter(e=>e.fillOpacity===.24).length
              };
            }""")
            assert preserved["bubble"] and preserved["arrow"] and preserved["round"], preserved
            assert preserved["translucent"] == 5, preserved
            assert not errors, errors
            print("NEW_SHAPES_SEMITRANSPARENT_PRESETS_AND_ROUNDED_CORNERS_PASS")
        finally:
            browser.close()
finally:
    server.shutdown()

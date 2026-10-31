"""Isolated Chromium UI acceptance for Quickdraw's embedded visual editor.
Usage: python visual-edit-ui-smoke.py
No external model request; storage and parent submission are locally mocked.
"""
import http.server
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

server = http.server.ThreadingHTTPServer(
    ("127.0.0.1", 0),
    lambda *args, **kw: Quiet(*args, directory=str(ROOT), **kw),
)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = "http://127.0.0.1:" + str(server.server_port)
storage = """window.QuickdrawStorage=class {
 constructor(){this.blobs=window.__assets ||= {};}
 async getAsset(id){
  if(this.blobs[id])return {blob:this.blobs[id],type:'image/png'};
  const c=document.createElement('canvas');c.width=id==='a_ref'?220:400;c.height=id==='a_ref'?220:240;
  const x=c.getContext('2d');x.fillStyle='#eaece2';x.fillRect(0,0,c.width,c.height);
  x.fillStyle=id==='a_ref'?'gold':'skyblue';x.fillRect(70,40,130,150);
  return {blob:await new Promise(r=>c.toBlob(r,'image/png')),type:'image/png'};
 }
 async putAsset(blob,meta){const id='a_generated_'+Object.keys(this.blobs).length;this.blobs[id]=blob;return id;}
};"""
parent = """<!doctype html><html><body>
<iframe id="host" width="460" height="860" style="border:1px solid #ddd"></iframe>
<script>
window.received=null;
window.addEventListener('message',event=>{
 if(event.data?.type!=='qd-visual-submit')return;
 window.received=event.data;
 document.getElementById('host').contentWindow.postMessage({type:'qd-visual-response',ok:true},location.origin);
});
document.getElementById('host').src='/ai-visual-editor.html?embedded=1&assets=a_main,a_ref,a_other';
</script></body></html>"""

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            headless=True,
        )
        try:
            context = browser.new_context()
            context.add_init_script(
                "window.chrome={permissions:{request:async()=>true},"
                "downloads:{download:async()=>1},runtime:{id:'test'}};"
            )
            context.route("**/storage.js", lambda route: route.fulfill(
                status=200, content_type="application/javascript", body=storage))
            context.route("**/visual-harness", lambda route: route.fulfill(
                status=200, content_type="text/html", body=parent))
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(base + "/visual-harness")
            frame = page.frame_locator("#host")
            frame.locator("#material-bar").wait_for(state="attached")
            page.wait_for_timeout(900)
            print('EDITOR_STATUS',frame.locator('#status').text_content(),flush=True)
            print('MATERIAL_HTML',frame.locator('#material-bar').inner_html()[:500],flush=True)
            frame.locator("#material-bar .material-item").first.wait_for(timeout=5000)
            print("materials",frame.locator(".material-item").count(),flush=True)
            assert frame.locator(".material-item").count() == 3
            mask = frame.locator('#mask-controls')
            mask_height = mask.bounding_box()['height']
            print('COMPACT_MASK_HEIGHT', round(mask_height, 1), flush=True)
            assert mask_height <= 104, '蒙版工具没有真正压缩到约两行'
            assert frame.locator('#brush').is_visible()
            assert frame.locator('#eraser').is_visible()
            assert frame.locator('#invert').is_visible()
            frame.locator('#brush-size').fill('60')
            assert frame.locator('#brush-size-value').text_content() == '60'
            frame.locator('#feather').fill('8')
            assert frame.locator('#feather-value').text_content() == '8'

            # Space-saving copy is removed; select keeps an accessible name.
            assert frame.locator('#visual-send-panel .hint').count() == 0
            assert frame.locator('#gemini-options').is_hidden()
            assert frame.locator('#visual-provider').get_attribute('aria-label') == '图片服务'
            assert frame.locator('#visual-send').is_visible()
            frame.locator("[data-mode=point]").click()
            box = frame.locator("#overlay").bounding_box()
            assert box is not None
            page.mouse.click(box["x"]+box["width"]*.28,box["y"]+box["height"]*.27)
            assert frame.locator('.point-row').count() == 1
            assert frame.locator('.point-toggle').get_attribute('aria-expanded') == 'false'
            assert frame.locator('#point-list textarea').is_hidden()
            frame.locator('.point-toggle').click()
            assert frame.locator('.point-toggle').get_attribute('aria-expanded') == 'true'
            assert frame.locator('#point-list textarea').is_visible()
            frame.locator('#point-list textarea').fill('pink hair')
            frame.locator('.point-toggle').click()
            assert frame.locator('#point-list textarea').is_hidden()
            frame.locator('.point-toggle').click()
            assert frame.locator('#point-list textarea').input_value() == 'pink hair'
            # A second point starts collapsed; opening it closes the first.
            page.mouse.click(box['x']+box['width']*.72, box['y']+box['height']*.72)
            assert frame.locator('.point-row').count() == 2
            # Default anchors form two columns; an expanded card spans both.
            point_grid=frame.locator('#point-list').bounding_box()
            first_point=frame.locator('.point-row').nth(0).bounding_box()
            second_point=frame.locator('.point-row').nth(1).bounding_box()
            assert first_point['width'] >= point_grid['width'] - 2, (first_point,point_grid)
            assert second_point['width'] < point_grid['width'] * .60, (second_point,point_grid)

            assert frame.locator('.point-toggle').nth(0).get_attribute('aria-expanded') == 'true'
            assert frame.locator('.point-toggle').nth(1).get_attribute('aria-expanded') == 'false'
            frame.locator('.point-toggle').nth(1).click()
            assert frame.locator('#point-list textarea').nth(0).is_hidden()
            assert frame.locator('#point-list textarea').nth(1).is_visible()
            frame.locator('.point-remove').nth(1).click()
            assert frame.locator('.point-row').count() == 1
            assert frame.locator('#point-list textarea').is_hidden()
            frame.locator("#request").fill("change @\u70b91 using @\u56fe2")
            assert frame.locator('#prompt-output').is_hidden()
            assert frame.locator('#generate-prompt').is_hidden()
            assert frame.locator('#copy-prompt').is_hidden()
            prompt = frame.locator("#prompt-output").input_value()
            assert "Point 1 on Image 1" in prompt
            assert "Image 3 (reference 2)" in prompt
            frame.locator("#request").fill("use @")
            options = frame.locator("#mention-menu button")
            assert options.count() >= 3
            options.filter(has_text="@\u70b91").click(force=True)
            assert "@\u70b91" in frame.locator("#request").input_value()
            frame.locator("#request").fill("pink hair, refer to @\u56fe2, at @\u70b91")
            assert frame.locator('#visual-provider option[value="gemini"]').count() == 1
            frame.locator('#visual-provider').select_option('gemini')
            assert frame.locator('#gemini-options').is_visible()
            assert frame.locator('#gemini-reuse-session').is_visible()
            assert frame.locator('#gemini-ratio').input_value() == 'auto'
            frame.locator("#visual-send").click()
            page.wait_for_function("window.received !== null", timeout=8000)
            payload = page.evaluate("window.received")
            assert payload['provider'] == 'gemini', payload
            assert payload["inputAssetIds"][0] == "a_main"
            assert len(payload["inputAssetIds"]) == 4
            assert payload["inputAssetIds"][2:] == ["a_ref","a_other"]
            assert len(payload["prompt"]) <= 4000
            assert "Image 2 is always the annotated location guide" in payload["prompt"]
            # Fusion uses selected references without another file upload.
            frame.locator('[data-mode=fusion]').click()
            assert frame.locator('#fusion-controls p.hint').count() == 0
            assert frame.locator('#reference-file').is_visible()
            assert frame.locator('label[for="reference-file"]').is_visible()
            box = frame.locator('#overlay').bounding_box()
            page.mouse.move(box['x']+box['width']*.14, box['y']+box['height']*.16)
            page.mouse.down()
            page.mouse.move(box['x']+box['width']*.71, box['y']+box['height']*.65, steps=7)
            page.mouse.up()
            frame.locator('#request').fill('combine into base scene')
            assert 'Image 3 is the object or scene reference' in frame.locator('#prompt-output').input_value()
            # Switching the primary image changes the coordinate canvas.
            frame.locator('.material-item').nth(1).locator('button').first.click()
            frame.locator('#material-bar .material-item.primary').wait_for()
            page.wait_for_timeout(450)
            assert '220' in frame.locator('#size-label').text_content()
            assert frame.locator('#point-list textarea').count() == 0
            assert not errors, errors
            print("embedded editor, point mentions, image roles, send contract: PASS")
        finally:
            browser.close()
finally:
    server.shutdown()

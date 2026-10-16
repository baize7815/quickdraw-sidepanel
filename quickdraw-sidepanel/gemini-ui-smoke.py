"""Gemini conversation adapter acceptance without touching a real conversation.

Mocks the site at its exact origin. The content script must confirm two image
attachments, send one prompt, match its own request and return a *new* PNG.
Run: python gemini-ui-smoke.py
"""
import base64
import io
import json
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parent
def png(color):
    im=Image.new("RGB",(460,300),color)
    buf=io.BytesIO();im.save(buf,"PNG")
    return "data:image/png;base64,"+base64.b64encode(buf.getvalue()).decode()

source_a,source_b,out_image=png((220,40,30)),png((30,100,220)),png((20,200,90))
html="""<!doctype html><meta charset="utf-8">
<style>
rich-textarea{display:block;width:600px;height:120px;border:1px solid #888}
.ql-editor{height:100px;padding:10px}
button{padding:8px}
uploader-file-preview{display:inline-block;width:72px;height:72px}
uploader-file-preview img{display:block;width:64px;height:64px}
gem-media-attachment,.gem-attachment-content{display:block}
user-query,model-response{display:block;border:1px solid #ddd;padding:8px;margin-top:8px}
model-response img{display:block;width:320px;height:220px}
</style>
<rich-textarea><div class="ql-editor" contenteditable="true" role="textbox" aria-label="Enter a prompt for Gemini"></div></rich-textarea>
<div id="previews"></div>
<button id="tools" aria-label="Upload & tools">+</button>
<button id="send" aria-label="Send message">Send</button>
<div id="turns"></div>
<script>
 window.__events=[];
 window.chrome={runtime:{id:"fake-quickdraw-id",sendMessage:async event=>{window.__events.push(event);},onMessage:{addListener:fn=>{window.__handler=fn;}}}};
 document.getElementById("tools").onclick=()=>{
  if(document.querySelector('input[type=file][accept="image/*"]'))return;
  const input=document.createElement("input");input.type="file";input.multiple=true;input.accept="image/*";input.style.display="none";
  input.onchange=()=>{
   const host=document.getElementById("previews");
   host.replaceChildren();
   for(const file of [...input.files]){
    const chip=document.createElement('uploader-file-preview');
    const state=document.createElement('gem-media-attachment');
    const progress=document.createElement('span');progress.className='gem-attachment-content loading';
    const preview=document.createElement('img');preview.alt='attachment';preview.className='gem-attachment-style-img';preview.src=URL.createObjectURL(file);
    state.append(preview,progress);chip.append(state);host.append(chip);
    setTimeout(()=>progress.classList.remove('loading'),220);
   }
  };
  document.body.append(input);
 };
 document.getElementById("send").onclick=()=>{
  const editor=document.querySelector(".ql-editor");
  const text=editor.innerText;
  window.__sentText=text;
  window.__sentFiles=[...document.querySelector('input[type=file]').files].map(f=>f.name);
  // Gemini collapses long user bubbles to a prefix with an expand control.
  const user=document.createElement('user-query');user.textContent=text.slice(0,56)+'…';
  document.getElementById('turns').append(user);
  setTimeout(()=>{
   const reply=document.createElement('model-response');
   const img=document.createElement('img');img.alt='Generated image';img.src=window.__resultPng;
   // Gemini may place the full-size output *inside* its download button.
   const button=document.createElement('button');button.setAttribute('aria-label','Download image');button.append(img);
   reply.append(button);document.getElementById('turns').append(reply);
  },550);
 };
</script>"""

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",headless=True)
    try:
        context=browser.new_context()
        context.route("https://gemini.google.com/app",lambda route:route.fulfill(status=200,content_type="text/html",body=html))
        page=context.new_page()
        page.goto("https://gemini.google.com/app",wait_until="domcontentloaded")
        page.evaluate("p=>window.__resultPng=p",out_image)
        page.add_script_tag(content=(root/"gemini-content.js").read_text(encoding="utf-8"))
        print('ENV',page.evaluate("() => ({host:location.hostname,id:window.chrome?.runtime?.id,hasHandler:typeof window.__handler,editor:!!document.querySelector('rich-textarea .ql-editor')})"),flush=True)
        ready=page.evaluate("""() => {let result=null;window.__handler({type:'qd-ai-gemini-command',taskId:'probe-01',action:'readiness'},{id:'fake-quickdraw-id'},r=>result=r);return result;}""")
        assert ready.get("ready"),ready
        assert ready.get("auth") is False,ready
        prompt="Edit Image 1. Recolor the indicated object. Image 2 is the spatial guide."
        response=page.evaluate("""({prompt,images}) => {let result=null;window.__handler({
           type:'qd-ai-gemini-command',taskId:'quickdraw-mock-1',action:'start',mode:'image-edit',imageDataUrls:images,prompt
        },{id:'fake-quickdraw-id'},r=>result=r);return result;}""",{"prompt":prompt,"images":[source_a,source_b]})
        assert response=={'ok':True},response
        page.wait_for_function("""() => window.__events.some(e=>e.kind==="image-reply") || window.__events.some(e=>e.kind==="needs-attention")""",timeout=25000)
        state=page.evaluate("""() => ({events:window.__events.map(e=>({kind:e.kind,stage:e.stage,error:e.error,hasImage:!!e.imageDataUrl})),
                                      sentFiles:window.__sentFiles,sentText:window.__sentText})""")
        print("EVENTS",json.dumps(state,ensure_ascii=True)[:3500],flush=True)
        assert not any(e["kind"]=="needs-attention" for e in state["events"]),state
        assert state["sentFiles"]==["quickdraw-source-01.png","quickdraw-source-02.png"],state
        assert state["sentText"].strip()==prompt,state
        kinds={e["kind"] for e in state["events"]}
        assert "send-confirmed" in kinds,kinds
        assert "image-reply" in kinds,kinds
        assert next(e for e in state["events"] if e["kind"]=="image-reply")["hasImage"]
        print("GEMINI_ADAPTER_MOCK_END_TO_END_PASS")
        # Failure regression: Gemini may discard attachments when Quill updates.
        # The adapter must not send text-only when the visual source is gone.
        lost=context.new_page()
        try:
            lost.goto('https://gemini.google.com/app',wait_until='domcontentloaded')
            lost.evaluate('p=>window.__resultPng=p',out_image)
            lost.add_script_tag(content=(root/'gemini-content.js').read_text(encoding='utf-8'))
            lost.evaluate("""() => document.querySelector('.ql-editor').addEventListener('input',
              () => document.getElementById('previews').replaceChildren(), {once:true})""")
            lost.evaluate("""({prompt,images})=>window.__handler({type:'qd-ai-gemini-command',taskId:'quickdraw-lost-attachment',action:'start',mode:'image-edit',imageDataUrls:images,prompt},{id:'fake-quickdraw-id'},()=>{})""",{'prompt':prompt,'images':[source_a,source_b]})
            lost.wait_for_function("""() => window.__events.some(e=>e.kind==='needs-attention')""",timeout=16000)
            failure=lost.evaluate("""() => ({reason:window.__events.find(e=>e.kind==='needs-attention')?.code, sent:window.__sentText||''})""")
            print('VANISHED_ATTACHMENTS',failure,flush=True)
            assert failure['reason']=='attachment-lost-before-send',failure
            assert not failure['sent'],failure
        finally:
            lost.close()
    finally:
        browser.close()

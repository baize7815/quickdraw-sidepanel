"""Chromium acceptance for pixel-preserving mask composition and SVG gradients.
Runs entirely locally against a mocked asset store; no AI service is called.
Usage: python quickdraw-sidepanel/rectification-ui-smoke.py
"""

from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
source = (ROOT / "sidepanel.js").read_text(encoding="utf-8")
start = source.index("    async compositeVisualMaskAsset(")
end = source.index("    async importAITask(", start)
method = source[start:end]

with sync_playwright() as pw:
    browser = pw.chromium.launch(
        executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        headless=True,
    )
    try:
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto("about:blank")
        page.add_script_tag(content="class MaskBoard{" + method + "}window.MaskBoard=MaskBoard;")
        pixels = page.evaluate("""async () => {
          function makeCanvas(width,height,colors){
            const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
            const ctx=canvas.getContext('2d');
            for(let i=0;i<colors.length;i++){ctx.fillStyle=colors[i];ctx.fillRect(i%width,Math.floor(i/width),1,1);}
            return canvas;
          }
          const sources=new Map();
          const toBlob=c=>new Promise(resolve=>c.toBlob(resolve,'image/png'));
          sources.set('original',await toBlob(makeCanvas(2,1,['blue','blue'])));
          sources.set('mask',await toBlob(makeCanvas(2,1,['white','black'])));
          sources.set('result',await toBlob(makeCanvas(2,1,['red','red'])));
          const board=new MaskBoard();
          board.store={
            async getAsset(id){return {blob:sources.get(id)};},
            async putAsset(blob,metadata){sources.set('composite',blob);return 'composite';}
          };
          const returned=await board.compositeVisualMaskAsset('original','mask',{assetId:'result'});
          const image=await createImageBitmap(sources.get(returned.assetId));
          const output=document.createElement('canvas');output.width=2;output.height=1;
          const ctx=output.getContext('2d');ctx.drawImage(image,0,0);
          const pixels=Array.from(ctx.getImageData(0,0,2,1).data);
          image.close();
          return {pixels,source:returned.sourceAssetId,composite:returned.compositedFrom};
        }""")
        assert pixels["source"] == "original", pixels
        assert pixels["composite"] == "result", pixels
        assert pixels["pixels"][:4] == [255, 0, 0, 255], pixels
        assert pixels["pixels"][4:] == [0, 0, 255, 255], pixels

        page.add_script_tag(content=(ROOT / "svg-import.js").read_text(encoding="utf-8"))
        gradient = page.evaluate("""() => {
          const xml='<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60">'
            + '<defs><linearGradient id="sky" x1="0%" x2="100%">'
            + '<stop offset="0%" stop-color="#ff0000"/>'
            + '<stop offset="50%" stop-color="#00ff00"/>'
            + '<stop offset="100%" stop-color="#0000ff"/>'
            + '</linearGradient></defs>'
            + '<rect x="0" y="0" width="80" height="60" fill="url(#sky)"/></svg>';
          const result=window.QuickdrawSVGImport.parse(xml,{newId:()=> 'path-1'});
          return {preserved:result.preservedGradients,degraded:result.degradedGradients,
            stops:result.elements[0]?.fillGradient?.stops};
        }""")
        assert gradient["preserved"] == 1 and gradient["degraded"] == 0, gradient
        assert len(gradient["stops"]) == 3, gradient
        assert [item["color"] for item in gradient["stops"]] == ["#ff0000", "#00ff00", "#0000ff"], gradient
        assert not errors, errors
        print("MASK_PIXELS_AND_SVG_GRADIENTS_PASS")
    finally:
        browser.close()

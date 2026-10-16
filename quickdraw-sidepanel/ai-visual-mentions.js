(() => {
  'use strict';
  const base = globalThis.QuickdrawVisualEditCore || (typeof require === 'function' ? require('./ai-visual-core.js') : null);
  function sourceItems(state) {
    const all = Array.isArray(state?.materials) ? state.materials : [];
    const main = all.find(v => v.assetId === state.mainAssetId);
    return main ? [main, ...all.filter(v => v !== main)] : all;
  }
  function pointAt(state, index) {
    const pt = (state?.points || [])[index - 1];
    if (!pt) throw new Error('引用的 @点' + index + ' 不存在，请检查或重新选择编辑点。');
    const c = base.coordinate(pt, state.width, state.height);
    return 'Point ' + index + ' on Image 1 at normalized [x,y]=[' + c.x + ',' + c.y + '] (pixel [' + Math.round(pt.x) + ',' + Math.round(pt.y) + '])';
  }
  function expand(text, state) {
    const sources = sourceItems(state);
    return String(text || '').replace(/@(点|图)(\d+)/g, (_, type, raw) => {
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 1) throw new Error('引用编号无效：@' + type + raw);
      if (type === '点') return pointAt(state, n);
      if (n > sources.length) throw new Error('引用的 @图' + n + ' 不存在，请检查图片素材。');
      return n === 1 ? 'Image 1 (clean target image)' : 'Image ' + (n + 1) + ' (reference ' + n + ')';
    }).replace(/@(?:点|图)(?!\d)|@\d+|@(?![\w@])/g, token => {
      throw new Error('未完成或无法识别的引用：' + token);
    });
  }
  function compile(state) {
    const sources = sourceItems(state);
    if (!sources.length) throw new Error('请选择主图。');
    if (sources.length > 4) throw new Error('最多使用 4 张素材图片。');
    if ((state.points||[]).some(pt=>pt.assetId && pt.assetId!==state.mainAssetId)) throw new Error('有编辑点不属于当前主图，请重新选择主图。');
    const next = {
      ...state,
      hasReference: sources.length > 1,
      prompt: expand(state.prompt || (state.mode === 'point' && (state.points || []).some(pt => String(pt.text||'').trim()) ? 'Apply the instructions attached to the numbered points.' : ''), state),
      points: (state.points || []).map(point => ({ ...point, text: expand(point.text, state) }))
    };
    let prompt = base.script(next);

    if (state.mode === 'fusion' && sources.length < 2) throw new Error('融合模式至少需要一张参考图。');
    if (state.mode === 'point') prompt += '\n\nAll numbered edit points belong to Image 1 unless a point instruction explicitly cites a separate reference image. A point is a location anchor, not a whole-object mask.';
    if (sources.length > 1) prompt += '\n\nImage role map: ' + sources.slice(1).map((item, i) =>
      'Image ' + (i + 3) + ' = @图' + (i + 2) + ' (' + String(item.label || '参考图').slice(0, 64) + ')').join('; ') + '. Image 2 is always the annotated location guide. Source @图1 = Image 1.';
    if (prompt.length > 4000) throw new Error('展开后的提示词超过 4000 字符，请缩短描述或减少编辑点。');
    return prompt;
  }
  function suggestions(state) {
    const images = sourceItems(state).map((v, i) => ({ token:'@图' + (i + 1), label:(i ? '参考图' : '主图') + ' · ' + String(v.label || i + 1).slice(0, 32) }));
    const points = (state?.points || []).map((_,i)=>({token:'@点' + (i + 1),label:'编辑位置 ' + (i + 1) + ' · 主图坐标'}));
    return [...points,...images];
  }
  function pending(text, cursor) {
    const left = String(text || '').slice(0,Math.max(0,Number(cursor)||0));
    const match = left.match(/@(?:点|图)?\d*$/);
    return match ? {start:left.length-match[0].length, query:match[0]} : null;
  }
  const api=Object.freeze({sourceItems,pointAt,expand,compile,suggestions,pending});
  globalThis.QuickdrawVisualMentions=api;
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
})();
(() => {
  'use strict';
  const CURRENT_VERSION=5,MAX_ELEMENTS=100000,MAX_GROUPS=20000,MAX_GROUP_DEPTH=32,MAX_COORD=1e8;
  const clone=value=>globalThis.structuredClone?structuredClone(value):JSON.parse(JSON.stringify(value));
  const finite=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
  const bounded=value=>{const number=finite(value,0);if(Math.abs(number)>MAX_COORD)throw new Error('文档包含超出安全范围的坐标。');return number;};
  const opacity=value=>Math.max(0,Math.min(1,Number.isFinite(Number(value))?Number(value):1));

  function normalizeElement(raw){
    if(!raw||typeof raw!=='object')throw new Error('文档包含无效对象。');
    const element=clone(raw);if(!element.id||!element.type)throw new Error('文档对象缺少 id 或 type。');
    element.id=String(element.id);element.type=String(element.type);element.opacity=opacity(element.opacity);
    if(element.fill==='semi'){
      element.fill='solid';
      element.fillOpacity=Math.max(0,Math.min(1,Number.isFinite(Number(element.fillOpacity))?Number(element.fillOpacity):.2));
    }else if(element.fillOpacity!=null){
      element.fillOpacity=Math.max(0,Math.min(1,Number(element.fillOpacity)||0));
    }
    for(const key of ['x','y','w','h','size','fontSize','bend'])if(element[key]!=null)element[key]=bounded(element[key]);
    if(Array.isArray(element.transform)){if(element.transform.length!==6)throw new Error(`对象 ${element.id} 的变换矩阵无效。`);element.transform=element.transform.map(bounded);const[a,b,c,d]=element.transform;if(Math.abs(a*d-b*c)<1e-10)throw new Error(`对象 ${element.id} 的变换矩阵不可逆。`);}
    if(Array.isArray(element.points)){if(element.points.length>50000)throw new Error(`对象 ${element.id} 的点数过多。`);element.points=element.points.map(point=>({...point,x:bounded(point.x),y:bounded(point.y)}));}
    if(element.type==='text')element.textMode=element.textMode==='paragraph'?'paragraph':'art';
    return element;
  }

  function normalizeGroups(rawGroups,elements){
    const source=Array.isArray(rawGroups)?rawGroups:[];if(source.length>MAX_GROUPS)throw new Error('群组数量超过安全上限。');
    const groups=source.map(group=>({id:String(group?.id||''),parentGroupId:group?.parentGroupId?String(group.parentGroupId):null,rotation:finite(group?.rotation,0)}));
    if(groups.some(group=>!group.id))throw new Error('群组缺少 id。');const ids=new Set();
    for(const group of groups){if(ids.has(group.id))throw new Error(`群组 id 重复：${group.id}`);ids.add(group.id);}
    for(const group of groups)if(group.parentGroupId&&!ids.has(group.parentGroupId))throw new Error(`群组 ${group.id} 引用了不存在的父群组。`);
    const byId=new Map(groups.map(group=>[group.id,group]));
    for(const group of groups){const seen=new Set([group.id]);let current=group,depth=0;while(current.parentGroupId){if(++depth>MAX_GROUP_DEPTH)throw new Error('群组嵌套过深。');if(seen.has(current.parentGroupId))throw new Error('群组存在循环引用。');seen.add(current.parentGroupId);current=byId.get(current.parentGroupId);if(!current)break;}}
    for(const element of elements)if(element.groupId&&!ids.has(String(element.groupId)))element.groupId=null;
    return groups;
  }

  function migrateV4(raw){
    const elements=(Array.isArray(raw?.elements)?raw.elements:[]).map(normalizeElement),groups=[],seen=new Set();
    for(const element of elements){if(!element.groupId)continue;const id=String(element.groupId);element.groupId=id;if(!seen.has(id)){seen.add(id);groups.push({id,parentGroupId:null,rotation:0});}}
    return{...clone(raw||{}),version:CURRENT_VERSION,elements,groups};
  }

  function normalizeDocument(raw){
    if(!raw||typeof raw!=='object')throw new Error('文档格式无效。');const version=Number(raw.version||4);if(version>CURRENT_VERSION)throw new Error(`文档版本 ${version} 高于当前支持版本。`);
    const migrated=version<CURRENT_VERSION,base=migrated?migrateV4(raw):clone(raw);if(!Array.isArray(base.elements))throw new Error('文档缺少 elements。');if(base.elements.length>MAX_ELEMENTS)throw new Error('文档对象数量超过安全上限。');
    const elements=base.elements.map(normalizeElement),ids=new Set();for(const element of elements){if(ids.has(element.id))throw new Error(`对象 id 重复：${element.id}`);ids.add(element.id);}
    const groups=normalizeGroups(base.groups,elements);for(const element of elements){if(element.parentId&&!ids.has(String(element.parentId)))element.parentId=null;if(element.type==='mindedge'&&(!ids.has(String(element.fromId))||!ids.has(String(element.toId))))throw new Error(`连线 ${element.id} 引用了不存在的节点。`);}
    const camera=base.camera||{};return{...base,version:CURRENT_VERSION,revision:Math.max(0,finite(base.revision,0)),elements,groups,camera:{scale:Math.max(.02,Math.min(64,finite(camera.scale,1))),offsetX:bounded(camera.offsetX),offsetY:bounded(camera.offsetY)},aiTaskReceipts:base.aiTaskReceipts&&typeof base.aiTaskReceipts==='object'?clone(base.aiTaskReceipts):{},migrated};
  }
  function createBlank(){return{version:CURRENT_VERSION,revision:0,elements:[],groups:[],camera:{scale:1,offsetX:0,offsetY:0},aiTaskReceipts:{}};}
  function encode(document){const normalized=normalizeDocument({...document,version:CURRENT_VERSION});delete normalized.migrated;return normalized;}
  const api={CURRENT_VERSION,MAX_ELEMENTS,MAX_GROUPS,MAX_GROUP_DEPTH,createBlank,normalizeDocument,encode};globalThis.QuickdrawDocumentModel=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})();

(() => {
  'use strict';
  const clone=value=>globalThis.structuredClone?structuredClone(value):JSON.parse(JSON.stringify(value));
  const maps=groups=>{const byId=new Map((groups||[]).map(group=>[group.id,group])),children=new Map();for(const group of groups||[]){const key=group.parentGroupId||'';if(!children.has(key))children.set(key,[]);children.get(key).push(group.id);}return{byId,children};};
  function ancestors(groupId,groups){const{byId}=maps(groups),result=[],seen=new Set();let id=groupId||null;while(id&&byId.has(id)&&!seen.has(id)){seen.add(id);result.push(id);id=byId.get(id).parentGroupId||null;}return result;}
  function rootGroupId(groupId,groups){const chain=ancestors(groupId,groups);return chain.length?chain.at(-1):null;}
  function descendantGroupIds(groupId,groups){const{children}=maps(groups),out=new Set(),queue=[groupId];while(queue.length){const id=queue.shift();if(!id||out.has(id))continue;out.add(id);queue.push(...(children.get(id)||[]));}return out;}
  function leafMembers(groupId,groups,elements){const ids=descendantGroupIds(groupId,groups);return(elements||[]).filter(element=>element.groupId&&ids.has(element.groupId));}
  function selectionUnits(items,groups,elements){const keys=new Set(),result=[];for(const element of items||[]){if(!element)continue;const root=rootGroupId(element.groupId,groups),key=root?`g:${root}`:`e:${element.id}`;if(keys.has(key))continue;keys.add(key);result.push({key,groupId:root,members:root?leafMembers(root,groups,elements):[element]});}return result;}
  function expandSelection(items,groups,elements){const ids=new Set(),out=[];for(const unit of selectionUnits(items,groups,elements))for(const element of unit.members)if(!ids.has(element.id)){ids.add(element.id);out.push(element);}return out;}
  function cloneGroupsForElements(items,groups,newId){const sourceGroupIds=new Set();for(const element of items||[])for(const id of ancestors(element.groupId,groups))sourceGroupIds.add(id);const idMap=new Map([...sourceGroupIds].map(id=>[id,newId()])),copies=(groups||[]).filter(group=>sourceGroupIds.has(group.id)).map(group=>({...clone(group),id:idMap.get(group.id),parentGroupId:idMap.get(group.parentGroupId)||null}));return{copies,idMap};}
  const api={ancestors,rootGroupId,descendantGroupIds,leafMembers,selectionUnits,expandSelection,cloneGroupsForElements};globalThis.QDGroups=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})();

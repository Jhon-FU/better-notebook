import { syncTextItem, syncActiveEditor } from './editor-sync.js';

'use strict';
const view=document.getElementById('view');
const world=document.getElementById('world');
const contextBar=document.getElementById('contextBar');
const toastEl=document.getElementById('toast');
const zoomLabel=document.getElementById('zoomLabel');
const statusEl=document.getElementById('status');
const modal=document.getElementById('modal');
const fileInput=document.getElementById('fileInput');

const state={
  items:[], byId:new Map(), images:{}, nextId:1, maxZ:0,
  zoom:1, panX:60, panY:40,
  selectedId:null, editingId:null, paper:'lines',
  history:[], histIdx:-1, saveTimer:null, dirty:false, loaded:false, revision:0
};
let currentFileHandle=null;
let idb=null;
let saveQueue=Promise.resolve();

function $(id){ return document.getElementById(id); }
function clamp(v,a,b){ return Math.min(b,Math.max(a,v)); }
function now(){ const d=new Date(); return d.toTimeString().slice(0,5); }
function toast(msg,dur){ toastEl.textContent=msg; toastEl.classList.add('show'); clearTimeout(toastEl._t); toastEl._t=setTimeout(()=>toastEl.classList.remove('show'), dur||2600); }
function setStatus(text,cls){ statusEl.textContent=text; statusEl.className=cls||''; }
function elOf(id){ return world.querySelector('[data-id="'+id+'"]'); }

/* ---------- 视图：平移 / 缩放 ---------- */
function applyView(){
  world.style.transform='translate('+state.panX+'px,'+state.panY+'px) scale('+state.zoom+')';
  zoomLabel.textContent=Math.round(state.zoom*100)+'%';
  positionContextBar();
}
function zoomAt(cx,cy,nz){
  const r=view.getBoundingClientRect();
  const px=cx-r.left, py=cy-r.top;
  const wx=(px-state.panX)/state.zoom, wy=(py-state.panY)/state.zoom;
  state.zoom=clamp(nz,0.15,3);
  state.panX=px-wx*state.zoom; state.panY=py-wy*state.zoom;
  applyView();
}
function viewCenterStage(){
  const r=view.getBoundingClientRect();
  return { x:(r.width/2-state.panX)/state.zoom, y:(r.height/2-state.panY)/state.zoom };
}
function viewToStage(cx,cy){
  const r=view.getBoundingClientRect();
  return { x:(cx-r.left-state.panX)/state.zoom, y:(cy-r.top-state.panY)/state.zoom };
}
function fitView(){
  if(!state.items.length){ state.zoom=1; state.panX=60; state.panY=40; applyView(); return; }
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  state.items.forEach(it=>{
    const w=it.w||200, h=it.type==='text'?80:(it.h||100);
    minX=Math.min(minX,it.x); minY=Math.min(minY,it.y);
    maxX=Math.max(maxX,it.x+w); maxY=Math.max(maxY,it.y+h);
  });
  const r=view.getBoundingClientRect(), m=80;
  const zx=(r.width-2*m)/(maxX-minX||1), zy=(r.height-2*m)/(maxY-minY||1);
  state.zoom=clamp(Math.min(zx,zy),0.1,1.5);
  state.panX=(r.width-(minX+maxX)*state.zoom)/2;
  state.panY=(r.height-(minY+maxY)*state.zoom)/2;
  applyView();
}

/* ---------- 元素构建 ---------- */
function createItem(type,x,y,opts){
  opts=opts||{};
  const it={ id:state.nextId++, type:type, x:x, y:y, z:++state.maxZ, rot:opts.rot||0 };
  if(type==='text'){
    it.w=opts.w||240; it.html=opts.html||''; it.fontSize=opts.fontSize||18; it.align=opts.align||'left';
  }else{
    it.srcId=opts.srcId;
    const ratio=(opts.h&&opts.w)?opts.h/opts.w:0.75;
    it.w=opts.w||420; it.h=Math.max(80,Math.round(it.w*ratio));
  }
  state.items.push(it); state.byId.set(it.id,it);
  world.appendChild(buildItemEl(it));
  return it;
}
function buildItemEl(it){
  const el=document.createElement('div');
  el.className='item '+(it.type==='text'?'text-item':'img-item');
  el.dataset.id=it.id;
  el.style.left=it.x+'px'; el.style.top=it.y+'px'; el.style.zIndex=it.z;
  if(it.type==='text'){
    el.style.width=it.w+'px';
    const c=document.createElement('div');
    c.className='text-content'; c.contentEditable='false'; c.spellcheck=false;
    c.innerHTML=it.html||'';
    c.style.fontSize=it.fontSize+'px'; c.style.textAlign=it.align||'left';
    el.appendChild(c);
    const dh=document.createElement('div'); dh.className='handle drag-handle'; dh.textContent='⠿'; dh.title='拖动文字';
    el.appendChild(dh);
  }else{
    el.style.width=it.w+'px'; el.style.height=it.h+'px';
    const img=document.createElement('img'); img.src=state.images[it.srcId]||''; img.draggable=false;
    el.appendChild(img);
  }
  const rh=document.createElement('div'); rh.className='handle rotate-handle'; rh.title='旋转';
  const dh2=document.createElement('div'); dh2.className='handle del-handle'; dh2.textContent='×'; dh2.title='删除';
  const sh=document.createElement('div'); sh.className='handle resize-handle'; sh.title='缩放';
  el.appendChild(rh); el.appendChild(dh2); el.appendChild(sh);
  el.style.transform=it.rot?'rotate('+it.rot+'deg)':'';
  bindItem(el,it);
  return el;
}
function bindItem(el,it){
  el.addEventListener('pointerdown',e=>{
    if(e.target.closest('.handle')) return;
    if(it.type==='text' && state.editingId===it.id) return;
    startItemGesture(e,it,false);
  });
  const dragH=el.querySelector('.drag-handle');
  if(dragH) dragH.addEventListener('pointerdown',e=>{ e.stopPropagation(); e.preventDefault(); startItemGesture(e,it,true); });
  el.querySelector('.resize-handle').addEventListener('pointerdown',e=>{ e.stopPropagation(); e.preventDefault(); startResizeGesture(e,it); });
  el.querySelector('.rotate-handle').addEventListener('pointerdown',e=>{ e.stopPropagation(); e.preventDefault(); startRotateGesture(e,it); });
  el.querySelector('.del-handle').addEventListener('pointerdown',e=>{ e.stopPropagation(); e.preventDefault(); deleteItem(it.id); });
  if(it.type==='text'){
    const c=el.querySelector('.text-content');
    c.addEventListener('dblclick',e=>{ e.stopPropagation(); enterEdit(it.id); });
    const onTextChanged=()=>{
      if(state.editingId===it.id && syncTextItem(it,c)) scheduleSave();
    };
    c.addEventListener('input',onTextChanged);
    c.addEventListener('compositionend',onTextChanged);
    c.addEventListener('blur',()=>{ if(state.editingId===it.id) exitEdit(it.id); });
  }
}

/* ---------- 选择 / 浮动工具条 ---------- */
function selectItem(id){
  if(state.editingId && state.editingId!==id) exitEdit(state.editingId);
  if(state.selectedId===id){ bringToFront(id); refreshContextBar(); return; }
  if(state.selectedId){ const p=elOf(state.selectedId); if(p) p.classList.remove('selected'); }
  state.selectedId=id;
  const el=elOf(id); if(el) el.classList.add('selected');
  bringToFront(id);
  refreshContextBar();
}
function deselectAll(){
  if(state.editingId) exitEdit(state.editingId);
  if(state.selectedId){ const el=elOf(state.selectedId); if(el) el.classList.remove('selected'); }
  state.selectedId=null; contextBar.style.display='none';
}
function bringToFront(id){
  const it=state.byId.get(id); if(!it) return;
  it.z=++state.maxZ;
  const el=elOf(id); if(el) el.style.zIndex=it.z;
}
function btn(label,title,fn,danger){
  const b=document.createElement('button');
  b.className='cb-btn'+(danger?' danger':'');
  b.textContent=label; b.title=title||label;
  if(fn) b.addEventListener('click',ev=>{ ev.preventDefault(); fn(); });
  return b;
}
function swatch(color,fn,title){
  const s=document.createElement('button');
  s.className='swatch'; s.style.background=color; s.title=title||'高亮颜色';
  s.addEventListener('click',ev=>{ ev.preventDefault(); fn(); });
  return s;
}
function group(){ const g=document.createElement('div'); g.className='cb-group'; return g; }
function label(t){ const s=document.createElement('span'); s.className='cb-label'; s.textContent=t; return s; }
function refreshContextBar(){
  const id=state.selectedId; const it=id?state.byId.get(id):null;
  if(!id||!it){ contextBar.style.display='none'; return; }
  contextBar.innerHTML='';
  if(it.type==='text'){
    const editing=state.editingId===it.id;
    let g=group();
    const b=btn('B','加粗',()=>{ document.execCommand('bold'); if(state.editingId!==null) scheduleSave(); }); b.style.fontWeight='800';
    g.appendChild(b); contextBar.appendChild(g);
    g=group(); g.appendChild(label('高亮'));
    [['#ffe066','黄'],['#c6f0a0','绿'],['#ffb8d4','粉'],['#a9dcff','蓝']].forEach(x=>g.appendChild(swatch(x[0],()=>applyHighlight(x[0]),'高亮·'+x[1])));
    g.appendChild(swatch('#ffffff',()=>applyHighlight(null),'清除高亮'));
    contextBar.appendChild(g);
    g=group(); g.appendChild(label('颜色'));
    [['#1f2937','黑'],['#dc2626','红'],['#2563eb','蓝'],['#16a34a','绿'],['#d97706','橙']].forEach(x=>g.appendChild(swatch(x[0],()=>applyColor(x[0]),'文字颜色·'+x[1])));
    contextBar.appendChild(g);
    g=group();
    g.appendChild(btn('A−','减小字号',()=>changeFontSize(-2)));
    const sl=btn(it.fontSize+'px','当前字号',null); sl.style.cursor='default'; g.appendChild(sl);
    g.appendChild(btn('A+','增大字号',()=>changeFontSize(2)));
    contextBar.appendChild(g);
    g=group();
    ['left','center','right'].forEach(a=>{
      const ab=btn(a==='left'?'左':(a==='center'?'中':'右'),'对齐·'+a,()=>setAlign(a));
      if(it.align===a) ab.classList.add('active');
      g.appendChild(ab);
    });
    contextBar.appendChild(g);
    g=group();
    if(editing) g.appendChild(btn('完成','退出编辑',()=>exitEdit(it.id)));
    else g.appendChild(btn('编辑','进入编辑模式',()=>enterEdit(it.id)));
    g.appendChild(btn('复制','复制此块',()=>duplicateItem(it.id)));
    g.appendChild(btn('删除','删除此块',()=>deleteItem(it.id),true));
    contextBar.appendChild(g);
  }else{
    let g=group();
    g.appendChild(btn('缩小','贴纸缩小 15%',()=>imgZoom(0.85)));
    const sl=btn(Math.round(it.w)+'px','当前宽度',null); sl.style.cursor='default'; g.appendChild(sl);
    g.appendChild(btn('放大','贴纸放大 15%',()=>imgZoom(1.15)));
    contextBar.appendChild(g);
    g=group(); g.appendChild(btn('⟳ 90°','顺时针旋转 90 度',()=>rotateBy(90))); contextBar.appendChild(g);
    g=group();
    g.appendChild(btn('复制','复制此贴纸',()=>duplicateItem(it.id)));
    g.appendChild(btn('删除','删除此贴纸',()=>deleteItem(it.id),true));
    contextBar.appendChild(g);
  }
  positionContextBar();
}
function positionContextBar(){
  const id=state.selectedId;
  if(!id){ contextBar.style.display='none'; return; }
  const el=elOf(id); if(!el){ contextBar.style.display='none'; return; }
  const r=el.getBoundingClientRect(), vr=view.getBoundingClientRect();
  contextBar.style.display='flex';
  const left=clamp(r.left,8,Math.max(8,vr.width-contextBar.offsetWidth-8));
  let top=r.top-contextBar.offsetHeight-10;
  if(top<vr.top+52) top=Math.min(r.bottom+10,vr.bottom-contextBar.offsetHeight-8);
  contextBar.style.left=left+'px'; contextBar.style.top=Math.max(vr.top+6,top)+'px';
}

/* ---------- 拖拽 / 缩放 / 旋转 ---------- */
let gesture=null;
function startItemGesture(e,it,immediate){
  if(e.pointerType==='mouse' && e.button!==0) return;
  if(state.editingId && state.editingId!==it.id) exitEdit(state.editingId);
  gesture={ kind:'move', id:it.id, sx:e.clientX, sy:e.clientY, ox:it.x, oy:it.y, moved:false, snapped:false, immediate:immediate };
  e.preventDefault();
}
function startResizeGesture(e,it){
  gesture={ kind:'resize', id:it.id, sx:e.clientX, sy:e.clientY, sw:it.w, sh:it.h, moved:false, snapped:false };
}
function startRotateGesture(e,it){
  const r=elOf(it.id).getBoundingClientRect();
  const cx=r.left+r.width/2, cy=r.top+r.height/2;
  gesture={ kind:'rotate', id:it.id, cx:cx, cy:cy, sa:Math.atan2(e.clientY-cy,e.clientX-cx), sr:it.rot, moved:false, snapped:false };
}
window.addEventListener('pointermove',e=>{
  if(!gesture) return;
  const it=state.byId.get(gesture.id); if(!it){ gesture=null; return; }
  const el=elOf(it.id);
  const dx=(e.clientX-gesture.sx)/state.zoom, dy=(e.clientY-gesture.sy)/state.zoom;
  if(gesture.kind==='move'){
    if(!gesture.moved && !gesture.immediate && Math.hypot(e.clientX-gesture.sx,e.clientY-gesture.sy)<3) return;
    if(!gesture.snapped){ gesture.snapped=true; snapshot('移动'); }
    gesture.moved=true;
    it.x=Math.round(gesture.ox+dx); it.y=Math.round(gesture.oy+dy);
    el.style.left=it.x+'px'; el.style.top=it.y+'px';
  }else if(gesture.kind==='resize'){
    if(!gesture.snapped){ gesture.snapped=true; snapshot('缩放'); }
    gesture.moved=true;
    let w=Math.max(it.type==='image'?60:120,gesture.sw+dx);
    if(it.type==='image'){
      const h=Math.max(40,gesture.sh*(w/gesture.sw));
      it.w=Math.round(w); it.h=Math.round(h);
      el.style.width=it.w+'px'; el.style.height=it.h+'px';
    }else{
      it.w=Math.round(w); el.style.width=it.w+'px';
    }
  }else if(gesture.kind==='rotate'){
    if(!gesture.snapped){ gesture.snapped=true; snapshot('旋转'); }
    gesture.moved=true;
    const a=Math.atan2(e.clientY-gesture.cy,e.clientX-gesture.cx);
    let deg=(a-gesture.sa)*180/Math.PI+gesture.sr;
    it.rot=((deg%360)+360)%360;
    el.style.transform='rotate('+it.rot+'deg)';
  }
  positionContextBar();
});
window.addEventListener('pointerup',()=>{
  if(!gesture) return;
  const g=gesture; gesture=null;
  if(g.kind==='move' && g.id) selectItem(g.id);
  if(g.moved) scheduleSave();
});

/* ---------- 空白处平移 ---------- */
let panning=false, panSX=0, panSY=0, panOX=0, panOY=0, bgMoved=false;
world.addEventListener('pointerdown',e=>{
  if(e.target!==world) return;
  if(e.pointerType==='mouse' && e.button!==0) return;
  panning=true; bgMoved=false; panSX=e.clientX; panSY=e.clientY; panOX=state.panX; panOY=state.panY;
  view.classList.add('panning');
});
window.addEventListener('pointermove',e=>{
  if(!panning) return;
  if(Math.hypot(e.clientX-panSX,e.clientY-panSY)>3) bgMoved=true;
  state.panX=panOX+(e.clientX-panSX); state.panY=panOY+(e.clientY-panSY);
  applyView();
});
window.addEventListener('pointerup',()=>{
  if(!panning) return;
  panning=false; view.classList.remove('panning');
  if(!bgMoved) deselectAll();
});
view.addEventListener('wheel',e=>{
  e.preventDefault();
  if(e.ctrlKey) zoomAt(e.clientX,e.clientY,state.zoom*(e.deltaY<0?1.12:1/1.12));
  else{ state.panX-=e.deltaX; state.panY-=e.deltaY; applyView(); }
},{passive:false});

/* ---------- 文本编辑与格式 ---------- */
function enterEdit(id){
  const it=state.byId.get(id); if(!it||it.type!=='text') return;
  if(state.editingId && state.editingId!==id) exitEdit(state.editingId);
  snapshot('编辑');
  state.editingId=id;
  const el=elOf(id), c=el.querySelector('.text-content');
  c.contentEditable='true'; el.classList.add('editing');
  selectItem(id);
  c.focus();
  const range=document.createRange(); range.selectNodeContents(c); range.collapse(false);
  const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  refreshContextBar();
}
function exitEdit(id){
  const it=state.byId.get(id); if(!it||it.type!=='text') return;
  if(state.editingId!==id) return;
  const el=elOf(id), c=el.querySelector('.text-content');
  syncTextItem(it,c);
  c.contentEditable='false'; el.classList.remove('editing');
  state.editingId=null;
  snapshot('编辑');
  scheduleSave();
  refreshContextBar();
}
function wrapSelection(style){
  const sel=window.getSelection(); if(!sel.rangeCount) return;
  const range=sel.getRangeAt(0);
  if(range.collapsed){ document.execCommand('styleWithCSS',false,true); if(style.backgroundColor) document.execCommand('hiliteColor',false,style.backgroundColor); if(style.color) document.execCommand('foreColor',false,style.color); return; }
  const span=document.createElement('span');
  for(const k in style) span.style[k]=style[k];
  try{ range.surroundContents(span); }
  catch(err){
    const frag=range.extractContents(); span.appendChild(frag); range.insertNode(span);
    const r=document.createRange(); r.selectNodeContents(span); sel.removeAllRanges(); sel.addRange(r);
  }
  scheduleSave();
}
function applyHighlight(color){
  const sel=window.getSelection(); if(!sel.rangeCount) return;
  document.execCommand('styleWithCSS',false,true);
  const c=color||'transparent';
  if(sel.getRangeAt(0).collapsed){ document.execCommand('hiliteColor',false,c); return; }
  const ok=document.execCommand('hiliteColor',false,c);
  if(!ok) wrapSelection({backgroundColor:c});
  scheduleSave();
}
function applyColor(color){
  const sel=window.getSelection(); if(!sel.rangeCount) return;
  document.execCommand('styleWithCSS',false,true);
  if(sel.getRangeAt(0).collapsed){ document.execCommand('foreColor',false,color); return; }
  const ok=document.execCommand('foreColor',false,color);
  if(!ok) wrapSelection({color:color});
  scheduleSave();
}
function changeFontSize(delta){
  const it=state.selectedId?state.byId.get(state.selectedId):null;
  if(!it||it.type!=='text') return;
  snapshot('字号');
  it.fontSize=clamp(it.fontSize+delta,10,72);
  const c=elOf(it.id).querySelector('.text-content'); c.style.fontSize=it.fontSize+'px';
  scheduleSave(); refreshContextBar();
}
function setAlign(a){
  const it=state.selectedId?state.byId.get(state.selectedId):null;
  if(!it||it.type!=='text') return;
  snapshot('对齐');
  it.align=a; elOf(it.id).querySelector('.text-content').style.textAlign=a;
  scheduleSave(); refreshContextBar();
}

/* ---------- 添加 / 复制 / 删除 ---------- */
function addTextAt(x,y){
  snapshot('添加文本');
  const it=createItem('text',x,y,{w:240,html:'双击编辑文字内容…',fontSize:18});
  selectItem(it.id); enterEdit(it.id);
  scheduleSave();
}
function addImage(src,nw,nh,point){
  snapshot('添加图片');
  const ratio=(nw>0&&nh>0)?nh/nw:0.75;
  let w=(nw>0&&nh>0&&nw/nh>2.3)?560:420;
  const h=Math.max(80,Math.round(w*ratio));
  const srcId='img'+(state.nextId++);
  state.images[srcId]=src;
  const p=point||viewCenterStage();
  const it=createItem('image',p.x-w/2,p.y-h/2,{w:w,h:h,srcId:srcId});
  selectItem(it.id); scheduleSave();
  return it;
}
function addImageFromDataUrlAt(src,point){
  const im=new Image();
  im.onload=()=>addImage(src,im.naturalWidth,im.naturalHeight,point);
  im.onerror=()=>addImage(src,0,0,point);
  im.src=src;
}
function duplicateItem(id){
  const it=state.byId.get(id); if(!it) return;
  snapshot('复制');
  const copy=createItem(it.type,it.x+24,it.y+24,{w:it.w,h:it.h,rot:it.rot,html:it.html,srcId:it.srcId,fontSize:it.fontSize,align:it.align});
  selectItem(copy.id); scheduleSave(); toast('已复制');
}
function deleteItem(id){
  const it=state.byId.get(id); if(!it) return;
  snapshot('删除');
  if(state.editingId===id) state.editingId=null;
  if(state.selectedId===id){ state.selectedId=null; contextBar.style.display='none'; }
  const el=elOf(id); if(el) el.remove();
  state.items=state.items.filter(i=>i.id!==id); state.byId.delete(id);
  scheduleSave();
}
function imgZoom(k){
  const it=state.selectedId?state.byId.get(state.selectedId):null;
  if(!it||it.type!=='image') return;
  snapshot('缩放');
  it.w=Math.max(60,Math.round(it.w*k)); it.h=Math.max(40,Math.round(it.h*k));
  const el=elOf(it.id); el.style.width=it.w+'px'; el.style.height=it.h+'px';
  scheduleSave(); refreshContextBar();
}
function rotateBy(deg){
  const it=state.selectedId?state.byId.get(state.selectedId):null;
  if(!it) return;
  snapshot('旋转');
  it.rot=(it.rot+deg)%360;
  elOf(it.id).style.transform='rotate('+it.rot+'deg)';
  scheduleSave(); refreshContextBar();
}

/* ---------- 截图裁剪（窗口/屏幕截图后先选范围） ---------- */
const cropModal=$('cropModal'), cropImg=$('cropImg'), cropBox=$('cropBox'), cropSize=$('cropSize');
let cropState=null, cropOp=null;
function openCrop(src,nw,nh){
  cropState={src:src,nw:nw,nh:nh,k:1,rect:null};
  cropImg.onload=()=>{
    const vr=view.getBoundingClientRect();
    const availW=Math.min(vr.width*0.92,1400), availH=Math.min(vr.height*0.78,900);
    const k=Math.min(availW/nw,availH/nh,1);
    cropState.k=k;
    const dw=Math.max(1,Math.round(nw*k)), dh=Math.max(1,Math.round(nh*k));
    cropImg.style.width=dw+'px'; cropImg.style.height=dh+'px';
    const cw=Math.max(40,Math.round(dw*0.9)), ch=Math.max(40,Math.round(dh*0.9));
    cropState.rect={x:Math.round((dw-cw)/2),y:Math.round((dh-ch)/2),w:cw,h:ch};
    positionCropBox(); updateCropSize();
  };
  cropImg.src=src;
  cropModal.classList.add('show');
}
function positionCropBox(){
  const r=cropState.rect;
  cropBox.style.left=r.x+'px'; cropBox.style.top=r.y+'px';
  cropBox.style.width=r.w+'px'; cropBox.style.height=r.h+'px';
}
function updateCropSize(){
  const r=cropState.rect, k=cropState.k;
  cropSize.textContent=Math.max(1,Math.round(r.w/k))+' × '+Math.max(1,Math.round(r.h/k))+' px';
}
function closeCrop(){
  cropModal.classList.remove('show');
  cropImg.onload=null; cropImg.removeAttribute('src');
  cropState=null; cropOp=null;
}
function confirmCrop(){
  if(!cropState || !cropState.rect){ toast('图片还在加载，请稍候再确认'); return; }
  const r=cropState.rect, k=cropState.k;
  const sx=clamp(Math.round(r.x/k),0,cropState.nw-1), sy=clamp(Math.round(r.y/k),0,cropState.nh-1);
  const sw=clamp(Math.round(r.w/k),1,cropState.nw-sx), sh=clamp(Math.round(r.h/k),1,cropState.nh-sy);
  const c=document.createElement('canvas');
  c.width=sw; c.height=sh;
  const img=new Image();
  img.onload=()=>{
    c.getContext('2d').drawImage(img,sx,sy,sw,sh,0,0,sw,sh);
    closeCrop();
    addImage(c.toDataURL('image/jpeg',0.88),sw,sh);
    toast('已按所选范围贴入截图');
  };
  img.src=cropState.src;
}
cropBox.addEventListener('pointerdown',e=>{
  if(!cropState || !cropState.rect) return;
  if(e.target.classList.contains('crop-handle')){
    cropOp={kind:'resize',dir:e.target.dataset.dir,sx:e.clientX,sy:e.clientY,r:{x:cropState.rect.x,y:cropState.rect.y,w:cropState.rect.w,h:cropState.rect.h}};
    e.stopPropagation(); e.preventDefault();
    return;
  }
  cropOp={kind:'move',sx:e.clientX,sy:e.clientY,r:{x:cropState.rect.x,y:cropState.rect.y,w:cropState.rect.w,h:cropState.rect.h}};
  e.preventDefault();
});
window.addEventListener('pointermove',e=>{
  if(!cropOp||!cropState) return;
  const r0=cropOp.r, min=20;
  const dx=e.clientX-cropOp.sx, dy=e.clientY-cropOp.sy;
  const maxW=cropImg.clientWidth, maxH=cropImg.clientHeight;
  let x=r0.x,y=r0.y,w=r0.w,h=r0.h;
  if(cropOp.kind==='move'){
    x=clamp(r0.x+dx,0,maxW-r0.w);
    y=clamp(r0.y+dy,0,maxH-r0.h);
  }else{
    const d=cropOp.dir;
    if(d.indexOf('e')>=0) w=clamp(r0.w+dx,min,maxW-r0.x);
    if(d.indexOf('s')>=0) h=clamp(r0.h+dy,min,maxH-r0.y);
    if(d.indexOf('w')>=0){ const nx=clamp(r0.x+dx,0,r0.x+r0.w-min); x=nx; w=r0.w+(r0.x-nx); }
    if(d.indexOf('n')>=0){ const ny=clamp(r0.y+dy,0,r0.y+r0.h-min); y=ny; h=r0.h+(r0.y-ny); }
  }
  cropState.rect={x:x,y:y,w:w,h:h};
  positionCropBox(); updateCropSize();
});
window.addEventListener('pointerup',()=>{ cropOp=null; });
$('cropCancel').addEventListener('click',closeCrop);
$('cropOk').addEventListener('click',confirmCrop);

/* ---------- 截图 / 剪贴板 / 拖放 ---------- */
async function captureScreen(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){ toast('当前浏览器不支持屏幕截图'); return; }
  let stream=null;
  try{
    stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:10}},audio:false});
    const video=document.createElement('video');
    video.srcObject=stream; video.muted=true;
    await video.play();
    await new Promise(res=>{ if(video.requestVideoFrameCallback) video.requestVideoFrameCallback(()=>res()); else setTimeout(res,400); });
    let w=video.videoWidth||1920, h=video.videoHeight||1080;
    const s=Math.min(1,2200/w,1600/h);
    const c=document.createElement('canvas');
    c.width=Math.round(w*s); c.height=Math.round(h*s);
    c.getContext('2d').drawImage(video,0,0,c.width,c.height);
    stream.getTracks().forEach(t=>t.stop()); stream=null;
    openCrop(c.toDataURL('image/jpeg',0.88),c.width,c.height);
    toast('拖动选区或调整四角，确认后贴入');
  }catch(err){
    if(stream) stream.getTracks().forEach(t=>t.stop());
    if(err && (err.name==='NotAllowedError'||err.name==='AbortError')){ toast('已取消截图'); return; }
    toast('截图失败：'+(err&&err.message?err.message:err));
  }
}
function blobToDataUrl(blob){
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(blob); });
}
async function readClipboardImage(){
  try{
    if(!navigator.clipboard || !navigator.clipboard.read){ toast('请直接使用 Ctrl+V 粘贴'); return; }
    const items=await navigator.clipboard.read();
    let got=false;
    for(const item of items){
      const type=item.types.find(t=>t.indexOf('image/')===0);
      if(type){ const blob=await item.getType(type); addImageFromDataUrlAt(await blobToDataUrl(blob),viewCenterStage()); got=true; break; }
    }
    if(!got) toast('剪贴板中没有图片');
  }catch(err){ toast('无法读取剪贴板：'+(err.message||err)+'（可 Win+Shift+S 截图后 Ctrl+V）'); }
}

/* ---------- 历史（撤销 / 重做） ---------- */
function snapshot(label){
  state.history=state.history.slice(0,state.histIdx+1);
  state.history.push(JSON.stringify({items:state.items.map(i=>({id:i.id,type:i.type,x:i.x,y:i.y,w:i.w,h:i.h,rot:i.rot,z:i.z,html:i.html,srcId:i.srcId,fontSize:i.fontSize,align:i.align})),paper:state.paper}));
  if(state.history.length>40) state.history.shift();
  state.histIdx=state.history.length-1;
}
function undo(){ if(state.editingId||state.histIdx<=0) return; state.histIdx--; applyHistory(); }
function redo(){ if(state.editingId||state.histIdx>=state.history.length-1) return; state.histIdx++; applyHistory(); }
function applyHistory(){
  const data=JSON.parse(state.history[state.histIdx]);
  rebuildItems(data.items,data.paper);
  scheduleSave();
}
function rebuildItems(items,paper){
  state.items=[]; state.byId.clear();
  world.querySelectorAll('.item').forEach(el=>el.remove());
  state.nextId=1; state.maxZ=0;
  items.forEach(raw=>{
    if(raw.id>=state.nextId) state.nextId=raw.id+1;
    if(raw.z>state.maxZ) state.maxZ=raw.z;
    const it={id:raw.id,type:raw.type,x:raw.x,y:raw.y,w:raw.w,h:raw.h,rot:raw.rot||0,z:raw.z,html:raw.html,srcId:raw.srcId,fontSize:raw.fontSize||18,align:raw.align||'left'};
    state.items.push(it); state.byId.set(it.id,it);
    world.appendChild(buildItemEl(it));
  });
  state.selectedId=null; state.editingId=null; contextBar.style.display='none';
  setPaper(paper||state.paper);
  applyView();
}

/* ---------- 持久化 ---------- */
function serializeForSave(){
  // Ctrl+S, Save As and export must include the editor's visible contents,
  // even when a browser formatting command did not dispatch an input event.
  if(syncActiveEditor(state,elOf)){
    state.dirty=true;
    state.revision++;
  }
  const used={};
  state.items.forEach(it=>{ if(it.srcId && state.images[it.srcId]) used[it.srcId]=state.images[it.srcId]; });
  return {version:1,paper:state.paper,items:state.items.map(i=>({id:i.id,type:i.type,x:i.x,y:i.y,w:i.w,h:i.h,rot:i.rot,z:i.z,html:i.html,srcId:i.srcId,fontSize:i.fontSize,align:i.align})),images:used};
}
function applySavedData(data){
  if(!data || !Array.isArray(data.items)) return false;
  state.images=data.images||{};
  rebuildItems(data.items,data.paper||'lines');
  return true;
}
function idbOpen(){
  return new Promise((res,rej)=>{
    const req=indexedDB.open('lingdong-notes-db',1);
    req.onupgradeneeded=()=>{ const d=req.result; if(!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); };
    req.onsuccess=()=>res(req.result);
    req.onerror=()=>rej(req.error);
  });
}
function idbSet(key,val){
  return new Promise((res,rej)=>{
    const tx=idb.transaction('kv','readwrite');
    tx.objectStore('kv').put(val,key);
    tx.oncomplete=()=>res();
    tx.onerror=()=>rej(tx.error);
  });
}
function idbGet(key){
  return new Promise((res,rej)=>{
    const tx=idb.transaction('kv','readonly');
    const rq=tx.objectStore('kv').get(key);
    rq.onsuccess=()=>res(rq.result);
    rq.onerror=()=>rej(rq.error);
  });
}
async function restoreCustomFile(){
  try{
    idb=await idbOpen();
    const handle=await idbGet('currentFile');
    if(!handle) return false;
    const perm=await handle.queryPermission({mode:'readwrite'});
    if(perm!=='granted'){ toast('上次的自定义笔记文件需要重新授权，可点「打开」重新选择'); return false; }
    currentFileHandle=handle;
    const file=await handle.getFile();
    const data=JSON.parse(await file.text());
    if(applySavedData(data)){ state.loaded=true; setStatus('已打开 '+handle.name,'ok'); return true; }
  }catch(e){}
  return false;
}
function saveNow(){
  clearTimeout(state.saveTimer);
  state.saveTimer=null;
  const body=JSON.stringify(serializeForSave());
  const revision=state.revision, fileHandle=currentFileHandle;
  const markSaved=message=>{
    if(currentFileHandle!==fileHandle) return;
    state.dirty=state.revision!==revision;
    setStatus(state.dirty?'有新修改，等待保存':message,state.dirty?'warn':'ok');
  };
  const write=async()=>{
    if(currentFileHandle===fileHandle) setStatus('正在保存…','warn');
    if(fileHandle){
      try{
        const w=await fileHandle.createWritable();
        await w.write(body);
        await w.close();
        markSaved('已保存到 '+fileHandle.name+' '+now());
      }catch(err){
        if(currentFileHandle===fileHandle) setStatus('自定义文件保存失败：'+(err.message||err),'err');
      }
      return;
    }
    try{
      const res=await fetch('/notes.json',{method:'PUT',headers:{'Content-Type':'application/json'},body:body});
      if(!res.ok) throw new Error('HTTP '+res.status);
      markSaved('已保存到默认位置 '+now());
    }catch(err){
      try{ localStorage.setItem('lingdong-notes',body); setStatus('服务器不可用，已保存到浏览器本地','warn'); }
      catch(e2){ setStatus('保存失败','err'); }
    }
  };
  // Preserve write order when Ctrl+S overlaps an autosave or a slow disk write.
  const pending=saveQueue.then(write,write);
  saveQueue=pending;
  return pending;
}
function scheduleSave(){
  state.dirty=true;
  state.revision++;
  setStatus('未保存','warn');
  clearTimeout(state.saveTimer);
  state.saveTimer=setTimeout(()=>{ if(state.loaded) saveNow(); },900);
}
async function loadNotes(){
  if(await restoreCustomFile()) return;
  try{
    const res=await fetch('/notes.json',{cache:'no-store'});
    if(res.ok){ const data=await res.json(); if(applySavedData(data)){ state.loaded=true; return; } }
  }catch(e){}
  try{
    const ls=localStorage.getItem('lingdong-notes');
    if(ls){ const data=JSON.parse(ls); if(applySavedData(data)){ state.loaded=true; return; } }
  }catch(e){}
  state.loaded=true;
  createItem('text',170,120,{w:520,html:'<b>欢迎使用灵动笔记 📒</b>',fontSize:26});
  createItem('text',170,195,{w:640,html:'<b>快速上手</b><br>• 双击文字即可编辑内容，按住文字可自由拖动<br>• 点工具栏「📷 截图」截屏，或 Win+Shift+S 后 Ctrl+V 粘贴<br>• 选中文字用浮动工具条加粗 / 高亮 / 改颜色 / 调字号<br>• 选中贴纸后拖右下角缩放、顶部圆点旋转<br>• 拖空白处移动视角，Ctrl+滚轮缩放<br>• 内容会自动保存到程序目录下的 notes.json',fontSize:15});
  scheduleSave();
}

async function openWithPicker(){
  if(window.showOpenFilePicker){
    try{
      const [handle]=await window.showOpenFilePicker({types:[{description:'JSON 笔记',accept:{'application/json':['.json']}}]});
      const file=await handle.getFile();
      const data=JSON.parse(await file.text());
      if(!confirm('打开该笔记将替换当前内容，确定继续吗？')) return;
      snapshot('打开');
      applySavedData(data);
      currentFileHandle=handle;
      setStatus('已打开 '+handle.name,'ok');
      scheduleSave();
      toast('已打开：'+handle.name);
      try{ idb=idb||await idbOpen(); await idbSet('currentFile',handle); }catch(e){}
    }catch(err){
      if(err && err.name==='AbortError') return;
      toast('打开失败：'+(err.message||err));
    }
    return;
  }
  fileInput.click();
}
async function saveAs(){
  if(!window.showSaveFilePicker){
    toast('当前浏览器不支持自定义保存位置，已按默认位置保存');
    saveNow();
    return;
  }
  try{
    const d=new Date(), p=n=>String(n).padStart(2,'0');
    const handle=await window.showSaveFilePicker({
      suggestedName:'灵动笔记-'+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'.json',
      types:[{description:'JSON 笔记',accept:{'application/json':['.json']}}]
    });
    const w=await handle.createWritable();
    const body=JSON.stringify(serializeForSave(),null,2);
    const revision=state.revision;
    await w.write(body);
    await w.close();
    currentFileHandle=handle;
    state.dirty=state.revision!==revision;
    setStatus('已另存为 '+handle.name+(state.dirty?'（有新修改待保存）':''),state.dirty?'warn':'ok');
    if(state.dirty) scheduleSave();
    toast('已保存到：'+handle.name);
    try{ idb=idb||await idbOpen(); await idbSet('currentFile',handle); }catch(e){}
  }catch(err){
    if(err && err.name==='AbortError'){ toast('已取消另存为'); return; }
    toast('另存为失败：'+(err.message||err));
  }
}

/* ---------- 工具栏 ---------- */
function bindToolbar(){
  $('btnNew').addEventListener('click',()=>{
    if(!confirm('确定清空当前笔记，新建空白笔记吗？')) return;
    snapshot('新建');
    state.items=[]; state.byId.clear();
    world.querySelectorAll('.item').forEach(el=>el.remove());
    state.selectedId=null; state.editingId=null; contextBar.style.display='none';
    scheduleSave();
  });
  $('btnOpen').addEventListener('click',()=>openWithPicker());
  fileInput.addEventListener('change',()=>{
    const f=fileInput.files[0]; if(!f) return;
    const rd=new FileReader();
    rd.onload=()=>{
      try{
        const data=JSON.parse(rd.result);
        if(!confirm('导入备份将替换当前笔记，确定继续吗？')) return;
        snapshot('导入');
        applySavedData(data);
        scheduleSave(); toast('备份已导入');
      }catch(e){ toast('备份文件格式不正确'); }
    };
    rd.readAsText(f);
    fileInput.value='';
  });
  $('btnSave').addEventListener('click',()=>saveNow());
  $('btnSaveAs').addEventListener('click',()=>saveAs());
  $('btnExport').addEventListener('click',()=>{
    const blob=new Blob([JSON.stringify(serializeForSave(),null,2)],{type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    const d=new Date(), p=n=>String(n).padStart(2,'0');
    a.download='灵动笔记备份-'+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+'.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),2000);
    toast('备份已导出');
  });
  $('btnText').addEventListener('click',()=>{
    const c=viewCenterStage();
    addTextAt(c.x-120,c.y-30);
  });
  $('btnCapture').addEventListener('click',()=>captureScreen());
  $('btnClipboard').addEventListener('click',()=>readClipboardImage());
  $('btnZoomIn').addEventListener('click',()=>{ const r=view.getBoundingClientRect(); zoomAt(r.left+r.width/2,r.top+r.height/2,state.zoom*1.2); });
  $('btnZoomOut').addEventListener('click',()=>{ const r=view.getBoundingClientRect(); zoomAt(r.left+r.width/2,r.top+r.height/2,state.zoom/1.2); });
  $('btnFit').addEventListener('click',fitView);
  $('btnReset').addEventListener('click',()=>{ state.zoom=1; state.panX=60; state.panY=40; applyView(); });
  document.querySelectorAll('.paper-btn').forEach(b=>b.addEventListener('click',()=>setPaper(b.dataset.paper)));
  $('btnHelp').addEventListener('click',()=>modal.classList.add('show'));
  document.querySelector('.modal-close').addEventListener('click',()=>modal.classList.remove('show'));
  modal.addEventListener('click',e=>{ if(e.target===modal) modal.classList.remove('show'); });
}

/* ---------- 全局事件 ---------- */
function bindGlobal(){
  contextBar.addEventListener('mousedown',e=>e.preventDefault());
  document.addEventListener('paste',e=>{
    const ae=document.activeElement;
    if(ae && (ae.isContentEditable || ae.tagName==='INPUT' || ae.tagName==='TEXTAREA')) return;
    const items=e.clipboardData && e.clipboardData.items;
    if(!items) return;
    for(const item of items){
      if(item.type && item.type.indexOf('image/')===0){
        e.preventDefault();
        const f=item.getAsFile(); if(!f) continue;
        const rd=new FileReader();
        rd.onload=()=>addImageFromDataUrlAt(rd.result,viewCenterStage());
        rd.readAsDataURL(f);
        toast('图片已粘贴');
        return;
      }
    }
  });
  view.addEventListener('dragover',e=>{ e.preventDefault(); $('dropHint').style.display='block'; });
  view.addEventListener('dragleave',e=>{ $('dropHint').style.display='none'; });
  view.addEventListener('drop',e=>{
    e.preventDefault(); $('dropHint').style.display='none';
    const p=viewToStage(e.clientX,e.clientY);
    for(const f of e.dataTransfer.files){
      if(f.type && f.type.indexOf('image/')===0){
        const rd=new FileReader();
        rd.onload=()=>addImageFromDataUrlAt(rd.result,p);
        rd.readAsDataURL(f);
      }
    }
  });
  document.addEventListener('keydown',e=>{
    const editing=state.editingId!==null;
    if(cropState && e.key==='Escape'){ e.preventDefault(); closeCrop(); return; }
    if(e.ctrlKey && e.key.toLowerCase()==='s'){ e.preventDefault(); saveNow(); return; }
    if(e.ctrlKey && e.key.toLowerCase()==='z'){ e.preventDefault(); if(e.shiftKey) redo(); else undo(); return; }
    if(e.ctrlKey && e.key.toLowerCase()==='y'){ e.preventDefault(); redo(); return; }
    if(e.ctrlKey && e.key.toLowerCase()==='d' && !editing){ e.preventDefault(); if(state.selectedId) duplicateItem(state.selectedId); return; }
    if(editing) return;
    if((e.key==='Delete'||e.key==='Backspace') && state.selectedId){ e.preventDefault(); deleteItem(state.selectedId); }
    if(e.key==='Escape') deselectAll();
  });
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden && state.dirty) saveNow();
  });
  window.addEventListener('beforeunload',()=>{
    if(!state.dirty || currentFileHandle) return;
    try{ navigator.sendBeacon('/notes.json',new Blob([JSON.stringify(serializeForSave())],{type:'application/json'})); }catch(e){}
  });
}

/* ---------- 纸张样式 ---------- */
function setPaper(kind){
  state.paper=kind;
  world.className='paper-'+kind;
  document.querySelectorAll('.paper-btn').forEach(b=>b.classList.toggle('active',b.dataset.paper===kind));
  scheduleSave();
}

/* ---------- 启动 ---------- */
function init(){
  bindToolbar();
  bindGlobal();
  applyView();
  loadNotes().then(()=>{ document.body.dataset.ready='1'; });
}
init();

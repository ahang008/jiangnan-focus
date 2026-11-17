/* 江南入夜 · 主程序：把数据层接到场景、船队、奖励和界面上；主循环和省电 */
(function(){
'use strict';
const SC=JN.Scene; if(!SC) return;
const D=JN.Data, F=JN.Fleet, RW=JN.Rewards, A=JN.Audio, UI=JN.UI, SKY=JN.Sky, MUYU=JN.Muyu;
/* 反馈方式：设置里的 feedbackStyle；演示模式可用 ?fb=muyu|lantern|both 临时覆盖 */
const FB_FIX=new URLSearchParams(location.search).get('fb');
const FBS=['lantern','muyu','both'];
const fbStyle=s=>D.mode==='demo'&&FBS.includes(FB_FIX)?FB_FIX:(FBS.includes(s.settings.feedbackStyle)?s.settings.feedbackStyle:'lantern');
/* 出效果图用（只在演示模式）：?hide=hint,views,focus,ribbon,topbar,brand 隐藏无关的界面 */
if(D.mode==='demo'){ const h=new URLSearchParams(location.search).get('hide'); if(h) for(const id of h.split(',')){ const el=document.getElementById(id.trim()); if(el) el.style.visibility='hidden'; } }
/* 奖励系统暂不启用（不弹三选一、不显示收藏、不加载任何模型），代码保留；
   进度由孔明灯和灯笼表现 */
const REWARDS_ON=false;
const LOG_MAX=Math.log10(1+3e7);
const SKY_FIX=parseFloat(new URLSearchParams(location.search).get('sky')); // 调试用：?sky=0.05 固定天色

/* ---------- 当天亮过的窗户：存在本机，刷新不丢 ---------- */
const WKEY='jnfocus.windows';
const today=()=>{ const d=new Date(); return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); };
let win={date:today(),lit:[]};
try{ const w=JSON.parse(localStorage.getItem(WKEY)||'null'); if(w&&w.date===today()&&Array.isArray(w.lit)) win=w; }catch(e){}
if(D.mode==='demo') win={date:today(),lit:[]}; // 演示每次从头来
SC.resetWindows(win.lit);
function saveWin(){ if(D.mode==='demo') return; try{ localStorage.setItem(WKEY,JSON.stringify(win)); }catch(e){} }
F.onWindowLit=i=>{ if(!win.lit.includes(i)){ win.lit.push(i); saveWin(); } };

/* ---------- state ---------- */
let first=true, anyActive=false;
function onState(s){
  if(win.date!==today()){ win={date:today(),lit:[]}; SC.resetWindows(null); saveWin(); }
  F.sync(s);
  const r=Math.min(1,Math.log10(1+Math.max(0,s.today.tokens||0))/LOG_MAX);
  SC.G.timeTarget=Number.isFinite(SKY_FIX)?SKY_FIX:(0.10*r); // 天一直是黄昏常亮，token 只让太阳从午后慢慢落到黄昏（0 到 0.10），进度由灯笼逐盏点亮体现
  SC.G.lampFrac=r;
  if(first){ SC.G.timeSnap=true; SC.snapLamps(); }
  /* 换了浏览器、本机记录丢了：按今天改过的文件数补亮（不闪光） */
  const files=s.sessions.reduce((a,x)=>a+(x.files||0),0);
  if(D.mode!=='demo'&&win.lit.length<files){
    for(let k=win.lit.length;k<Math.min(files,SC.windowCount);k++){ const i=SC.lightWindow(null,true); if(i<0) break; win.lit.push(i); }
    saveWin();
  }
  anyActive=s.sessions.some(x=>x.active);
  SC.G.lampLevel=REWARDS_ON?Math.max(s.lanternLevel|0,s.owned.filter(x=>String(x).startsWith('lantern')).length):0;
  if(REWARDS_ON) RW.apply(s.owned,UI.hidden());
  const fb=fbStyle(s);
  if(SKY){ SKY.setStyle(fb); SKY.onTokens(s.today.tokens,D.mode==='demo',s.settings.lanternUnit); }
  if(JN.Board) JN.Board.update(s,SC.elapsed);
  if(JN.Night) JN.Night.feed(s.now,s.today.tokens||0);
  if(MUYU){ MUYU.setEnabled(fb!=='lantern'); MUYU.onTokens(s.today.tokens,D.mode==='demo',s.settings.lanternUnit); }
  UI.onState(s);
  first=false;
}
let lastBeat=-1e9;
function onBeat(b){
  lastBeat=performance.now();
  if(b.kind==='segment_done'){ A.bell(true); UI.onSegmentDone(); return; } // 一段专注完成：轻轻一声钟
  F.beat(b);
}
D.on('state',onState);
D.on('beat',onBeat);
D.on('status',UI.onStatus);
D.start([]);
/* 正常模式在连上本地小程序前，也先把空记录界面画出来（零记录引导、0 token 等） */
if(D.state) UI.onState(D.state);
UI.onStatus({connected:D.connected});

if(REWARDS_ON){
  fetch('rewards.json',{cache:'no-cache'}).then(r=>r.json()).catch(()=>[]).then(defs=>{
    defs=Array.isArray(defs)?defs:[];
    D.setRewardIds(defs.map(d=>d.id));
    RW.init(defs); UI.init(defs);
    if(D.state) RW.apply(D.state.owned,UI.hidden());
  });
}

/* ---------- 交互记录（有交互时满帧） ---------- */
let lastInteract=-1e9;
const mark=()=>{ lastInteract=performance.now(); };
['pointerdown','pointermove','wheel','keydown','touchstart'].forEach(ev=>addEventListener(ev,e=>{ if(ev!=='pointermove'||e.buttons) mark(); },{passive:true}));

/* ---------- 主循环：requestAnimationFrame + performance.now ---------- */
let lastT=null, lastRender=-1e9, fpsAcc=0, fpsN=0, fpsTimer=0;
function loop(){
  requestAnimationFrame(loop);
  const now=performance.now();
  D.tick(now);
  UI.tick(now);
  if(document.hidden){ lastT=now; return; }
  /* 弹窗只在刚弹出的 2.5 秒里算交互；静止的弹窗不阻止降帧 */
  const interactive=(now-lastInteract<2500)||SC.isMoving()||(UI.modalOpen()&&now-UI.modalSince()<2500);
  const busy=anyActive||F.busy()||(now-lastBeat<3000)||(SKY&&SKY.busy())||(MUYU&&MUYU.busy());
  const gap=interactive?0:busy?1000/30-3:1000/20-3;
  if(now-lastRender<gap) return;
  if(lastT==null) lastT=now;
  const dt=Math.min(0.1,Math.max(0,(now-lastT)/1000)); lastT=now; lastRender=now;
  const n=SC.preUpdate(dt);
  F.update(dt,n);
  if(REWARDS_ON) RW.update(dt,n,SC.elapsed);
  if(SKY) SKY.update(dt,n,SC.elapsed);
  if(MUYU) MUYU.update(dt,SC.elapsed);
  if(JN.Night) JN.Night.update(dt,SC.elapsed);
  A.update(SC.elapsed,n);
  SC.postUpdate(dt);
  SC.render();
  /* 自适应分辨率（沿用原网页，只在不限帧时判断） */
  if(gap===0&&dt>0&&!SC.ULTRA){
    fpsAcc+=dt; fpsN++; fpsTimer+=dt;
    if(fpsTimer>3){
      const pr=SC.renderer.getPixelRatio();
      if(fpsAcc/fpsN>0.037&&pr>1.01){ SC.renderer.setPixelRatio(Math.max(1,pr-0.25)); SC.onResize(); }
      fpsAcc=0; fpsN=0; fpsTimer=0;
    }
  }else{ fpsAcc=0; fpsN=0; fpsTimer=0; }
}
requestAnimationFrame(loop);

/* ---------- 给验收工具的接口 ---------- */
window.__app={scene:SC.scene,camera:SC.camera,controls:SC.controls,renderer:SC.renderer,setView:SC.setView,data:D,fleet:F,rewards:RW,ui:UI,sky:SKY,muyu:MUYU,board:JN.Board,night:JN.Night,recap:JN.Recap,sceneApi:SC};
})();

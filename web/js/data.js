/* 江南入夜 · 数据层
   正常模式：同源 /api/state + /api/events（SSE），断线自动重连
   演示模式 ?demo=1：完全不请求 /api，内置模拟器按 DESIGN.md 第七节的格式产生 state 和 beat
   其余代码只通过 on('state'|'beat'|'status') 订阅，不关心数据从哪来 */
window.JN = window.JN || {};
JN.Data = (function(){
'use strict';
const params=new URLSearchParams(location.search);
const DEMO=params.get('demo')==='1';
const DEFAULT_SETTINGS={activeMin:3,segmentMin:25,gapMin:5,endMin:10,presentOnly:false,volume:0.3,muted:false,lanternUnit:1000,feedbackStyle:'lantern'};
const listeners={state:[],beat:[],status:[]};
const SOURCES=['claude','codex','deepseek','grok','magpie','cursor'];
const api={mode:DEMO?'demo':'live', state:null, connected:DEMO, lastStateAt:0, DEFAULT_SETTINGS};
let rewardIds=[];

function on(ev,fn){ (listeners[ev]=listeners[ev]||[]).push(fn); }
function emit(ev,x){ for(const f of listeners[ev]||[]) f(x); }
function emptyState(){
  return {now:Date.now(),present:true,idleSec:0,sessions:[],
    today:{tokens:0,aiMinutes:0,presentFocusMin:0,soloFocusMin:0,segments:0},
    segment:{progressMin:0,targetMin:DEFAULT_SETTINGS.segmentMin,idleMin:0},
    pendingRewards:0,owned:[],settings:Object.assign({},DEFAULT_SETTINGS)};
}
/* 容错：字段缺了就用默认值补上 */
function normalize(s){
  const e=emptyState();
  const o=Object.assign(e,s||{});
  o.today=Object.assign(emptyState().today,(s&&s.today)||{});
  /* 六个平台的今日统计：缺哪个补 0（老版本服务端没有 bySource 时全是 0） */
  const bs={}; for(const k of SOURCES){ const v=(o.today.bySource||{})[k]||{}; bs[k]={tokens:+v.tokens||0,sessions:+v.sessions||0,tools:+v.tools||0}; }
  o.today.bySource=bs;
  o.segment=Object.assign(emptyState().segment,(s&&s.segment)||{});
  o.settings=Object.assign({},DEFAULT_SETTINGS,(s&&s.settings)||{});
  o.sessions=Array.isArray(o.sessions)?o.sessions:[];
  o.owned=Array.isArray(o.owned)?o.owned:[];
  return o;
}
function setState(s){ api.state=normalize(s); api.lastStateAt=performance.now(); emit('state',api.state); }
/* 只接受更新的快照：同一次启动（boot）里 rev 只能往上走；服务端重启后 boot 变了，重新计 */
let ver={boot:null,rev:-1};
function acceptState(s){
  if(!s||!s.sessions) return false;
  if(typeof s.rev==='number'){
    if(s.boot===ver.boot&&s.rev<=ver.rev) return false;
    ver={boot:s.boot,rev:s.rev};
  }
  setState(s); return true;
}
function setConnected(c){ if(api.connected!==c){ api.connected=c; emit('status',{connected:c}); } }
function normalizeOffer(res){
  let arr=Array.isArray(res)?res:(res&&(res.options||res.offer||res.choices||res.rewards||res.items))||[];
  return arr.map(x=>typeof x==='string'?x:(x&&x.id)).filter(Boolean).slice(0,3);
}

/* ================= 正常模式 ================= */
let es=null, retryMs=2000, retryTimer=0, gen=0, watchFrom=0;
/* 每次连接一个代次：旧连接、旧请求迟到的数据一律丢掉 */
function connect(){
  clearTimeout(retryTimer);
  if(es){ es.close(); es=null; }
  const my=++gen; watchFrom=performance.now();
  const onState=s=>{ if(my!==gen) return; if(acceptState(s)) { setConnected(true); flushSettings(); } };
  fetch('/api/state',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(s=>{ if(s) onState(s); }).catch(()=>{});
  try{ es=new EventSource('/api/events'); }catch(e){ retry(); return; }
  const me=es;
  es.addEventListener('state',e=>{ try{ onState(JSON.parse(e.data)); }catch(_){} });
  es.addEventListener('beat',e=>{ if(my!==gen) return; try{ emit('beat',JSON.parse(e.data)); }catch(_){} });
  es.onmessage=e=>{ if(my!==gen) return; try{ const d=JSON.parse(e.data); if(d&&d.kind) emit('beat',d); else if(d&&d.sessions) onState(d); }catch(_){} };
  es.onopen=()=>{ retryMs=2000; };
  es.onerror=()=>{
    if(my!==gen) return;
    setConnected(false);
    if(me.readyState===2){ me.close(); if(es===me) es=null; retry(); }
  };
}
function retry(){ clearTimeout(retryTimer); retryTimer=setTimeout(connect,retryMs); retryMs=Math.min(15000,retryMs*1.6); }
/* 连接看着开着却 9 秒没有 state：关掉重连（统一退避） */
function watchdog(now){
  const last=Math.max(api.lastStateAt||0,watchFrom);
  if(now-last<9000) return;
  setConnected(false);
  watchFrom=now; gen++;
  if(es){ es.close(); es=null; }
  retry();
}
function post(path,body){
  return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})})
    .then(r=>{ if(!r.ok) throw new Error('http '+r.status); return r.json().catch(()=>null); });
}

/* ================= 演示模式：模拟器 ================= */
const LS='jnfocus.demo.v1';
function rng(seed){ return function(){ seed|=0; seed=seed+0x6D2B79F5|0; let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
const R=rng(20261117);
const LABELS=['blog','shop-app','landing','data-pipeline','game-jam','notes','api-server','docs'];
/* 演示：八个会话分到六个平台上（Cursor 也给一条，真实环境里它通常是 0） */
const SLOT_SRC=['claude','codex','deepseek','grok','magpie','cursor','claude','codex'];
const START=[0.6,2.4,4.6,10,17,25,34,46];
const LIFE=[200,72,240,130,110,190,60,88];
const TOOLS=['Read','Edit','Bash','Grep','Write','Glob','Read','Edit','Bash'];
let sim=null;
function simInit(){
  let saved={}; try{ saved=JSON.parse(localStorage.getItem(LS)||'{}')||{}; }catch(e){}
  const day=new Date().toDateString(), st=saved.day===day?(saved.stats||{}):{};
  sim={owned:Array.isArray(saved.owned)?saved.owned:[],lantern:saved.lantern|0,settings:Object.assign({},DEFAULT_SETTINGS,saved.settings||{}),
    pending:saved.pending|0,segments:st.segments|0,progress:0,idle:0,activeSec:0,tokenBase:950000,nextBurst:1.5,tokenOverride:null,present:true,
    ai:+st.ai||0,presentMin:+st.presentMin||0,solo:+st.solo||0,by:Object.fromEntries(SOURCES.map(k=>[k,{tokens:0,sessions:0,tools:0}])),t:0,last:null,lastEmit:-9,endedList:[],frozen:false,
    slots:LABELS.map((l,i)=>({label:l,i,gen:0,next:START[i],sess:null}))};
  /* 起步的 95 万按一个常见的比例分到各平台（Cursor 留 0） */
  const share={claude:0.52,codex:0.2,deepseek:0.11,grok:0.09,magpie:0.08,cursor:0};
  for(const k of SOURCES) sim.by[k].tokens=Math.round(sim.tokenBase*share[k]);
}
/* 演示存档：收藏、灯笼级、设置、待领，以及当天的专注统计（换天清零） */
function simSave(){ try{ localStorage.setItem(LS,JSON.stringify({owned:sim.owned,lantern:sim.lantern,settings:sim.settings,pending:sim.pending,
  day:new Date().toDateString(),stats:{segments:sim.segments,ai:sim.ai,presentMin:sim.presentMin,solo:sim.solo}})); }catch(e){} }
/* 演示：token 一阵一阵地涨（每 2 到 6 秒来一阵 2000 到 8000），看得到孔明灯齐射；
   从 95 万起步，半分钟左右碰到 100 万 */
function simTokens(){
  if(sim.tokenOverride!=null) return sim.tokenOverride;
  return Math.floor(sim.tokenBase);
}
function simState(){
  const now=Date.now();
  const sessions=[];
  for(const sl of sim.slots){ const s=sl.sess; if(!s) continue;
    sessions.push({id:s.id,source:s.source,label:sl.label,startedAt:s.startedAt,lastAt:s.lastAt,active:s.active,
      tools:s.tools,files:s.files,subagents:s.subagents,tokens:s.tokens}); }
  for(const s of sim.endedList) sessions.push(s);
  if(churn){ for(const s of churn.live) sessions.push(Object.assign({},s)); for(const s of churn.dead.slice(-24)) sessions.push(Object.assign({},s)); }
  const tgt=sim.settings.segmentMin;
  return {now,present:sim.present,idleSec:sim.present?3:420,sessions,
    today:{bySource:JSON.parse(JSON.stringify(sim.by)),tokens:simTokens(),aiMinutes:Math.round(sim.ai*10)/10,presentFocusMin:Math.round(sim.presentMin*10)/10,soloFocusMin:Math.round(sim.solo*10)/10,segments:sim.segments},
    segment:{progressMin:Math.round(sim.progress*100)/100,targetMin:tgt,idleMin:Math.round(sim.idle*10)/10},
    pendingRewards:sim.pending,owned:sim.owned.slice(),lanternLevel:sim.lantern||0,settings:Object.assign({},sim.settings)};
}
function simEmit(){ sim.lastEmit=sim.t; setState(simState()); }
function startSlot(sl){
  sl.gen++;
  const src=SLOT_SRC[sl.i%SLOT_SRC.length];
  sim.by[src].sessions++;
  sl.sess={id:`${src}:demo-${sl.i+1}-${sl.gen}`,source:src,startedAt:Date.now(),lastAt:Date.now(),active:true,
    tools:0,files:0,subagents:0,tokens:0,age:0,nextTool:0.8+R()*2,nextSub:12+R()*30,life:LIFE[sl.i]*(sl.gen>1?0.8:1)};
  simEmit(); // 先发 state（带项目名），再发 session_start
  emit('beat',{kind:'session_start',session:sl.sess.id,tool:'',count:1});
}
function endSlot(sl){
  const s=sl.sess; if(!s) return;
  emit('beat',{kind:'session_end',session:s.id,tool:'',count:1});
  sim.endedList.push({id:s.id,source:s.source,label:sl.label,startedAt:s.startedAt,lastAt:s.lastAt,active:false,tools:s.tools,files:s.files,subagents:s.subagents,tokens:s.tokens,ended:true});
  if(sim.endedList.length>6) sim.endedList.shift();
  sl.sess=null; sl.next=sim.t+25+R()*20;
}
function simBeat(s,kind,tool,count){
  s.lastAt=Date.now();
  if(kind==='tool'){ sim.by[s.source].tools+=count; s.tools+=count; s.tokens+=Math.floor(800+R()*5000)*count; }
  if(kind==='file') s.files+=count;
  if(kind==='subagent') s.subagents+=count;
  emit('beat',{kind,session:s.id,tool:tool||'',count});
}
function segmentDone(){
  sim.progress=0; sim.idle=0; sim.segments++; sim.pending++; simSave();
  emit('beat',{kind:'segment_done',session:'',tool:'',count:1});
  simEmit();
}
function simTick(nowMs){
  const t=nowMs/1000;
  if(sim.last==null){ sim.last=t; }
  const dt=Math.min(0.25,Math.max(0,t-sim.last)); sim.last=t; sim.t+=dt;
  let anyActive=false;
  for(const sl of sim.slots){
    if(sim.frozen) break;
    if(!sl.sess){ if(sim.t>=sl.next) startSlot(sl); continue; }
    const s=sl.sess; s.age+=dt;
    /* game-jam 这条中途歇一会儿，演示「在场但没干活」 */
    const resting=sl.i===4&&s.age>40&&s.age<62;
    s.active=!resting;
    if(s.age>s.life){ endSlot(sl); continue; }
    if(!s.active) continue;
    anyActive=true;
    s.nextTool-=dt;
    if(s.nextTool<=0){
      s.nextTool=1.2+R()*5.5;
      const tool=TOOLS[Math.floor(R()*TOOLS.length)];
      const r=R();
      if(r<0.18){ const n=2+Math.floor(R()*3); for(let k=0;k<n;k++) simBeat(s,'tool',tool,1); }
      else if(r<0.26) simBeat(s,'tool',tool,2+Math.floor(R()*4));
      else simBeat(s,'tool',tool,1);
      if((tool==='Edit'||tool==='Write')&&R()<0.75) simBeat(s,'file','',1);
    }
    s.nextSub-=dt;
    if(s.nextSub<=0){ s.nextSub=35+R()*50; simBeat(s,'subagent','Task',1); }
  }
  const tgt=sim.settings.segmentMin, rate=tgt/60; // 演示里一段 60 秒就满
  if(anyActive) { sim.activeSec+=dt; sim.ai+=dt*rate;
    sim.nextBurst-=dt;
    if(sim.nextBurst<=0){
      /* 每 120 秒里有 40 秒是「夜市」：token 来得快五倍 */
      const hot=(sim.t%120)>50&&(sim.t%120)<92;
      sim.nextBurst=hot?0.8+R()*0.8:2+R()*4;
      const add=(hot?4000:2000)+Math.floor(R()*(hot?8000:6000));
      sim.tokenBase+=add;
      const act=sim.slots.filter(x=>x.sess&&x.sess.active); const who=act.length?act[Math.floor(R()*act.length)]:null;
      sim.by[who?SLOT_SRC[who.i%SLOT_SRC.length]:'claude'].tokens+=add;
      simEmit();
    }
  }
  /* 「只算我在场」打开且人不在：AI 在跑也不累计，按停顿算 */
  const counting=anyActive&&(!sim.settings.presentOnly||sim.present);
  if(counting){
    sim.progress+=dt*rate; sim.idle=0;
    if(sim.present) sim.presentMin+=dt*rate; else sim.solo+=dt*rate;
    if(sim.progress>=tgt) segmentDone();
  }else if(sim.progress>0){
    sim.idle+=dt*rate;
    if(sim.idle>sim.settings.gapMin){ sim.progress=0; sim.idle=0; }
  }
  churnTick(); toggleTick();
  if(sim.t-sim.lastEmit>=2) simEmit();
}
/* ---------- 压力测试（只在演示模式）：快速开关 15+ 个会话，专挑「离岸途中结束」「靠岸途中恢复」 ---------- */
let churn=null, toggler=null;
function report(name,ok,text){
  window.__stress=window.__stress||{}; window.__stress[name]={ok,text};
  let el=document.getElementById('stress');
  if(!el){ el=document.createElement('div'); el.id='stress'; el.style.cssText='position:fixed;left:12px;top:50%;transform:translateY(-50%);z-index:99;max-width:420px;padding:10px 12px;border-radius:10px;background:rgba(8,12,20,.86);border:1px solid rgba(217,164,65,.5);color:#ece1c8;font:12px/1.6 Menlo,monospace;white-space:pre-wrap;pointer-events:none'; document.body.appendChild(el); }
  el.textContent=Object.entries(window.__stress).map(([k,v])=>(v.ok?'通过 ':'失败 ')+k+'\n'+v.text).join('\n\n');
  if(!ok) console.error('STRESS FAIL '+name+': '+text);
}
function churnStart(seconds,settle){
  churn={until:sim.t+seconds,checkAt:sim.t+seconds+settle,next:sim.t,k:0,live:[],dead:[],started:0,endDep:0,resumeDock:0,stale:0,done:false,closed:false};
}
function churnNew(){
  const k=++churn.k, now=Date.now();
  const s={id:'claude:churn-'+k,source:'claude',label:'急'+k,startedAt:now,lastAt:now,active:true,tools:0,files:0,subagents:0,tokens:0,ended:false};
  churn.live.push(s); churn.started++;
  simEmit(); emit('beat',{kind:'session_start',session:s.id,tool:'',count:1});
}
function churnEnd(s){
  churn.live=churn.live.filter(x=>x!==s); s.active=false; s.ended=true; churn.dead.push(s);
  emit('beat',{kind:'session_end',session:s.id,tool:'',count:1});
}
function churnTick(){
  if(!churn||churn.done) return;
  const F=window.JN&&JN.Fleet;
  if(sim.t<churn.until){
    if(sim.t<churn.next) return;
    churn.next=sim.t+0.5;
    if(churn.live.length<9) churnNew();
    const boatsArr=F?[...F.boats.values()]:[];
    const dep=boatsArr.find(b=>b.status==='departing'&&b.alive&&b.u>0.1&&churn.live.some(x=>x.id===b.id));
    if(dep&&R()<0.7){ churnEnd(churn.live.find(x=>x.id===dep.id)); churn.endDep++; }
    const dock=boatsArr.find(b=>b.status==='docking'&&!b.alive&&churn.dead.some(x=>x.id===b.id));
    if(dock){ const s=churn.dead.find(x=>x.id===dock.id); churn.dead=churn.dead.filter(x=>x!==s); s.ended=false; s.active=true; s.lastAt=Date.now()+1; churn.live.push(s); churn.resumeDock++; }
    if(churn.live.length&&R()<0.3) churnEnd(churn.live[Math.floor(R()*churn.live.length)]);
    for(const s of churn.live) if(R()<0.5){ s.tools++; s.lastAt=Date.now(); emit('beat',{kind:'tool',session:s.id,tool:'Bash',count:1}); }
    if(churn.dead.length&&R()<0.4){ churn.stale++; emit('beat',{kind:'tool',session:churn.dead[0].id,tool:'Edit',count:2}); emit('beat',{kind:'subagent',session:'claude:gone-'+churn.k,tool:'Task',count:1}); }
    simEmit();
    return;
  }
  if(!churn.closed){ churn.closed=true; for(const s of churn.live.slice()) churnEnd(s); simEmit(); }
  if(sim.t<churn.checkAt) return;
  churn.done=true;
  const bad=F.check();
  const ids=new Set(churn.dead.map(x=>x.id));
  let stuck=0, moored=0, gone=0;
  for(const id of ids){ const b=F.boats.get(id); if(!b) gone++; else if(b.status==='moored'||b.status==='fading') moored++; else { stuck++; bad.push(id+' '+b.status+(b.alive?' alive':'')); } }
  const ghosts=[...F.boats.values()].filter(b=>b.id.startsWith('claude:gone-')).length;
  if(ghosts) bad.push('ghost boats '+ghosts);
  const st=F.stats();
  if(st.queue>3) bad.push('beat queue '+st.queue);
  const text=`会话 ${churn.started} 个，离岸途中结束 ${churn.endDep} 次，靠岸途中恢复 ${churn.resumeDock} 次，过期节拍 ${churn.stale} 组\n结束的船：靠岸 ${moored}，已退场 ${gone}，卡住 ${stuck}；幽灵船 ${ghosts}\n河里 ${st.river} 排队 ${st.queued} 熄灯 ${st.moored}；节拍队列 ${st.queue}；ended 表 ${F.ended.size}\n`+(bad.length?'问题：'+bad.slice(0,6).join('; '):'泊位占用一致，无问题');
  report('船队压力',bad.length===0,text);
}
function toggleStart(cycles){
  sim.frozen=true;
  const ids=rewardIds.filter(id=>!['guqin','raintiles','watchman'].includes(id));
  toggler={ids,cycles,phase:0,next:sim.t+2,samples:[],offSamples:[]};
}
function toggleTick(){
  const T=toggler; if(!T||T.done) return;
  if(sim.t<T.next) return;
  const r=window.__app&&__app.renderer, mem=r?{g:r.info.memory.geometries,t:r.info.memory.textures}:{g:-1,t:-1};
  if(T.phase>0){ (T.phase%2===1?T.samples:T.offSamples).push(mem); }
  if(T.phase>=T.cycles*2){
    T.done=true;
    const a=T.samples[0], b=T.samples[T.samples.length-1], c=T.offSamples[0], d=T.offSamples[T.offSamples.length-1];
    const ok=a.g===b.g&&a.t===b.t&&c.g===d.g&&c.t===d.t;
    report('奖励反复收放',ok,`收放 ${T.cycles} 轮（${T.ids.length} 样奖励）\n放出时 几何 ${T.samples.map(x=>x.g).join('/')}  贴图 ${T.samples.map(x=>x.t).join('/')}\n收起时 几何 ${T.offSamples.map(x=>x.g).join('/')}  贴图 ${T.offSamples.map(x=>x.t).join('/')}`);
    return;
  }
  T.phase++;
  if(T.phase%2===1){ for(const id of T.ids) if(!sim.owned.includes(id)) sim.owned.push(id); }
  else sim.owned=sim.owned.filter(id=>!T.ids.includes(id));
  simEmit();
  T.next=sim.t+1.5;
}
function pickActive(){ const a=sim.slots.filter(sl=>sl.sess&&sl.sess.active); return a.length?a[Math.floor(Math.random()*a.length)].sess:null; }
const demoApi={
  fire(kind,opt){
    opt=opt||{};
    if(kind==='session_start'){ const sl=sim.slots.find(x=>!x.sess); if(sl){ startSlot(sl); simEmit(); } return; }
    if(kind==='session_end'){ const sl=sim.slots.find(x=>x.sess&&(!opt.label||x.label===opt.label)); if(sl){ endSlot(sl); simEmit(); } return; }
    if(kind==='segment_done'){ segmentDone(); return; }
    const s=pickActive(); if(!s) return;
    simBeat(s,kind,opt.tool||(kind==='tool'?'Edit':kind==='subagent'?'Task':''),opt.count||1);
  },
  completeSegment(){ segmentDone(); },
  grant(id){ if(!id) return; if(String(id).startsWith('lantern')) sim.lantern=(sim.lantern||0)+1; else if(!sim.owned.includes(id)) sim.owned.push(id); simSave(); simEmit(); },
  revoke(id){ sim.owned=sim.owned.filter(x=>x!==id); simSave(); simEmit(); },
  setTokens(n){ sim.tokenOverride=n==null?null:Number(n); simEmit(); },
  burst(n){ sim.tokenBase+=Math.max(0,Number(n)||0); simEmit(); }, // 一下来一阵 token，看齐射
  setPresent(p){ sim.present=!!p; simEmit(); },
  reset(){ try{ localStorage.removeItem(LS); }catch(e){} simInit(); simEmit(); },
  churn(seconds,settle){ churnStart(seconds||45,settle==null?60:settle); },
  toggleRewards(cycles){ toggleStart(cycles||6); },
  get sim(){ return sim; }
};

/* ================= 对外接口 ================= */
function offer(){
  if(DEMO){
    const left=rewardIds.filter(id=>!sim.owned.includes(id));
    if(!left.length) return Promise.resolve(['lantern_plus']);
    for(let i=left.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [left[i],left[j]]=[left[j],left[i]]; }
    return Promise.resolve(left.slice(0,3));
  }
  return post('/api/reward/offer',{}).then(normalizeOffer);
}
function choose(id){
  if(DEMO){
    if(String(id).startsWith('lantern')) sim.lantern=(sim.lantern||0)+1; else if(!sim.owned.includes(id)) sim.owned.push(id);
    sim.pending=Math.max(0,sim.pending-1); simSave(); simEmit(); return Promise.resolve(true);
  }
  /* 不在本地做加减：用响应里的完整 state（带 rev，比现有旧就丢），没有就重新取一份 */
  return post('/api/reward/choose',{id}).then(res=>{
    if(res&&res.sessions) acceptState(res);
    else refetch();
    return true;
  });
}
/* 专注归零：服务端 POST /api/focus/reset（返回带 rev 的完整 state）；演示模式只清专注相关字段，收藏、待领和灯笼等级不动 */
function resetFocus(){
  if(DEMO){
    sim.segments=0; sim.presentMin=0; sim.solo=0; sim.progress=0; sim.idle=0;
    simSave(); simEmit(); return Promise.resolve(true);
  }
  return post('/api/focus/reset',{}).then(res=>{ if(res&&res.sessions) acceptState(res); else refetch(); return true; });
}
function refetch(){ const my=gen; return fetch('/api/state',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(s=>{ if(s&&my===gen) acceptState(s); }).catch(()=>{}); }
/* 设置保存：只发改了的字段；同一时间只有一个请求在路上，后来的改动合并进待发补丁，按顺序发，旧值不会盖新值。
   声音改动先记在本机（pending），没连上时也留着，连上后补发 */
let pendingPatch=null, inFlight=null;
function localSound(){ try{ return JSON.parse(localStorage.getItem('jnfocus.sound')||'null'); }catch(e){ return null; } }
function soundPending(){ const l=localSound(); return !!(l&&l.pending); }
function saveSettings(partial){
  partial=Object.assign({},partial);
  if('volume' in partial||'muted' in partial){
    const l=Object.assign({volume:0.3,muted:false},localSound()||{});
    if('volume' in partial) l.volume=partial.volume; if('muted' in partial) l.muted=partial.muted;
    l.pending=!DEMO;
    try{ localStorage.setItem('jnfocus.sound',JSON.stringify(l)); }catch(e){}
  }
  if(DEMO){ sim.settings=Object.assign({},sim.settings,partial); simSave(); simEmit(); return Promise.resolve(true); }
  pendingPatch=Object.assign(pendingPatch||{},partial);
  return flushSettings();
}
function flushSettings(){
  if(DEMO) return Promise.resolve(true);
  if(inFlight) return inFlight.then(()=>flushSettings());
  const l=localSound();
  if(l&&l.pending){ pendingPatch=Object.assign({volume:l.volume,muted:l.muted},pendingPatch||{}); }
  if(!pendingPatch) return Promise.resolve(true);
  const patch=pendingPatch; pendingPatch=null;
  inFlight=post('/api/settings',patch).then(res=>{
    inFlight=null;
    const now=localSound();
    if(now&&now.pending&&now.volume===patch.volume&&now.muted===patch.muted){ now.pending=false; try{ localStorage.setItem('jnfocus.sound',JSON.stringify(now)); }catch(e){} }
    if(res&&res.sessions) acceptState(res); else refetch();
    return true;
  },err=>{
    inFlight=null;
    pendingPatch=Object.assign({},patch,pendingPatch||{}); // 没发出去：留着，下次连上再发
    delete pendingPatch.volume; delete pendingPatch.muted;   // 声音补丁在本机 pending 里，不重复留
    if(!Object.keys(pendingPatch).length||/^http 4/.test(String(err&&err.message))) pendingPatch=null; // 规则不合法就不再重发
    throw err;
  });
  return inFlight;
}
function tick(nowMs){
  if(DEMO){ simTick(nowMs); return; }
  watchdog(nowMs);
}
function start(ids){
  rewardIds=ids||[];
  if(DEMO){ simInit(); simEmit(); }
  else { api.state=normalize(null); connect(); }
}

Object.assign(api,{on,start,tick,offer,choose,saveSettings,resetFocus,localSound,soundPending,setRewardIds(ids){ rewardIds=ids||[]; },demo:DEMO?demoApi:null});
return api;
})();

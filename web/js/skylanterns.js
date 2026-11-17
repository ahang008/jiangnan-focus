/* 江南入夜 · 孔明灯
   每满 lanternUnit 个 token（默认 1000，可选 500/1000/2000/5000）放一盏，AI 干活时约 6 秒一盏。
   - 「嗖」：从水面或岸边快速窜起（约 1 秒缓出），带一道暖色尾焰和一声轻轻的风声，然后慢慢飘向远处，25 到 35 秒后淡出
   - 一下来很多：按齐射放，一轮最多 6 盏、间隔 0.12 到 0.25 秒，轮与轮之间歇一下；积压太多就并成一轮，并在发射处浮出「+N」
   - 每满 100 万：大一号的灯 + 画面正中「今日 300 万 token」+ 一声风铃
   - 刷新、重连、换天不重放：按日期记住放到第几盏；首次打开最多补 8 盏并提示「今日已放 N 盏」
   - 天上最多 45 盏；所有灯都从一个 48 盏的对象池里取，运行中不新建几何、材质、贴图
   - 只用 rAF 传进来的场景时间 */
window.JN = window.JN || {};
JN.Sky = (function(){
'use strict';
const SC=JN.Scene; if(!SC) return null;
const THREE=window.THREE;
const MILE=1e6, CAP=45, POOL=48, VOLLEY=6, WELCOME=8, MAXQ=12;
const KEY='jnfocus.sky';

/* ---------- 共享资源 ---------- */
function paperTexture(){
  const cv=document.createElement('canvas'); cv.width=128; cv.height=256; const g=cv.getContext('2d');
  const gr=g.createLinearGradient(0,256,0,0);
  gr.addColorStop(0,'#ffbe62'); gr.addColorStop(0.3,'#f99a44'); gr.addColorStop(0.7,'#e0692c'); gr.addColorStop(1,'#b23e1a');
  g.fillStyle=gr; g.fillRect(0,0,128,256);
  for(let i=0;i<260;i++){ g.fillStyle=`rgba(255,240,200,${Math.random()*0.06})`; g.fillRect(Math.random()*128,Math.random()*256,2,6); }
  g.strokeStyle='rgba(110,40,12,.55)'; g.lineWidth=3;
  for(let x=0;x<=128;x+=32){ g.beginPath(); g.moveTo(x,0); g.lineTo(x,256); g.stroke(); }
  g.lineWidth=4; g.beginPath(); g.moveTo(0,250); g.lineTo(128,250); g.stroke();
  g.lineWidth=2; g.beginPath(); g.moveTo(0,8); g.lineTo(128,8); g.stroke();
  const t=new THREE.CanvasTexture(cv); t.wrapS=THREE.RepeatWrapping; return t;
}
/* 尾焰：上亮下淡的一道细长暖光 */
function streakTexture(){
  const cv=document.createElement('canvas'); cv.width=32; cv.height=128; const g=cv.getContext('2d');
  const gr=g.createLinearGradient(0,0,0,128);
  gr.addColorStop(0,'rgba(255,230,170,1)'); gr.addColorStop(0.25,'rgba(255,170,80,.7)'); gr.addColorStop(1,'rgba(255,120,40,0)');
  g.fillStyle=gr; g.fillRect(0,0,32,128);
  const m=g.createLinearGradient(0,0,32,0); m.addColorStop(0,'rgba(0,0,0,1)'); m.addColorStop(0.5,'rgba(0,0,0,0)'); m.addColorStop(1,'rgba(0,0,0,1)');
  g.globalCompositeOperation='destination-out'; g.fillStyle=m; g.fillRect(0,0,32,128);
  return new THREE.CanvasTexture(cv);
}
const PAPER=paperTexture(), STREAK=streakTexture();
const pts=[];
[[0.40,0],[0.44,0.25],[0.50,0.6],[0.55,0.95],[0.56,1.1],[0.52,1.22],[0.38,1.32],[0.0,1.36]].forEach(p=>pts.push(new THREE.Vector2(p[0],p[1])));
const BODY_GEO=new THREE.LatheGeometry(pts,14);
const FLAME_GEO=new THREE.SphereGeometry(0.11,8,6); FLAME_GEO.scale(1,1.5,1);

/* ---------- 对象池：一次建好 48 盏，之后只开关和改参数 ---------- */
const pool=[];
for(let i=0;i<POOL;i++){
  const grp=new THREE.Group(); grp.visible=false;
  const body=new THREE.Mesh(BODY_GEO,new THREE.MeshBasicMaterial({map:PAPER,side:THREE.DoubleSide,transparent:true,depthWrite:false,fog:false,toneMapped:false}));
  body.material.color.setScalar(0.8); // 亮天 + 泛光下不发白
  const flame=new THREE.Mesh(FLAME_GEO,new THREE.MeshBasicMaterial({color:0xffd890,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,fog:false}));
  flame.position.y=0.12;
  const halo=new THREE.Sprite(new THREE.SpriteMaterial({map:SC.tex.glowTex,color:0xffa04a,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,fog:false}));
  halo.position.y=0.55;
  grp.add(body); grp.add(flame); grp.add(halo);
  /* 尾焰放在场景里单独一个 sprite（不跟着灯转），锚点在上端，向下拉长 */
  const streak=new THREE.Sprite(new THREE.SpriteMaterial({map:STREAK,color:0xffd590,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,fog:false}));
  streak.center.set(0.5,1); streak.visible=false;
  body.renderOrder=8; halo.renderOrder=9; streak.renderOrder=9;
  SC.scene.add(grp); SC.scene.add(streak);
  pool.push({grp,body,flame,halo,streak,active:false,born:0});
}
/* 「+N」浮字：一个 sprite，一张画布反复重画 */
const PS=SC.ULTRA?2:1;
const plusCv=document.createElement('canvas'); plusCv.width=256*PS; plusCv.height=96*PS;
const plusTex=new THREE.CanvasTexture(plusCv);
const plus=new THREE.Sprite(new THREE.SpriteMaterial({map:plusTex,transparent:true,depthWrite:false,fog:false,toneMapped:false}));
plus.center.set(0.5,0); plus.visible=false; plus.renderOrder=10; SC.scene.add(plus);
let plusT=-1;
function showPlus(n,x,y,z){
  const g=plusCv.getContext('2d'); g.setTransform(PS,0,0,PS,0,0); g.clearRect(0,0,256,96);
  g.font='700 64px "STKaiti","KaiTi","Kaiti SC",serif'; g.textAlign='center'; g.textBaseline='middle';
  g.lineWidth=8; g.strokeStyle='rgba(40,14,6,.75)'; g.strokeText('+'+n,128,49); g.fillStyle='#fff0c8'; g.fillText('+'+n,128,49);
  plusTex.needsUpdate=true; plus.position.set(x,y,z); plus.visible=true; plusT=0;
}

/* ---------- 发射 ---------- */
const live=[];
function acquire(){
  let p=pool.find(o=>!o.active);
  if(!p){ p=live[0]; retire(p); } // 池满：回收最老的
  return p;
}
function retire(L){
  L.active=false; L.grp.visible=false; L.streak.visible=false;
  const i=live.indexOf(L); if(i>=0) live.splice(i,1);
}
let lastLaunch={x:0,y:2,z:0};
function launch(big,t){
  /* 天上快满了（42 盏）：最老的那盏 2 秒内淡掉；真到 45 盏就直接收走最老的，保证同时不超过 45 */
  if(live.length>=CAP-3){ for(const L of live) if(L.fadeAt===Infinity){ L.fadeAt=L.t; L.fadeLen=2; break; } }
  if(live.length>=CAP) retire(live[0]);
  const L=acquire();
  const onWater=Math.random()<0.6;
  const x=onWater?(Math.random()*2-1)*6:(Math.random()<0.5?-1:1)*(7.6+Math.random()*1.6);
  const z=14-Math.random()*22;
  const y0=onWater?0.25:1.5;
  Object.assign(L,{active:true,big,t:0,born:t,x0:x,y0,z0:z,x,y:y0,z,
    rise:5+Math.random()*3.5,riseT:0.9+Math.random()*0.35,
    vy:0.3+Math.random()*0.15,vz:-(0.35+Math.random()*0.3),vx:(Math.random()*2-1)*0.12,
    ph:Math.random()*6.28,size:(big?1.3:0.72)*(0.9+Math.random()*0.2),life:25+Math.random()*10,fadeAt:Infinity,fadeLen:6});
  L.grp.position.set(x,y0,z); L.grp.visible=true; L.streak.visible=true;
  L.halo.scale.setScalar(big?3.6:2.4);
  live.push(L);
  lastLaunch={x,y:y0,z};
  JN.Audio&&JN.Audio.whoosh&&JN.Audio.whoosh();
}

/* ---------- 正中一行字 ---------- */
let msg=null;
function say(text){ const el=document.getElementById('milestone'); if(!el) return; el.textContent=text; msg={t:0,el}; }

/* ---------- 按 token 计数 ---------- */
const today=()=>{ const d=new Date(); return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); };
let rec=null, first=true, unit=1000, lastTokens=0;
const queue=[]; let pendingPlus=0, nextAt=0, volley=0;
function load(){ try{ const r=JSON.parse(localStorage.getItem(KEY)||'null'); if(r&&r.date===today()&&Number.isInteger(r.idx)) return r; }catch(e){} return null; }
function save(){ try{ localStorage.setItem(KEY,JSON.stringify(rec)); }catch(e){} }
let on=true, saysText=true, boost=0;
function setBoost(v){ boost=v; } // 夜市：每轮多放几盏，偶尔多送一盏
/* 反馈方式：lantern 只放灯（带正中字和风铃）；both 放灯但正中字和声音交给木鱼；muyu 不放灯，只记账 */
function setStyle(style){ on=style!=='muyu'; saysText=style==='lantern'; if(!on){ queue.length=0; pendingPlus=0; } }
function onTokens(tokens,demo,lanternUnit){
  tokens=Math.max(0,tokens||0);
  const u=[500,1000,2000,5000].includes(lanternUnit)?lanternUnit:1000;
  const prevTokens=lastTokens; lastTokens=tokens; unit=u;
  const idx=Math.floor(tokens/u);
  if(!rec||rec.date!==today()){ rec=(!demo&&load())||{date:today(),idx:0,unit:u,mile:0}; if(rec.mile==null) rec.mile=Math.floor(tokens/MILE); }
  if(rec.unit!==u){ rec.unit=u; rec.idx=idx; save(); return; } // 换了单位：从现在接着算，不补放
  if(first){
    first=false;
    if(on&&!demo&&idx>0&&idx>rec.idx){
      const n=Math.min(WELCOME,idx-rec.idx);
      for(let k=0;k<n;k++) queue.push({big:false});
      if(saysText) say(`今日已放 ${idx} 盏`);
    }else if(on&&saysText&&!demo&&idx>0) say(`今日已放 ${idx} 盏`);
    rec.idx=idx; rec.mile=Math.floor(tokens/MILE); save(); return;
  }
  if(idx<rec.idx){ rec.idx=idx; rec.mile=Math.floor(tokens/MILE); save(); return; } // 服务端换天或归零
  const add=idx-rec.idx;
  const mile=Math.floor(tokens/MILE);
  let changed=false;
  if(add>0){ rec.idx=idx; changed=true; if(on) for(let k=0;k<add;k++) queue.push({big:false}); }
  if(mile>rec.mile){ if(on) queue.push({big:true,mile}); rec.mile=mile; changed=true; }
  if(changed) save();
  /* 积压太多：并成一轮，多出来的用「+N」表示 */
  if(queue.length>MAXQ){
    const keep=queue.filter(q=>q.mile).slice(-1), small=queue.filter(q=>!q.mile);
    const n=VOLLEY-keep.length;
    pendingPlus+=small.length-n;
    queue.length=0; for(let k=0;k<n;k++) queue.push({big:false}); queue.push(...keep);
  }
  void prevTokens;
}
function progress(){
  const r=lastTokens%unit, left=unit-r;
  const text='距下一盏灯 还差 '+(unit<1e4?Math.ceil(left)+' token':(left/1e4).toFixed(1).replace(/\.0$/,'')+' 万');
  return {frac:r/unit,left,text};
}

/* ---------- 每帧 ---------- */
function update(dt,n,t){
  if(queue.length&&t>=nextAt){
    const q=queue.shift();
    launch(q.big,t);
    if(volley===0&&pendingPlus>0){ showPlus(pendingPlus,lastLaunch.x,lastLaunch.y+2.2,lastLaunch.z); pendingPlus=0; }
    if(q.mile&&saysText){ say(`今日 ${q.mile*100} 万 token`); JN.Audio&&JN.Audio.chime&&JN.Audio.chime(); }
    volley++;
    if(boost>0.5&&!q.mile&&Math.random()<0.35&&live.length<CAP-4) queue.unshift({big:false,bonus:true});
    if(queue.length&&volley<VOLLEY+Math.round(4*boost)) nextAt=t+0.12+Math.random()*0.13;   // 嗖嗖嗖
    else { volley=0; nextAt=t+(queue.length?0.9:0.3); }                 // 一轮放完歇一下
  }
  const cam=SC.camera.position;
  for(let i=live.length-1;i>=0;i--){
    const L=live[i]; L.t+=dt;
    /* 窜起：头 riseT 秒按三次方缓出升高 rise 米，之后慢慢飘 */
    const u=Math.min(1,L.t/L.riseT), e=1-Math.pow(1-u,3);
    const after=Math.max(0,L.t-L.riseT);
    const wind=Math.sin(t*0.13+L.ph)*0.15;
    L.x=L.x0+(L.vx+wind*0.5)*after+0.3*Math.sin(L.t*0.4+L.ph);
    L.y=L.y0+L.rise*e+L.vy*after;
    L.z=L.z0+L.vz*after-0.8*e;
    const g=L.grp; g.position.set(L.x,L.y,L.z);
    g.rotation.set(0.05*Math.sin(t*0.6+L.ph*1.3),g.rotation.y+dt*0.2,0.06*Math.sin(t*0.8+L.ph));
    const fin=Math.min(1,L.t/0.25);
    const end=Math.min(L.life,L.fadeAt+L.fadeLen);
    const fl=L.fadeAt===Infinity?6:L.fadeLen;
    const fout=L.t>end-fl?Math.max(0,(end-L.t)/fl):1;
    const a=fin*fout;
    g.scale.setScalar(L.size*(0.55+0.45*fin)*(0.8+0.2*fout));
    const flick=0.85+0.15*Math.sin(t*9+L.ph)+0.05*Math.sin(t*23+L.ph*2);
    L.body.material.opacity=0.95*a;
    L.flame.material.opacity=0.8*a*flick;
    const d=cam.distanceTo(g.position);
    L.halo.material.opacity=a*(0.26+0.2*n)*flick*THREE.MathUtils.clamp(d/30,0.45,1);
    /* 尾焰：窜起时最亮最长，之后很快收掉 */
    const sp=L.rise*3*Math.pow(1-u,2)/L.riseT;  // 当前上升速度（米/秒）
    const tail=u<1?Math.pow(1-u,0.8):0;
    if(tail>0.02){
      L.streak.visible=true;
      L.streak.position.set(L.x,L.y+0.05*L.size,L.z);
      L.streak.scale.set(0.55*L.size,THREE.MathUtils.clamp(sp*0.3,0.4,4.2)*L.size,1);
      L.streak.material.opacity=Math.min(1,1.1*tail)*fin;
    }else L.streak.visible=false;
    if(L.t>=end) retire(L);
  }
  if(plusT>=0){
    plusT+=dt; const k=plusT<0.3?plusT/0.3:Math.max(0,1-(plusT-1.4)/0.8);
    plus.material.opacity=k; plus.position.y+=dt*0.8;
    const d=cam.distanceTo(plus.position); const w=THREE.MathUtils.clamp(d*0.14,2,7); plus.scale.set(w,w*96/256,1);
    if(plusT>2.2){ plus.visible=false; plusT=-1; }
  }
  if(msg){
    msg.t+=dt;
    const k=msg.t<0.5?msg.t/0.5:(msg.t>2.6?Math.max(0,1-(msg.t-2.6)/0.8):1);
    msg.el.style.opacity=String(Math.round(k*100)/100);
    msg.el.style.transform=`translate(-50%,${Math.round((1-k)*8)}px)`;
    if(msg.t>3.4){ msg.el.style.opacity='0'; msg=null; }
  }
}
function busy(){ return queue.length>0||live.some(L=>L.t<L.riseT); }
return {setBoost,get todayCount(){ return rec?rec.idx:0; },liveInfo:()=>live.map(L=>({t:+L.t.toFixed(2),z:+L.z.toFixed(1),big:L.big,fast:L.t<L.riseT})),onTokens,update,progress,busy,say,setStyle,get count(){ return live.length; },get queued(){ return queue.length; },get unit(){ return unit; },CAP};
})();

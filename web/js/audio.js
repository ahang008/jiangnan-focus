/* 江南入夜 · 声音（全部 Web Audio 现场合成，不用任何音频文件）
   环境水声、虫鸣沿用原网页；新增钟声、古琴、雨打瓦片、更夫敲梆。主音量默认 30% */
window.JN = window.JN || {};
JN.Audio = (function(){
'use strict';
let AC=null, master=null, bus=null, noiseBuf=null, clickBuf=null;
let volume=0.3, muted=false;
const enabled={guqin:false,raintiles:false,watchman:false};
const next={chirp:0,guqin:8,rain:0,watch:25};
let rainBed=null;

function target(){ return muted?0:volume; }
function init(){
  if(AC) return true;
  try{ AC=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){ return false; }
  master=AC.createGain(); master.gain.value=target(); master.connect(AC.destination);
  bus=AC.createGain(); bus.gain.value=1; bus.connect(master);
  /* 原网页的河水底噪 */
  const len=AC.sampleRate*3; noiseBuf=AC.createBuffer(1,len,AC.sampleRate); const d=noiseBuf.getChannelData(0);
  let last=0;
  for(let i=0;i<len;i++){ const w=Math.random()*2-1; last=(last+0.02*w)/1.02; d[i]=last*3.2; }
  const src=AC.createBufferSource(); src.buffer=noiseBuf; src.loop=true;
  const lp=AC.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=380; lp.Q.value=0.6;
  const g=AC.createGain(); g.gain.value=0.16;
  const lfo=AC.createOscillator(); lfo.frequency.value=0.13;
  const lfoG=AC.createGain(); lfoG.gain.value=0.06;
  lfo.connect(lfoG); lfoG.connect(g.gain);
  src.connect(lp); lp.connect(g); g.connect(bus);
  src.start(); lfo.start();
  const lap=AC.createBufferSource(); lap.buffer=noiseBuf; lap.loop=true; lap.playbackRate.value=1.7;
  const bp=AC.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=900; bp.Q.value=1.4;
  const g2=AC.createGain(); g2.gain.value=0.035;
  const lfo2=AC.createOscillator(); lfo2.frequency.value=0.21;
  const lg2=AC.createGain(); lg2.gain.value=0.022;
  lfo2.connect(lg2); lg2.connect(g2.gain);
  lap.connect(bp); bp.connect(g2); g2.connect(bus);
  lap.start(); lfo2.start();
  /* 白噪声短片，给雨点和木梆用 */
  const cl=Math.floor(AC.sampleRate*0.06); clickBuf=AC.createBuffer(1,cl,AC.sampleRate); const c=clickBuf.getChannelData(0);
  for(let i=0;i<cl;i++) c[i]=(Math.random()*2-1)*Math.exp(-i/(cl*0.12));
  if(enabled.raintiles) startRainBed();
  return true;
}
/* 返回 Promise：AudioContext 真的 running 才算解锁成功；被浏览器拒绝时返回 false，不抛未处理异常 */
function unlock(){
  if(!init()) return Promise.resolve(false);
  if(AC.state==='running') return Promise.resolve(true);
  let p; try{ p=AC.resume(); }catch(e){ return Promise.resolve(false); }
  return Promise.resolve(p).then(()=>AC.state==='running',()=>false);
}
function unlocked(){ return !!AC && AC.state==='running'; }
function setVolume(v){ volume=Math.max(0,Math.min(1,v)); applyGain(); }
function setMuted(m){ muted=!!m; applyGain(); }
function applyGain(){ if(master){ master.gain.cancelScheduledValues(AC.currentTime); master.gain.setTargetAtTime(target(),AC.currentTime,0.08); } }
const live=()=>AC&&AC.state==='running'&&!muted&&volume>0;

function chirp(){
  if(!live()) return;
  const t0=AC.currentTime+0.02;
  for(let i=0;i<3;i++){
    const o=AC.createOscillator(); o.type='sine'; o.frequency.value=4100+Math.random()*400;
    const g=AC.createGain(); const st=t0+i*0.09;
    g.gain.setValueAtTime(0,st); g.gain.linearRampToValueAtTime(0.012, st+0.015);
    g.gain.exponentialRampToValueAtTime(0.0001,st+0.07);
    o.connect(g); g.connect(bus); o.start(st); o.stop(st+0.09);
  }
}
/* 一段专注完成：原网页的钟声 */
function bell(soft){
  if(!live()) return;
  const t0=AC.currentTime+0.05, k=soft?0.45:1;
  [220,331,442,552].forEach((f,i)=>{
    const o=AC.createOscillator(); o.type='sine'; o.frequency.value=f*(1+Math.random()*0.004);
    const g=AC.createGain();
    g.gain.setValueAtTime(0.0001,t0); g.gain.linearRampToValueAtTime(0.09*k/(i+1),t0+0.03);
    g.gain.exponentialRampToValueAtTime(0.0001,t0+4.5-i*0.6);
    o.connect(g); g.connect(bus); o.start(t0); o.stop(t0+5);
  });
}

/* 风铃：每满 100 万 token 一声。几根细管各敲一下，高频、有点不谐和、长尾，音量跟主音量走 */
function chime(){
  if(!live()) return;
  const t0=AC.currentTime+0.04;
  const base=[1318.5,1568,1760,2093,2349.3];
  const n=3+Math.floor(Math.random()*2);
  for(let j=0;j<n;j++){
    const f=base[Math.floor(Math.random()*base.length)], st=t0+j*(0.11+Math.random()*0.12);
    [[1,0.035],[2.76,0.012],[5.4,0.005]].forEach(([m,a])=>{
      const o=AC.createOscillator(); o.type='sine'; o.frequency.value=f*m*(1+Math.random()*0.003);
      const g=AC.createGain(); g.gain.setValueAtTime(0.0001,st); g.gain.linearRampToValueAtTime(a,st+0.006); g.gain.exponentialRampToValueAtTime(0.00008,st+2.6/m+0.3);
      o.connect(g); g.connect(bus); o.start(st); o.stop(st+3);
    });
  }
}

/* 孔明灯窜起时的「嗖」：一小段带通噪声，频率从低扫到高，很轻；每秒最多 3 声，静音时完全不出声 */
let whooshT=[];
function whoosh(){
  if(!live()) return;
  const now=AC.currentTime;
  whooshT=whooshT.filter(x=>now-x<1);
  if(whooshT.length>=3) return;
  whooshT.push(now);
  const t0=now+0.01, dur=0.32+Math.random()*0.12;
  const s=AC.createBufferSource(); s.buffer=noiseBuf; s.playbackRate.value=3+Math.random();
  const bp=AC.createBiquadFilter(); bp.type='bandpass'; bp.Q.value=1.6;
  bp.frequency.setValueAtTime(380+Math.random()*120,t0); bp.frequency.exponentialRampToValueAtTime(2200+Math.random()*900,t0+dur);
  const g=AC.createGain(); g.gain.setValueAtTime(0.0001,t0); g.gain.linearRampToValueAtTime(0.055,t0+dur*0.35); g.gain.exponentialRampToValueAtTime(0.0001,t0+dur);
  const pan=AC.createStereoPanner?AC.createStereoPanner():null;
  s.connect(bp); bp.connect(g);
  if(pan){ pan.pan.value=Math.random()*1.2-0.6; g.connect(pan); pan.connect(bus); } else g.connect(bus);
  s.start(t0,Math.random()*2); s.stop(t0+dur+0.05);
}

/* 木鱼「笃」：短促的空腔木声，带通 900 到 1400 Hz 的胴音 + 一点敲击噪声，衰减很快；每秒最多 7 下，静音不响 */
let fishT=[];
function woodfish(){
  if(!live()) return;
  const now=AC.currentTime; fishT=fishT.filter(x=>now-x<1); if(fishT.length>=7) return; fishT.push(now);
  const t=now+0.005, f=1050+Math.random()*120;
  const o=AC.createOscillator(); o.type='sine'; o.frequency.setValueAtTime(f*1.35,t); o.frequency.exponentialRampToValueAtTime(f,t+0.012);
  const bp=AC.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=f; bp.Q.value=6;
  const g=AC.createGain(); g.gain.setValueAtTime(0.0001,t); g.gain.linearRampToValueAtTime(0.22,t+0.002); g.gain.exponentialRampToValueAtTime(0.0003,t+0.13);
  o.connect(bp); bp.connect(g); g.connect(bus); o.start(t); o.stop(t+0.16);
  const o2=AC.createOscillator(); o2.type='sine'; o2.frequency.value=f*0.52;
  const g2=AC.createGain(); g2.gain.setValueAtTime(0.0001,t); g2.gain.linearRampToValueAtTime(0.07,t+0.003); g2.gain.exponentialRampToValueAtTime(0.0002,t+0.09);
  o2.connect(g2); g2.connect(bus); o2.start(t); o2.stop(t+0.1);
  const n=AC.createBufferSource(); n.buffer=clickBuf; const nb=AC.createBiquadFilter(); nb.type='bandpass'; nb.frequency.value=2600; nb.Q.value=1.2;
  const ng=AC.createGain(); ng.gain.value=0.05; n.connect(nb); nb.connect(ng); ng.connect(bus); n.start(t);
}
/* 磬：铜钵一声，几个不谐和泛音，长尾 */
function qing(){
  if(!live()) return;
  const t=AC.currentTime+0.03;
  [[523.3,0.06,6.5],[1336,0.03,4.2],[2471,0.014,2.6],[3790,0.006,1.6]].forEach(([f,a,d])=>{
    const o=AC.createOscillator(); o.type='sine'; o.frequency.value=f*(1+Math.random()*0.002);
    const g=AC.createGain(); g.gain.setValueAtTime(0.0001,t); g.gain.linearRampToValueAtTime(a,t+0.01); g.gain.exponentialRampToValueAtTime(0.0001,t+d);
    const lfo=AC.createOscillator(); lfo.frequency.value=4+Math.random()*2; const lg=AC.createGain(); lg.gain.value=a*0.25; lfo.connect(lg); lg.connect(g.gain);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t+d+0.1); lfo.start(t); lfo.stop(t+d+0.1);
  });
}

/* 古琴：Karplus-Strong 拨弦，五声音阶，偶尔一两句 */
const PENTA=[146.83,164.81,185.0,220.0,246.94,293.66,329.63,369.99,440.0];
const ksCache={};
function ksBuffer(f){
  const key=Math.round(f); if(ksCache[key]) return ksCache[key];
  const sr=AC.sampleRate, n=Math.floor(sr*3.2), b=AC.createBuffer(1,n,sr), d=b.getChannelData(0);
  const p=Math.max(2,Math.round(sr/f)); const ring=new Float32Array(p);
  for(let i=0;i<p;i++) ring[i]=(Math.random()*2-1)*(1-i/p*0.3);
  let idx=0;
  for(let i=0;i<n;i++){ const a=ring[idx], c=ring[(idx+1)%p]; const v=0.4985*(a+c); d[i]=a; ring[idx]=v; idx=(idx+1)%p; }
  ksCache[key]=b; return b;
}
function pluck(f,t,gain){
  const s=AC.createBufferSource(); s.buffer=ksBuffer(f);
  s.playbackRate.setValueAtTime(1,t); s.playbackRate.linearRampToValueAtTime(1.012,t+0.6); s.playbackRate.linearRampToValueAtTime(0.997,t+1.6);
  const lp=AC.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=1700; lp.Q.value=0.4;
  const g=AC.createGain(); g.gain.setValueAtTime(gain,t); g.gain.exponentialRampToValueAtTime(0.0005,t+3.1);
  s.connect(lp); lp.connect(g); g.connect(bus); s.start(t); s.stop(t+3.2);
}
function guqinPhrase(){
  const t0=AC.currentTime+0.05; let t=t0;
  const n=2+Math.floor(Math.random()*4); let k=2+Math.floor(Math.random()*5);
  for(let i=0;i<n;i++){
    pluck(PENTA[k],t,0.32-i*0.03);
    k=Math.max(0,Math.min(PENTA.length-1,k+(Math.random()<0.5?-1:1)*(1+Math.floor(Math.random()*2))));
    t+=0.45+Math.random()*0.75;
  }
}

/* 雨打瓦片：一层很轻的沙沙声 + 细碎的点 */
function startRainBed(){
  if(!AC||rainBed) return;
  const s=AC.createBufferSource(); s.buffer=noiseBuf; s.loop=true; s.playbackRate.value=4;
  const hp=AC.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=1800;
  const g=AC.createGain(); g.gain.value=0;
  s.connect(hp); hp.connect(g); g.connect(bus); s.start();
  g.gain.setTargetAtTime(0.05,AC.currentTime,1.5);
  rainBed={s,g};
}
function stopRainBed(){ if(!rainBed) return; const r=rainBed; rainBed=null; r.g.gain.setTargetAtTime(0,AC.currentTime,0.6); r.s.stop(AC.currentTime+3); }
function drop(t){
  const s=AC.createBufferSource(); s.buffer=clickBuf; s.playbackRate.value=0.7+Math.random()*1.4;
  const bp=AC.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=2200+Math.random()*4200; bp.Q.value=2.5;
  const g=AC.createGain(); g.gain.value=0.05+Math.random()*0.09;
  const pan=AC.createStereoPanner?AC.createStereoPanner():null;
  s.connect(bp); bp.connect(g);
  if(pan){ pan.pan.value=Math.random()*1.6-0.8; g.connect(pan); pan.connect(bus); } else g.connect(bus);
  s.start(t);
}

/* 更夫：两下木梆，隔一会儿远处一声锣 */
function knock(t,f){
  const o=AC.createOscillator(); o.type='triangle'; o.frequency.setValueAtTime(f*1.6,t); o.frequency.exponentialRampToValueAtTime(f,t+0.03);
  const g=AC.createGain(); g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(0.16,t+0.004); g.gain.exponentialRampToValueAtTime(0.0005,t+0.18);
  const bp=AC.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=f*1.2; bp.Q.value=3;
  o.connect(bp); bp.connect(g); g.connect(bus); o.start(t); o.stop(t+0.22);
  const n=AC.createBufferSource(); n.buffer=clickBuf; const ng=AC.createGain(); ng.gain.value=0.05;
  const nb=AC.createBiquadFilter(); nb.type='bandpass'; nb.frequency.value=f*2; nb.Q.value=4;
  n.connect(nb); nb.connect(ng); ng.connect(bus); n.start(t);
}
function gong(t){
  [98,147.5,203,262].forEach((f,i)=>{
    const o=AC.createOscillator(); o.type='sine'; o.frequency.setValueAtTime(f*1.01,t); o.frequency.exponentialRampToValueAtTime(f,t+0.8);
    const g=AC.createGain(); g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(0.05/(i+1),t+0.06); g.gain.exponentialRampToValueAtTime(0.0003,t+5-i*0.7);
    const lp=AC.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=700;
    o.connect(lp); lp.connect(g); g.connect(bus); o.start(t); o.stop(t+5.2);
  });
}
function watchman(){
  const t=AC.currentTime+0.05;
  knock(t,620); knock(t+0.62,600);
  gong(t+2.3);
}

/* 每帧调度（用场景时间，页面隐藏时 rAF 停，声音事件也跟着停） */
function update(el, n){
  if(!AC) return;
  if(enabled.raintiles&&!rainBed) startRainBed();
  if(!enabled.raintiles&&rainBed) stopRainBed();
  if(!live()) return;
  if(n>0.5&&el>next.chirp){ chirp(); next.chirp=el+1.4+Math.random()*2.6; }
  if(enabled.guqin&&el>next.guqin){ guqinPhrase(); next.guqin=el+22+Math.random()*38; }
  if(enabled.raintiles&&el>next.rain){
    const now=AC.currentTime; for(let i=0;i<3;i++) drop(now+0.02+Math.random()*0.3);
    next.rain=el+0.25+Math.random()*0.2;
  }
  if(enabled.watchman&&el>next.watch){ watchman(); next.watch=el+150+Math.random()*120; }
}
function setEnabled(id,on,el){
  if(!(id in enabled)) return;
  if(on&&!enabled[id]){
    /* 刚得到时很快响一次，让人听见 */
    if(id==='guqin') next.guqin=(el||0)+1.5;
    if(id==='watchman') next.watch=(el||0)+2;
  }
  enabled[id]=!!on;
}
return {init,unlock,unlocked,setVolume,setMuted,bell,chime,whoosh,woodfish,qing,update,setEnabled,
  get volume(){return volume;}, get muted(){return muted;}, preview(id){ if(!live()) return; if(id==='guqin') guqinPhrase(); if(id==='watchman') watchman(); if(id==='raintiles'){ const now=AC.currentTime; for(let i=0;i<12;i++) drop(now+Math.random()*1.2); } }};
})();

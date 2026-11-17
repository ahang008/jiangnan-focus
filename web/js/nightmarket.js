/* 江南入夜 · 夜市加成
   最近 60 秒的 token 速度 ≥ 前 15 分钟每分钟用量中位数的 3 倍，且 ≥ 每分钟 3 万：进入「夜市」，至少持续 45 秒，速度降下来再退。
   夜市时：沿河灯笼全亮且更亮、屋檐之间拉起一串串暖色小灯、孔明灯每轮放得更多、画面四角一层淡金、进度卡旁一枚「夜市」小印。
   进出都缓缓过渡（约 2 秒）。至少要有 1 个完整分钟的历史才判断（刚打开页面不会误触发）。 */
window.JN = window.JN || {};
JN.Night = (function(){
'use strict';
const SC=JN.Scene; if(!SC) return null;
const THREE=window.THREE;
const MIN_HOLD=45000, RATE_MIN=30000, MULT=3;
let samples=[];           // {t,tokens}（毫秒，按 state.now）
let minutes=new Map();    // 分钟号 -> 该分钟开始时的 token
let on=false, onSince=0, k=0, lastNow=0, rate60=0, median=0;

function feed(now,tokens){
  if(!now) return;
  if(samples.length&&tokens<samples[samples.length-1].tokens){ samples=[]; minutes.clear(); } // 换天或归零
  samples.push({t:now,tokens}); lastNow=now;
  while(samples.length&&now-samples[0].t>16*60000) samples.shift();
  const m=Math.floor(now/60000); if(!minutes.has(m)) minutes.set(m,tokens);
  for(const key of [...minutes.keys()]) if(key<m-16) minutes.delete(key);
  /* 最近 60 秒速度 */
  const old=samples.find(s=>now-s.t<=60000)||samples[0];
  const span=Math.max(1000,now-old.t);
  rate60=(tokens-old.tokens)/span*60000;
  if(now-samples[0].t<60000&&samples.length>1) rate60=(tokens-samples[0].tokens)/Math.max(1000,now-samples[0].t)*60000;
  /* 前 15 个完整分钟各自的用量，取中位数 */
  const keys=[...minutes.keys()].sort((a,b)=>a-b), per=[];
  for(let i=0;i<keys.length-1;i++) if(keys[i+1]===keys[i]+1&&keys[i+1]<m) per.push(minutes.get(keys[i+1])-minutes.get(keys[i]));
  const last15=per.slice(-15).sort((a,b)=>a-b);
  median=last15.length?last15[Math.floor((last15.length-1)/2)]:NaN;
  const hot=Number.isFinite(median)&&rate60>=RATE_MIN&&rate60>=MULT*median;
  if(hot&&!on){ on=true; onSince=now; }
  else if(!hot&&on&&now-onSince>=MIN_HOLD) on=false;
}

/* ---------- 屋檐之间的串灯 ---------- */
const bulbs=[];
const anchors=SC.lanternAnchors().filter(a=>Math.abs(a.x)>8&&Math.abs(a.x)<9.2&&a.z>-80&&a.z<30);
for(const side of [-1,1]){
  const list=anchors.filter(a=>Math.sign(a.x)===side).sort((a,b)=>b.z-a.z);
  for(let i=0;i<list.length-1;i++){
    const A=list[i], B=list[i+1]; const d=Math.abs(A.z-B.z); if(d>13||d<1.2) continue;
    const n=Math.max(4,Math.round(d/0.9));
    for(let j=1;j<n;j++){ const u=j/n; bulbs.push({x:A.x+(B.x-A.x)*u-side*0.15,y:A.y+0.1+(B.y-A.y)*u-0.75*Math.sin(Math.PI*u),z:A.z+(B.z-A.z)*u,slot:A.slot||B.slot,ph:Math.random()*6.28}); }
  }
}
const N=bulbs.length, pos=new Float32Array(N*3), seed=new Float32Array(N);
bulbs.forEach((b,i)=>{ pos.set([b.x,b.y,b.z],i*3); seed[i]=b.ph; });
const geo=new THREE.BufferGeometry(); geo.setAttribute('position',new THREE.BufferAttribute(pos,3)); geo.setAttribute('aSeed',new THREE.BufferAttribute(seed,1));
const mat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
  uniforms:{uK:{value:0},uTime:{value:0},uTex:{value:SC.tex.glowTex},uPR:{value:1}},
  vertexShader:`attribute float aSeed; uniform float uTime,uPR; varying float vA;
    void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); vA=0.75+0.25*sin(uTime*3.0+aSeed);
      gl_PointSize=0.75*(240.0/max(1.0,-mv.z))*uPR; gl_Position=projectionMatrix*mv; }`,
  fragmentShader:`uniform sampler2D uTex; uniform float uK; varying float vA;
    void main(){ float a=texture2D(uTex,gl_PointCoord).a; gl_FragColor=vec4(1.0,0.8,0.45,a*vA*uK); }`});
const pts=new THREE.Points(geo,mat); pts.frustumCulled=false; pts.layers.set(1); pts.visible=false; SC.scene.add(pts);

/* ---------- 画面上的淡金四角和「夜市」小印 ---------- */
const vig=document.createElement('div'); vig.id='nmVignette'; document.body.appendChild(vig);
const seal=document.createElement('div'); seal.id='nmSeal'; seal.innerHTML='<span>夜</span><span>市</span>'; document.body.appendChild(seal);

function update(dt,t){
  const target=on?1:0;
  const d=target-k; k+=Math.sign(d)*Math.min(Math.abs(d),dt*0.5);
  SC.G.night=k;
  mat.uniforms.uK.value=k; mat.uniforms.uTime.value=t; mat.uniforms.uPR.value=SC.ULTRA?SC.renderer.getPixelRatio()/1.5:1;
  pts.visible=k>0.01;
  const ks=k.toFixed(3);
  if(vig.style.opacity!==ks){ vig.style.opacity=ks; seal.style.opacity=ks; seal.style.transform=`rotate(-8deg) scale(${(0.9+0.1*k).toFixed(3)})`; }
  JN.Sky&&JN.Sky.setBoost&&JN.Sky.setBoost(k);
}
function force(v){ on=!!v; onSince=lastNow; } // 截图和调试用
return {feed,update,force,get on(){ return on; },get k(){ return k; },get rate(){ return rate60; },get median(){ return median; },bulbs:N};
})();

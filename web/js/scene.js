/* 江南入夜 · 场景层（由原网页 original-jiangnan.html 拆出，画面逻辑保持原样）
   改动：光阴改由今日 token 驱动；窗户可逐扇点亮；灯笼可逐盏点亮；船只移到 boats.js；声音移到 audio.js；主循环移到 main.js */
window.JN = window.JN || {};
JN.Scene = (function(){
'use strict';
if(!window.THREE){ document.getElementById('err').style.display='flex'; return null; }

/* ================= state ================= */
const S = {
  time:0.12, lamp:1, wind:0.6, bloom:0.9,
  fog:1, wave:1, boat:1, quality:'mid', gust:0, orbit:false, follow:-1
};
/* 不进入「重置」的游戏态：目标时辰、灯笼点亮比例、灯笼加亮级数 */
const G = { timeTarget:0.12, timeSnap:true, lampFrac:0, lampLevel:0, night:0 }; // night：夜市程度 0~1
const DEFAULTS = JSON.parse(JSON.stringify(S));
let renderer, scene, camera, controls, composer, bloomPass, fxaaPass;
let water, sky, sunLight, moonLight, hemi;
let dprCap = 1.5, W=innerWidth, H=innerHeight;
/* 出效果图用的超清档（只在演示模式 ?demo=1&q=ultra）：像素比不封顶（跟设备一致）、水面反射 2048、关掉自适应降分辨率。
   正常页面不受影响 */
const QP=new URLSearchParams(location.search);
const ULTRA_URL=QP.get('demo')==='1'&&QP.get('q')==='ultra';
/* 「超清 · 原生」也放进造境的画质选项；画质选择记在本机，刷新后还在 */
const Q_KEY='jnfocus.quality';
(function(){ let q=null; try{ q=localStorage.getItem(Q_KEY); }catch(e){}
  if(ULTRA_URL) S.quality='ultra'; else if(['ultra','high','mid','low'].includes(q)) S.quality=q; })();
const isUltra=()=>S.quality==='ultra';
const PR_BASE=1.5; // 光点（灯笼光晕、萤火）按 1.5 倍像素比调过大小；超清档按比例放大，看起来一样大
const clock = new THREE.Clock();
let elapsed = 0;

/* ================= palette ================= */
const C = {
  duskFog:new THREE.Color(0x6e5a66), nightFog:new THREE.Color(0x0a141f),
  duskHemi:new THREE.Color(0x8a7290), nightHemi:new THREE.Color(0x18263c),
  duskGround:new THREE.Color(0x4a3630), nightGround:new THREE.Color(0x0a0c10),
  sun:new THREE.Color(0xffb070), moon:new THREE.Color(0xa8c4e8),
  lamp:new THREE.Color(0xff5a26)
};
const MOON_DIR = new THREE.Vector3(-0.38,0.42,-0.62).normalize();
function sunDir(t){
  const elev = 0.14 - t*0.42;
  return new THREE.Vector3(0.16, elev, -1).normalize();
}
const nightK = t => THREE.MathUtils.smoothstep(t, 0.18, 0.72);

/* ================= procedural canvas textures ================= */
function makeTex(size, draw){
  const cv = document.createElement('canvas'); cv.width=cv.height=size;
  draw(cv.getContext('2d'), size);
  const tx = new THREE.CanvasTexture(cv);
  tx.wrapS=tx.wrapT=THREE.RepeatWrapping; tx.anisotropy=4;
  return tx;
}
const stoneTex = makeTex(256,(g,s)=>{
  g.fillStyle='#5d646e'; g.fillRect(0,0,s,s);
  for(let r=0;r<8;r++){ const off=(r%2)*32;
    for(let cx=-1;cx<5;cx++){ const x=cx*64+off, y=r*32;
      const v=88+Math.random()*26;
      g.fillStyle=`rgb(${v-6},${v},${v+8})`; g.fillRect(x+2,y+2,60,28);
      g.fillStyle='rgba(255,255,255,.06)'; g.fillRect(x+2,y+2,60,4);
    }}
  g.strokeStyle='rgba(30,34,42,.85)'; g.lineWidth=2;
  for(let r=0;r<=8;r++){ g.beginPath(); g.moveTo(0,r*32); g.lineTo(s,r*32); g.stroke(); }
  for(let i=0;i<900;i++){ g.fillStyle=`rgba(${Math.random()<.5?0:255},${Math.random()<.5?0:255},255,.03)`;
    g.fillRect(Math.random()*s,Math.random()*s,1.5,1.5); }
});
const tileTex = makeTex(128,(g,s)=>{
  g.fillStyle='#212a36'; g.fillRect(0,0,s,s);
  for(let r=0;r<8;r++){ const y=r*16;
    const gr=g.createLinearGradient(0,y,0,y+16);
    gr.addColorStop(0,'#38445a'); gr.addColorStop(.45,'#232c3a'); gr.addColorStop(1,'#141a24');
    g.fillStyle=gr; g.fillRect(0,y,s,16);
    g.strokeStyle='rgba(8,10,16,.7)'; g.lineWidth=1.4;
    for(let cx=0;cx<8;cx++){ g.beginPath(); g.arc(cx*16+8,y+16,8,Math.PI,0); g.stroke(); }
  }
});
const lanternTex = makeTex(64,(g,s)=>{
  const gr=g.createLinearGradient(0,0,0,s);
  gr.addColorStop(0,'#e83818'); gr.addColorStop(.5,'#ff4a20'); gr.addColorStop(1,'#c22410');
  g.fillStyle=gr; g.fillRect(0,0,s,s);
  g.strokeStyle='rgba(120,10,0,.55)'; g.lineWidth=2;
  for(let x=4;x<s;x+=8){ g.beginPath(); g.moveTo(x,0); g.lineTo(x,s); g.stroke(); }
});
const windowTex = makeTex(128,(g,s)=>{
  const gr=g.createRadialGradient(s/2,s/2,8,s/2,s/2,s*0.7);
  gr.addColorStop(0,'#ffd9a0'); gr.addColorStop(.6,'#ffb45e'); gr.addColorStop(1,'#d98a3a');
  g.fillStyle=gr; g.fillRect(0,0,s,s);
  g.strokeStyle='#2a1a10'; g.lineWidth=7; g.strokeRect(0,0,s,s);
  g.lineWidth=4;
  for(let i=1;i<3;i++){ g.beginPath(); g.moveTo(i*s/3,0); g.lineTo(i*s/3,s); g.stroke();
    g.beginPath(); g.moveTo(0,i*s/3); g.lineTo(s,i*s/3); g.stroke(); }
  g.lineWidth=2.4;
  g.beginPath(); g.moveTo(0,0); g.lineTo(s,s); g.moveTo(s,0); g.lineTo(0,s); g.stroke();
});
const canopyTex = makeTex(64,(g,s)=>{
  g.fillStyle='#191410'; g.fillRect(0,0,s,s);
  for(let y=0;y<s;y+=8){ g.fillStyle=y%16?'#221b14':'#14100c'; g.fillRect(0,y,s,4); }
  g.strokeStyle='rgba(60,46,30,.5)'; g.lineWidth=1;
  for(let x=0;x<s;x+=10){ g.beginPath(); g.moveTo(x,0); g.lineTo(x,s); g.stroke(); }
});
const glowTex = makeTex(128,(g,s)=>{
  const gr=g.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2);
  gr.addColorStop(0,'rgba(255,255,255,1)'); gr.addColorStop(.25,'rgba(255,255,255,.5)');
  gr.addColorStop(.6,'rgba(255,255,255,.12)'); gr.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle=gr; g.fillRect(0,0,s,s);
});

/* ================= renderer / scene ================= */
try{
  renderer = new THREE.WebGLRenderer({antialias:true, powerPreference:'high-performance'});
}catch(e){ document.getElementById('err').style.display='flex'; return; }
renderer.setPixelRatio(Math.min(devicePixelRatio, dprCap));
renderer.setSize(W,H);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
document.getElementById('stage').appendChild(renderer.domElement);

scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(C.duskFog.clone(), 0.0058);
camera = new THREE.PerspectiveCamera(55, W/H, 0.1, 700);
camera.position.set(2, 8.5, 30);

controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.target.set(0, 3.2, -35);
controls.enableDamping = true; controls.dampingFactor = 0.06;
controls.minDistance = 5; controls.maxDistance = 120;
controls.maxPolarAngle = 1.53; controls.minPolarAngle = 0.12;
controls.autoRotateSpeed = 0.5;

hemi = new THREE.HemisphereLight(C.duskHemi, C.duskGround, 0.55); scene.add(hemi);
sunLight = new THREE.DirectionalLight(C.sun, 1.3);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(1024,1024);
sunLight.shadow.camera.left=-55; sunLight.shadow.camera.right=55;
sunLight.shadow.camera.top=70; sunLight.shadow.camera.bottom=-70;
sunLight.shadow.camera.near=10; sunLight.shadow.camera.far=300;
sunLight.shadow.bias=-0.0006;
scene.add(sunLight); scene.add(sunLight.target);
moonLight = new THREE.DirectionalLight(C.moon, 0);
scene.add(moonLight); scene.add(moonLight.target);

/* ================= sky ================= */
const skyUni = {
  uNight:{value:0}, uTime:{value:0},
  uSunDir:{value:sunDir(0)}, uMoonDir:{value:MOON_DIR},
  uFogColor:{value:C.duskFog.clone()}
};
sky = new THREE.Mesh(new THREE.SphereGeometry(420,32,20), new THREE.ShaderMaterial({
  side:THREE.BackSide, depthWrite:false, fog:false,
  uniforms:skyUni,
  vertexShader:`varying vec3 vDir; void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader:`
    uniform float uNight,uTime; uniform vec3 uSunDir,uMoonDir,uFogColor;
    varying vec3 vDir;
    float hash(vec3 p){ return fract(sin(dot(p,vec3(12.9898,78.233,45.164)))*43758.5453); }
    float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
      float a=hash(vec3(i,1.0)),b=hash(vec3(i+vec2(1,0),1.0)),c=hash(vec3(i+vec2(0,1),1.0)),d=hash(vec3(i+vec2(1,1),1.0));
      return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
    void main(){
      vec3 d=normalize(vDir);
      float h=clamp(d.y,-0.05,1.0);
      float n=uNight;
      vec3 H=mix(vec3(1.0,0.52,0.22), vec3(0.075,0.12,0.19), n);
      vec3 M=mix(vec3(0.62,0.34,0.46), vec3(0.035,0.065,0.125), n);
      vec3 Z=mix(vec3(0.18,0.22,0.42), vec3(0.012,0.022,0.055), n);
      vec3 col=mix(mix(H,M,smoothstep(0.0,0.28,h)), Z, smoothstep(0.22,0.75,h));
      float cl=noise(d.xz/(abs(d.y)+0.25)*2.2+vec2(uTime*0.008,0.0));
      cl+=0.5*noise(d.xz/(abs(d.y)+0.25)*5.0-vec2(uTime*0.012,0.0));
      col+=mix(vec3(0.9,0.45,0.3),vec3(0.1,0.14,0.22),n)*smoothstep(0.75,1.15,cl)*0.14*(1.0-smoothstep(0.3,0.6,h));
      float sd=max(dot(d,uSunDir),0.0);
      col+=vec3(1.0,0.55,0.25)*(pow(sd,1500.0)*1.3+pow(sd,24.0)*0.22)*(1.0-n);
      float md=max(dot(d,uMoonDir),0.0);
      float disc=smoothstep(0.99955,0.99985,md);
      float crater=noise(d.xz*400.0)*0.25;
      col+=(vec3(0.92,0.96,1.0)-crater)*disc*n*1.25+vec3(0.45,0.6,0.9)*pow(md,50.0)*0.28*n;
      vec3 cell=floor(d*170.0);
      float hs=hash(cell);
      float star=step(0.9965,hs)*n*smoothstep(0.04,0.3,d.y);
      star*=smoothstep(0.4,0.05,length(fract(d*170.0)-0.5));
      col+=vec3(0.85,0.9,1.0)*star*(0.55+0.45*sin(uTime*(1.0+hs*4.0)+hs*40.0))*1.6;
      col=mix(col,uFogColor,smoothstep(0.22,0.0,d.y)*0.65);
      gl_FragColor=vec4(col,1.0);
    }`
}));
scene.add(sky);

/* ================= merged static geometry ================= */
const unitBox = new THREE.BoxGeometry(1,1,1);
const buckets = {};
/* 奖励换房：被选作「地块」的民居单独成组（不并进全河大网格），得到奖励时整栋隐藏 */
let curSlot=null;
function bucket(name){ const k=curSlot?curSlot+'|'+name:name; if(!buckets[k]) buckets[k]=[]; return buckets[k]; }
const _m4=new THREE.Matrix4(), _q=new THREE.Quaternion(), _e=new THREE.Euler();
function pushGeo(name, geo, x,y,z, sx=1,sy=1,sz=1, rx=0,ry=0,rz=0){
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  _e.set(rx,ry,rz); _q.setFromEuler(_e);
  _m4.compose(new THREE.Vector3(x,y,z), _q, new THREE.Vector3(sx,sy,sz));
  g.applyMatrix4(_m4);
  bucket(name).push(g);
}
function box(name,w,h,d,x,y,z,ry=0,rz=0,rx=0){ pushGeo(name,unitBox,x,y,z,w,h,d,rx,ry,rz); }

/* roof: unit triangular prism, ridge along z at y=1, eaves y=0 x=±1, z=±1 */
function prismGeo(){
  const v=[
    // left slope
    -1,0,-1,  0,1,1,  0,1,-1,   -1,0,-1,  -1,0,1,  0,1,1,
    // right slope
    1,0,-1,  0,1,-1,  0,1,1,   1,0,-1,  0,1,1,  1,0,1,
    // gables
    -1,0,-1, 0,1,-1, 1,0,-1,   1,0,1, 0,1,1, -1,0,1,
    // bottom
    -1,0,-1, 1,0,1, -1,0,1,   -1,0,-1, 1,0,-1, 1,0,1
  ];
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(v,3));
  const uv=[]; for(let i=0;i<v.length;i+=3){ uv.push(v[i]*0.5+0.5, v[i+2]*0.5+0.5); }
  g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  g.computeVertexNormals();
  return g;
}
const unitPrism = prismGeo();
const unitCyl = new THREE.CylinderGeometry(1,1,1,10);
const unitCone = new THREE.CylinderGeometry(0,1,1,10);

/* materials */
const M = {
  wall:  new THREE.MeshStandardMaterial({color:0xf0e7d4, roughness:0.92}),
  wall2: new THREE.MeshStandardMaterial({color:0xe2dbc8, roughness:0.92}),
  wall3: new THREE.MeshStandardMaterial({color:0xd8d4c4, roughness:0.95}),
  roof:  new THREE.MeshStandardMaterial({color:0x8a94a4, map:tileTex, bumpMap:tileTex, bumpScale:0.03, roughness:0.85}),
  ridge: new THREE.MeshStandardMaterial({color:0x1a212c, roughness:0.8}),
  wood:  new THREE.MeshStandardMaterial({color:0x4a3423, roughness:0.82}),
  woodDark:new THREE.MeshStandardMaterial({color:0x2b1e14, roughness:0.85}),
  stone: new THREE.MeshStandardMaterial({color:0x9aa0a8, map:stoneTex, bumpMap:stoneTex, bumpScale:0.04, roughness:0.9}),
  stoneDark:new THREE.MeshStandardMaterial({color:0x6a7078, map:stoneTex, roughness:0.95}),
  green: new THREE.MeshStandardMaterial({color:0x2a4022, roughness:0.9}),
  paper: new THREE.MeshStandardMaterial({color:0xb03018, roughness:0.7, emissive:0x481004, emissiveIntensity:0.4}),
  dark:  new THREE.MeshStandardMaterial({color:0x141a24, roughness:1}),
  silhouette:new THREE.MeshStandardMaterial({color:0x111824, roughness:1})
};
const wallKeys=['wall','wall2','wall3'];

/* window instancing：每扇窗记住位置和「天生亮着」的概率，亮灭由游戏决定 */
const windows=[]; // {m, pos, ry, p}
function hash01(i){ const x=Math.sin(i*127.1+311.7)*43758.5453; return x-Math.floor(x); }
function addWindow(x,y,z,ry,p,sx,sy){
  _e.set(0,ry,0); _q.setFromEuler(_e);
  _m4.compose(new THREE.Vector3(x,y,z),_q,new THREE.Vector3(sx||1,sy||1,1));
  windows.push({m:_m4.clone(), pos:new THREE.Vector3(x,y,z), ry, p, slot:curSlot});
}

/* lantern anchors */
const lanterns=[]; // {ax,ay,az, len, phase, size}
function addLantern(ax,ay,az,len=0.34,size=1){
  lanterns.push({ax,ay,az,len,phase:Math.random()*Math.PI*2,size,slot:curSlot});
}

/* ================= town generation ================= */
const RIVER_HALF=7, BANK_TOP=1.3, HOUSE_FRONT=9.2;
const BRIDGE_Z=-22;

function house(side, z, w, twoFloor, seed){
  const dir = side; // +1 right bank (x>0), -1 left
  const depth = 6+((seed*7)%3);
  const wallH = twoFloor? 5.6 : 3.6;
  const cx = dir*(HOUSE_FRONT+depth/2);
  const frontX = dir*HOUSE_FRONT;
  const y0 = BANK_TOP;
  const wk = wallKeys[Math.floor(seed*3)%3];
  const ry = dir>0? -Math.PI/2 : Math.PI/2; // face river
  // plinth + walls
  box('stoneDark', depth+0.3, 0.6, w+0.3, cx, y0+0.3, z);
  box(wk, depth, wallH, w, cx, y0+0.6+wallH/2, z);
  // roof
  const roofY = y0+0.6+wallH;
  pushGeo('roof', unitPrism, cx, roofY, z, depth/2+0.8, 1.7+((seed*5)%0.6), w/2+0.9);
  box('ridge', 0.22, 0.22, w+1.9, cx, roofY+1.72+((seed*5)%0.6), z);
  // upturned eave corners
  for(const sz of [-1,1]) for(const sx of [-1,1]){
    box('ridge', 0.5,0.12,0.3, cx+sx*(depth/2+0.75), roofY+0.18, z+sz*(w/2+0.85), 0, sx*0.5*dir, sz*0.35);
  }
  // tile ribs down the slopes
  const slopeL=Math.hypot(depth/2+0.8, 1.7);
  const ang=Math.atan2(1.7, depth/2+0.8);
  const nRibs=Math.max(3,Math.floor(w/1.15));
  for(let i=0;i<=nRibs;i++){
    const zz=z-w/2-0.6+i*(w+1.2)/nRibs;
    for(const sx of [-1,1]){
      pushGeo('ridge', unitBox, cx+sx*(depth/4+0.4), roofY+0.87, zz, slopeL,0.055,0.07, 0,0, -sx*ang);
    }
  }
  // 马头墙 stepped gables on some houses
  if(seed%1<0.45){
    for(const sz of [-1,1]){
      const gz=z+sz*(w/2+0.06);
      for(let st=0;st<3;st++){
        const sw=depth*(1-st*0.28), sh=0.55;
        const sy=roofY+0.4+st*0.55;
        box(wk, sw, sh, 0.3, cx, sy, gz);
        box('ridge', sw+0.25, 0.12, 0.42, cx, sy+sh/2+0.06, gz);
      }
    }
  }
  // door + couplets facing river
  const doorY=y0+0.6;
  box('woodDark', 0.14, 2.1, 1.3, frontX-dir*0.06, doorY+1.05, z);
  box('wood', 0.2, 0.18, 1.7, frontX-dir*0.08, doorY+2.25, z);
  for(const sz of [-1,1]) box('paper', 0.04, 1.5, 0.24, frontX-dir*0.1, doorY+1.35, z+sz*0.95);
  // windows
  const winY1=doorY+1.6, winY2=doorY+3.9;
  const nWin=Math.max(2,Math.floor(w/2.6));
  for(let i=0;i<nWin;i++){
    const zz=z-w/2+1.2+i*(w-2.4)/Math.max(1,nWin-1);
    if(Math.abs(zz-z)<1.0) continue;
    addWindow(frontX-dir*0.04, winY1, zz, ry, 0.5);
    if(twoFloor) addWindow(frontX-dir*0.04, winY2, zz, ry, 0.4);
  }
  // eave lanterns
  const eaveY=roofY-0.25;
  const nL=seed%1<0.6?3:2;
  for(let i=0;i<nL;i++){
    const zz=z-w/2+0.9+i*(w-1.8)/Math.max(1,nL-1);
    addLantern(frontX-dir*0.55, eaveY, zz, 0.3+Math.random()*0.14, 0.9+Math.random()*0.35);
  }
  // wooden balcony over water on some
  if(seed%1<0.5){
    const by=doorY+2.5, bx=frontX-dir*0.75;
    box('wood', 1.6, 0.12, w*0.6, bx, by, z);
    box('wood', 0.08, 0.75, w*0.6, bx-dir*0.72, by+0.42, z);
    const nP=Math.floor(w*0.6/0.8);
    for(let i=0;i<=nP;i++) box('wood', 0.07,0.75,0.07, bx-dir*0.72, by+0.42, z-w*0.3+i*(w*0.6)/nP);
    for(const sz of [-1,1]) box('woodDark', 0.14, by+0.1, 0.14, bx-dir*0.6, (by+0.1)/2, z+sz*w*0.27);
    addLantern(bx-dir*0.7, by+1.5, z, 0.26, 0.85);
    box('wood', 0.08, 1.6, 0.08, bx-dir*0.7, by+0.8, z);
  }
  // 河埠头 stone steps into water
  if(seed%1<0.3){
    for(let st=0;st<4;st++){
      box('stone', 1.1, 0.32, 2.4, frontX-dir*(0.4+st*0.55), BANK_TOP-0.15-st*0.32, z+w/2+1.6);
    }
  }
}

let seedI=0;
function rnd(){ seedI=(seedI*9301+49297)%233280; return seedI/233280; }
/* 地块：望全河、河埠头都看得见的三栋临河民居（按原生成结果里的位置挑；民居本身原样生成） */
const SLOT_DEFS=[{id:'teahouse',side:-1,c:4.2},{id:'pavilion',side:1,c:-1.5},{id:'archway',side:-1,c:-8.9}];
/* 这几栋临河民居换成 Tripo 的三种房子（models/manifest.json 的 scene 一栏登记了才换）。
   房子的窗口事先按模型正面量好（归一化坐标），生成时就登记成「GLB 窗」：模型没出来前藏着，模型一出来，原民居藏起、GLB 窗接手点亮 */
const GLB_HOUSES=[{id:'g1',side:-1,c:18.2,v:'house_c'},{id:'g2',side:-1,c:-41.3,v:'house_a'},{id:'g3',side:-1,c:-67.8,v:'house_b'},
  {id:'g4',side:1,c:9.2,v:'house_a'},{id:'g5',side:1,c:29.4,v:'house_b'},{id:'g6',side:1,c:-53.5,v:'house_c'},{id:'g7',side:1,c:-77.9,v:'house_a'}];
const HOUSE_V={
  house_a:{H:8.6,hm:0.978,zf:0.448,win:[[-0.222,0.554,0.144,0.096],[0,0.554,0.205,0.096],[0.223,0.554,0.144,0.096],[-0.215,0.222,0.144,0.144],[0.216,0.222,0.144,0.144]],lan:[]},
  house_b:{H:6.8,hm:0.839,zf:0.388,win:[[-0.24,0.29,0.2,0.18],[0.237,0.29,0.2,0.18]],lan:[]},
  house_c:{H:8.6,hm:0.963,zf:0.490,win:[[-0.227,0.479,0.136,0.091],[-0.004,0.479,0.144,0.091],[0.219,0.479,0.136,0.091],[-0.235,0.188,0.136,0.113],[0.227,0.188,0.136,0.113]],lan:[[-0.33,0.34],[0.33,0.34]]}
};
const GLB_FRONT=9.5; // GLB 房子正面（含台阶）对齐到 |x|=9.5，压在步道边
function glbHouseXform(def){ const V=HOUSE_V[def.v], k=V.H/V.hm, s=def.side; return {k,s,O:new THREE.Vector3(s*(GLB_FRONT+k*V.zf),BANK_TOP,def.c),ry:s>0?-Math.PI/2:Math.PI/2}; }
function glbToWorld(def,xm,ym,zm){ const T=glbHouseXform(def); return new THREE.Vector3(T.O.x-T.s*T.k*zm,T.O.y+T.k*ym,T.O.z+T.s*T.k*xm); }
const slots={};      // id -> {side,c,w,depth,group}
const slotHidden={}; // id -> bool
for(const side of [-1,1]){
  let z=34;
  while(z>-142){
    const w=7+rnd()*5;
    if(z-w/2>BRIDGE_Z+6 || z+w/2<BRIDGE_Z-6){
      const two=rnd()<0.62, sd=rnd()*10, c=z-w/2;
      const sl=SLOT_DEFS.find(d=>d.side===side&&Math.abs(d.c-c)<0.3)||GLB_HOUSES.find(d=>d.side===side&&Math.abs(d.c-c)<0.3);
      if(sl){ curSlot=sl.id; slots[sl.id]={side,c,w,depth:6+((sd*7)%3),twoFloor:two,group:null,glb:sl.v||null}; slotHidden[sl.id]=false; }
      house(side, c, w, two, sd);
      if(sl&&sl.v){ /* GLB 房子的窗和灯：同一个地块，反着藏（原民居显示时它们藏着） */
        const V=HOUSE_V[sl.v], T=glbHouseXform(sl);
        for(const [xm,ym,wm,hm] of V.win){ const p=glbToWorld(sl,xm,ym,V.zf+0.01); addWindow(p.x,p.y,p.z,T.ry,0.45,wm*T.k/0.95,hm*T.k/1.15); windows[windows.length-1].glb=true; windows[windows.length-1].glbAnchor=[xm,ym]; }
        for(const [xm,ym] of V.lan){ const p=glbToWorld(sl,xm,ym,V.zf+0.08); addLantern(p.x,p.y,p.z,0.32,1.0); lanterns[lanterns.length-1].glb=true; }
      }
      curSlot=null;
    }
    z-=w+0.6+rnd()*2.2;
  }
}

/* embankments */
for(const side of [-1,1]){
  box('stoneDark', 1.0, BANK_TOP+0.4, 182, side*(RIVER_HALF+0.5), (BANK_TOP+0.4)/2-0.4, -53);
  box('stone', 2.6, 0.18, 182, side*(RIVER_HALF+1.3), BANK_TOP+0.09, -53);
  // mooring posts
  for(let z=30;z>-140;z-=13){
    pushGeo('woodDark', unitCyl, side*(RIVER_HALF+0.9), BANK_TOP+0.45, z, 0.09,0.8,0.09);
  }
}

/* ================= stone arch bridge ================= */
curSlot='bridge'; slots.bridge={side:0,c:BRIDGE_Z,w:26,depth:4.6,group:null}; slotHidden.bridge=false; // 程序拱桥单独成组，Tripo 拱桥接手时整组藏起
(function bridge(){
  const W2=13, base=0.0, deckEnd=3.1, deckMid=5.5, depth=4.6, R=5.6;
  const sh=new THREE.Shape();
  sh.moveTo(-W2,base); sh.lineTo(-W2,deckEnd);
  sh.quadraticCurveTo(0,deckMid+1.15, W2,deckEnd);
  sh.lineTo(W2,base); sh.lineTo(-W2,base);
  const hole=new THREE.Path();
  hole.absarc(0,0.15,R,0,Math.PI,false); hole.closePath();
  sh.holes.push(hole);
  const g=new THREE.ExtrudeGeometry(sh,{depth,bevelEnabled:false,curveSegments:40});
  g.translate(0,0,-depth/2);
  pushGeo('stone', g, 0,0,BRIDGE_Z);
  // deck steps + railings
  const deckY=x=>deckEnd+(deckMid-deckEnd)*Math.cos(x/W2*Math.PI/2)+0.28*Math.cos(x/W2*Math.PI/2);
  for(let x=-W2+0.5;x<W2-0.4;x+=0.85){
    box('stoneDark', 0.8,0.14,depth-0.3, x, deckY(x)+0.05, BRIDGE_Z);
  }
  const railPts=[];
  for(let x=-W2;x<=W2;x+=1.0) railPts.push(new THREE.Vector3(x,deckY(x)+0.95,BRIDGE_Z));
  for(const sz of [-1,1]){
    const pts=railPts.map(p=>new THREE.Vector3(p.x,p.y,p.z+sz*(depth/2-0.12)));
    const tube=new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts),32,0.09,6);
    pushGeo('stoneDark', tube, 0,0,0);
    for(let x=-W2+0.3;x<=W2-0.2;x+=1.55){
      box('stone', 0.16,0.95,0.16, x, deckY(x)+0.48, BRIDGE_Z+sz*(depth/2-0.12));
      box('stone', 0.26,0.12,0.26, x, deckY(x)+1.0, BRIDGE_Z+sz*(depth/2-0.12));
    }
    // approach steps down to bank
    for(let st=0;st<7;st++){
      const sx=(W2+0.4+st*0.62);
      box('stone', 0.62,0.3,depth, sz*sx, deckEnd-0.1-st*0.3, BRIDGE_Z);
    }
    // lantern posts at both bridge ends
    for(const ex of [-1,1]){
      const px=ex*(W2+0.3), pz=BRIDGE_Z+sz*(depth/2+0.35);
      pushGeo('woodDark', unitCyl, px, BANK_TOP+1.5, pz, 0.09,3.0,0.09);
      box('wood', 0.7,0.08,0.08, px-ex*0.25, BANK_TOP+2.95, pz);
      addLantern(px-ex*0.55, BANK_TOP+2.9, pz, 0.3, 1.15);
    }
  }
})();
curSlot=null;

/* ================= willows ================= */
const willows=[];
function willow(x,z,s=1){
  const grp=new THREE.Group(); grp.position.set(x,BANK_TOP,z);
  const geos=[];
  const trunk=new THREE.CylinderGeometry(0.14*s,0.22*s,3.2*s,8);
  trunk.translate(0,1.6*s,0); geos.push(trunk.toNonIndexed());
  for(let i=0;i<14;i++){
    const a=i/14*Math.PI*2+rnd();
    const r=(0.9+rnd()*0.7)*s;
    const pts=[new THREE.Vector3(0,3.1*s,0),
      new THREE.Vector3(Math.cos(a)*r*0.7,3.3*s,Math.sin(a)*r*0.7),
      new THREE.Vector3(Math.cos(a)*r*1.15,2.2*s,Math.sin(a)*r*1.15),
      new THREE.Vector3(Math.cos(a)*r*1.35,(0.7+rnd()*0.6)*s,Math.sin(a)*r*1.35)];
    const t=new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts),8,0.035*s,5);
    geos.push(t.toNonIndexed());
  }
  const merged=THREE.BufferGeometryUtils.mergeBufferGeometries(geos);
  const mesh=new THREE.Mesh(merged,M.green);
  mesh.castShadow=true; grp.add(mesh); scene.add(grp);
  willows.push({grp,phase:rnd()*6});
}
willow(-10.6,-14,1.15); willow(10.8,-30,1.0); willow(-10.4,12,0.9); willow(10.5,-64,1.2);

/* ================= distant pagoda & hills ================= */
(function distant(){
  const px=7, pz=-152;
  for(let i=0;i<5;i++){
    const w=6.5-i*1.05, y=2+i*3.6;
    box('silhouette', w*0.6,3.4,w*0.6, px,y+1.7,pz);
    pushGeo('silhouette', unitPrism, px,y+3.4,pz, w*0.78,1.3,w*0.78);
  }
  pushGeo('silhouette', unitCone, px,21.5,pz, 0.5,3.5,0.5);
  const hillGeo=new THREE.SphereGeometry(1,16,10);
  pushGeo('silhouette', hillGeo, -45,-4,-185, 60,16,30);
  pushGeo('silhouette', hillGeo, 40,-6,-195, 75,20,35);
  pushGeo('silhouette', hillGeo, 0,-8,-215, 110,24,40);
})();

/* finalize merged buckets */
const staticMeshes=[];
for(const key of Object.keys(buckets)){
  const merged=THREE.BufferGeometryUtils.mergeBufferGeometries(buckets[key]);
  const kk=key.slice(key.indexOf('|')+1);
  if(kk==='stone'||kk==='stoneDark'){
    const pos=merged.attributes.position, uv=merged.attributes.uv;
    for(let i=0;i<pos.count;i++){ uv.setXY(i,(pos.getX(i)+pos.getZ(i))*0.22, pos.getY(i)*0.22); }
  }
  if(kk==='roof'){
    const pos=merged.attributes.position, uv=merged.attributes.uv;
    for(let i=0;i<pos.count;i++){ uv.setXY(i, pos.getZ(i)*0.9+pos.getX(i)*0.15, pos.getY(i)*1.6); }
  }
  const bar=key.indexOf('|'), mk=bar>=0?key.slice(bar+1):key;
  const mesh=new THREE.Mesh(merged,M[mk]);
  mesh.castShadow=true; mesh.receiveShadow=true;
  if(bar>=0){
    const id=key.slice(0,bar), sl=slots[id];
    if(!sl.group){ sl.group=new THREE.Group(); sl.group.name='slot:'+id; scene.add(sl.group); }
    sl.group.add(mesh);
  }else{ scene.add(mesh); staticMeshes.push(mesh); }
  buckets[key].length=0;
}

/* windows instanced */
const winGeo=new THREE.PlaneGeometry(0.95,1.15);
const winLitMat=new THREE.MeshStandardMaterial({map:windowTex,emissive:0xffffff,emissiveMap:windowTex,emissiveIntensity:0.1,roughness:0.6});
const winDarkMat=new THREE.MeshStandardMaterial({color:0x1c222b,roughness:0.7});
const NW=windows.length;
const winLitIM=new THREE.InstancedMesh(winGeo,winLitMat,NW);
const winDarkIM=new THREE.InstancedMesh(winGeo,winDarkMat,NW);
scene.add(winLitIM); scene.add(winDarkIM);
const ZERO_M=new THREE.Matrix4().makeScale(0,0,0);
const winState=new Uint8Array(NW); // 1=亮
for(let i=0;i<NW;i++) windows[i].base = hash01(i) < windows[i].p;
const winHidden=i=>{ const w=windows[i]; if(!w.slot) return false; return w.glb?!slotHidden[w.slot]:!!slotHidden[w.slot]; };
function applyWindow(i){
  const h=winHidden(i);
  winLitIM.setMatrixAt(i, winState[i]&&!h?windows[i].m:ZERO_M);
  winDarkIM.setMatrixAt(i, winState[i]||h?ZERO_M:windows[i].m);
}
/* 地块上的民居隐藏/恢复：墙、顶、门、阳台、石阶（同一组）+ 窗户 + 灯笼一起 */
function setSlotHidden(id,hidden){
  const sl=slots[id]; if(!sl) return;
  hidden=!!hidden; if(slotHidden[id]===hidden) return;
  slotHidden[id]=hidden;
  if(sl.group) sl.group.visible=!hidden;
  for(let i=0;i<windows.length;i++) if(windows[i].slot===id) applyWindow(i);
  winLitIM.instanceMatrix.needsUpdate=true; winDarkIM.instanceMatrix.needsUpdate=true;
  renderer.shadowMap.needsUpdate=true;
}
function resetWindows(extraLit){
  for(let i=0;i<NW;i++){ winState[i]=windows[i].base?1:0; }
  if(extraLit) for(const i of extraLit) if(i>=0&&i<NW) winState[i]=1;
  for(let i=0;i<NW;i++) applyWindow(i);
  winLitIM.instanceMatrix.needsUpdate=true; winDarkIM.instanceMatrix.needsUpdate=true;
}
resetWindows(null);
const _frus=new THREE.Frustum(), _pv=new THREE.Matrix4();
/* 点亮一扇原本暗着的窗：优先镜头里看得见、离 near 最近的；返回窗户编号，没有可亮的返回 -1 */
function lightWindow(near, quiet){
  camera.updateMatrixWorld();
  _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); _frus.setFromProjectionMatrix(_pv);
  let best=-1, bs=Infinity;
  for(let i=0;i<NW;i++){
    if(winState[i]||winHidden(i)) continue;
    const w=windows[i].pos;
    let sc = near ? w.distanceTo(near) : w.distanceTo(camera.position);
    if(!_frus.containsPoint(w)) sc+=400;
    else if(w.distanceTo(camera.position)>85) sc+=120;
    sc += hash01(i+999)*6;
    if(sc<bs){ bs=sc; best=i; }
  }
  if(best<0) return -1;
  winState[best]=1; applyWindow(best);
  winLitIM.instanceMatrix.needsUpdate=true; winDarkIM.instanceMatrix.needsUpdate=true;
  if(!quiet) pulseAt(windows[best].pos, windows[best].ry);
  return best;
}

/* ================= lanterns (instanced, swaying) ================= */
const NL=lanterns.length;
const lampBodyGeo=new THREE.SphereGeometry(0.28,14,12); lampBodyGeo.scale(1,0.8,1);
const lampMat=new THREE.MeshStandardMaterial({map:lanternTex,emissive:0xff3a14,emissiveMap:lanternTex,emissiveIntensity:0.5,roughness:0.55});
/* 每盏灯笼的亮度放在 instanceColor 里（0.3=未点 1=点亮），这里让自发光也跟着它走 */
lampMat.onBeforeCompile=sh=>{
  sh.fragmentShader=sh.fragmentShader.replace('#include <emissivemap_fragment>',
    '#include <emissivemap_fragment>\n#ifdef USE_INSTANCING_COLOR\n totalEmissiveRadiance *= clamp((vColor.r-0.3)/0.7,0.0,1.0);\n#endif');
};
const goldMat=new THREE.MeshStandardMaterial({color:0xc9962e,metalness:0.6,roughness:0.4,emissive:0x553a08,emissiveIntensity:0.3});
const tasselMat=new THREE.MeshStandardMaterial({color:0xd83a1a,emissive:0x661005,emissiveIntensity:0.5,roughness:0.6});
const stringMat=new THREE.MeshBasicMaterial({color:0x1a120c});
const lampBody=new THREE.InstancedMesh(lampBodyGeo,lampMat,NL);
const lampCapT=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.13,0.15,0.09,10),goldMat,NL);
const lampCapB=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.11,0.09,0.07,10),goldMat,NL);
const lampTassel=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.025,0.045,0.24,6),tasselMat,NL);
const lampString=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.012,0.012,1,4),stringMat,NL);
[lampBody,lampCapT,lampCapB,lampTassel,lampString].forEach(m=>{
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m);
});
const lampPos=[]; for(let i=0;i<NL;i++) lampPos.push(new THREE.Vector3());
/* 点灯顺序：从拱桥向两头一盏盏亮开 */
const lampGlow=new Float32Array(NL), lampTarget=new Float32Array(NL);
const lampOrder=[...Array(NL).keys()].sort((a,b)=>(Math.abs(lanterns[a].az-BRIDGE_Z)+Math.abs(lanterns[a].ax)*0.3)-(Math.abs(lanterns[b].az-BRIDGE_Z)+Math.abs(lanterns[b].ax)*0.3));
const _ic=new THREE.Color();
for(let i=0;i<NL;i++) lampBody.setColorAt(i,_ic.setScalar(0.3));
/* real point lights on a spread of lanterns */
const lampLights=[];
const lightIdx=[];
for(let i=0;i<8;i++) lightIdx.push(Math.floor(i*(NL-5)/7));
lightIdx.push(NL-3,NL-2);
for(const i of lightIdx){
  const pl=new THREE.PointLight(0xff6a30,0,19,2);
  scene.add(pl); lampLights.push({pl,idx:i});
}

/* glow halos (points)：前 NL 个给灯笼，后面留给船灯、窗光等动态光点 */
const HALO_EXTRA=48;
const haloN=NL+HALO_EXTRA;
const haloGeo=new THREE.BufferGeometry();
const haloPos=new Float32Array(haloN*3), haloSize=new Float32Array(haloN), haloPhase=new Float32Array(haloN), haloCol=new Float32Array(haloN*3);
for(let i=0;i<haloN;i++){
  haloSize[i]=i<NL? 2.4*lanterns[i].size : 1.6;
  haloPhase[i]=Math.random()*6.28;
  haloCol[i*3]=0; haloCol[i*3+1]=0; haloCol[i*3+2]=0;
  if(i>=NL) haloPos[i*3+1]=-500;
}
haloGeo.setAttribute('position',new THREE.BufferAttribute(haloPos,3).setUsage(THREE.DynamicDrawUsage));
haloGeo.setAttribute('aSize',new THREE.BufferAttribute(haloSize,1));
haloGeo.setAttribute('aPhase',new THREE.BufferAttribute(haloPhase,1));
haloGeo.setAttribute('aColor',new THREE.BufferAttribute(haloCol,3));
const haloUni={uTime:{value:0},uIntensity:{value:0},uTex:{value:glowTex},uPR:{value:1}};
const haloMat=new THREE.ShaderMaterial({
  transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
  uniforms:haloUni,
  vertexShader:`
    attribute float aSize,aPhase; attribute vec3 aColor;
    uniform float uTime,uPR; varying vec3 vC; varying float vA;
    void main(){ vC=aColor; vA=0.72+0.28*sin(uTime*2.2+aPhase);
      vec4 mv=modelViewMatrix*vec4(position,1.0);
      gl_PointSize=aSize*(240.0/max(1.0,-mv.z))*uPR;
      gl_Position=projectionMatrix*mv; }`,
  fragmentShader:`
    uniform sampler2D uTex; uniform float uIntensity;
    varying vec3 vC; varying float vA;
    void main(){ vec4 t=texture2D(uTex,gl_PointCoord);
      gl_FragColor=vec4(vC,t.a*vA*uIntensity); }`
});
const halos=new THREE.Points(haloGeo,haloMat); halos.frustumCulled=false; halos.layers.set(1); scene.add(halos);
camera.layers.enable(1);

/* ================= water: real-time reflector + procedural waves ================= */
const rippleData=[]; for(let i=0;i<12;i++) rippleData.push(new THREE.Vector4(0,0,-100,0));
let rippleIdx=0;
function spawnRipple(x,z,amp){ rippleData[rippleIdx].set(x,z,elapsed,amp); rippleIdx=(rippleIdx+1)%12; }
const waterShader={
  uniforms:{
    color:{value:null}, tDiffuse:{value:null}, textureMatrix:{value:null},
    uTime:{value:0}, uNight:{value:0}, uWaveAmp:{value:1},
    uSunDir:{value:sunDir(0)}, uMoonDir:{value:MOON_DIR},
    uFogColor:{value:C.duskFog.clone()}, uFogDensity:{value:0.0058},
    uRipples:{value:rippleData}
  },
  vertexShader:`
    uniform mat4 textureMatrix;
    varying vec4 vUvP; varying vec3 vWorld;
    void main(){
      vec4 wp=modelMatrix*vec4(position,1.0);
      vWorld=wp.xyz;
      vUvP=textureMatrix*vec4(position,1.0);
      gl_Position=projectionMatrix*viewMatrix*wp;
    }`,
  fragmentShader:`
    uniform vec3 color; uniform sampler2D tDiffuse;
    uniform float uTime,uNight,uWaveAmp,uFogDensity;
    uniform vec3 uSunDir,uMoonDir,uFogColor;
    uniform vec4 uRipples[12];
    varying vec4 vUvP; varying vec3 vWorld;
    void main(){
      vec2 p=vWorld.xz; float t=uTime;
      vec2 g=vec2(0.0);
      g+=vec2(cos(p.x*0.32+t*0.7),cos(p.y*0.26+t*0.55))*0.32;
      g+=vec2(cos(p.x*0.11-p.y*0.18+t*0.4),cos(p.y*0.14+p.x*0.1+t*0.33))*0.5;
      g+=vec2(sin(p.x*1.9+t*1.6+sin(p.y*1.2+t*0.5)),sin(p.y*2.2+t*1.3+sin(p.x*1.05)))*0.11;
      for(int i=0;i<12;i++){
        vec4 r=uRipples[i]; float age=t-r.z;
        if(age<0.0||age>4.0||r.w<=0.0) continue;
        vec2 dv=p-r.xy; float rr=length(dv)+1e-4;
        float front=age*1.7;
        float band=exp(-pow((rr-front)*2.0,2.0));
        float w=sin((rr-front)*9.0)*band*exp(-age*1.1)*r.w;
        g+=(dv/rr)*w*0.9;
      }
      vec2 uv=vUvP.xy/vUvP.w;
      uv+=g*0.028*uWaveAmp;
      vec3 refl=vec3(0.0); float wsum=0.0;
      for(int i=-3;i<=3;i++){
        float fi=float(i); float w=1.0-abs(fi)/4.0;
        vec2 off=vec2(g.x*0.004,fi*0.004*(1.0+length(g)*1.2))*uWaveAmp;
        refl+=texture2D(tDiffuse,clamp(uv+off,0.001,0.999)).rgb*w; wsum+=w;
      }
      refl/=wsum;
      refl*=color;
      vec3 V=normalize(cameraPosition-vWorld);
      float fres=pow(1.0-max(V.y,0.0),2.0);
      vec3 deep=mix(vec3(0.06,0.085,0.095),vec3(0.012,0.022,0.038),uNight);
      vec3 col=mix(deep,refl,clamp(0.38+0.58*fres,0.0,1.0));
      vec3 N=normalize(vec3(g.x*0.55*uWaveAmp,1.0,g.y*0.55*uWaveAmp));
      vec3 L=normalize(mix(uSunDir,uMoonDir,uNight));
      vec3 Hv=normalize(V+L);
      float spec=pow(max(dot(N,Hv),0.0),240.0);
      col+=mix(vec3(1.0,0.55,0.25),vec3(0.65,0.78,1.0),uNight)*spec*(0.35+uNight*0.55);
      float depth=length(cameraPosition-vWorld);
      float f=1.0-exp(-uFogDensity*uFogDensity*depth*depth);
      col=mix(col,uFogColor,clamp(f,0.0,1.0));
      gl_FragColor=vec4(col,1.0);
    }`
};
water=new THREE.Reflector(new THREE.PlaneGeometry(340,340),{
  clipBias:0.003, textureWidth:1024, textureHeight:1024,
  color:0x9fb4bd, shader:waterShader
});
water.rotation.x=-Math.PI/2; water.position.y=0;
scene.add(water);

/* ================= drifting fog layers ================= */
const fogLayers=[];
const fogMatProto={
  transparent:true,depthWrite:false,side:THREE.DoubleSide,
  uniforms:{uTime:{value:0},uColor:{value:C.duskFog.clone()},uOpacity:{value:0.15},uSeed:{value:0}},
  vertexShader:`varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader:`
    uniform float uTime,uOpacity,uSeed; uniform vec3 uColor; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
    float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
    float fbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<3;i++){ v+=a*noise(p); p*=2.1; a*=0.5; } return v; }
    void main(){
      vec2 q=vUv*vec2(5.0,1.6)+vec2(uTime*0.016+uSeed,uSeed*3.0);
      float n=fbm(q);
      float edge=smoothstep(0.0,0.22,vUv.x)*smoothstep(1.0,0.78,vUv.x)*smoothstep(0.0,0.3,vUv.y)*smoothstep(1.0,0.6,vUv.y);
      float a=smoothstep(0.38,0.8,n)*edge*uOpacity;
      gl_FragColor=vec4(uColor,a);
    }`
};
[[-12,3.4,0.16,90],[-46,4.2,0.2,110],[-88,5.0,0.24,130],[-128,6.0,0.28,150]].forEach((cfg,i)=>{
  const mat=new THREE.ShaderMaterial({
    transparent:true,depthWrite:false,side:THREE.DoubleSide,
    uniforms:THREE.UniformsUtils.clone(fogMatProto.uniforms),
    vertexShader:fogMatProto.vertexShader,fragmentShader:fogMatProto.fragmentShader
  });
  mat.uniforms.uSeed.value=i*7.3;
  const m=new THREE.Mesh(new THREE.PlaneGeometry(cfg[3],11),mat);
  m.position.set(0,cfg[1],cfg[0]); m.renderOrder=5; m.layers.set(1);
  scene.add(m); fogLayers.push({m,base:cfg[2]});
});

/* ================= volumetric light shafts ================= */
const shaftUni={uTime:{value:0},uIntensity:{value:0},uColor:{value:new THREE.Color(0xff7a35)}};
const shaftMat=new THREE.ShaderMaterial({
  transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide,
  uniforms:shaftUni,
  vertexShader:`varying vec2 vUv; varying vec3 vN,vW;
    void main(){ vUv=uv; vN=normalize(normalMatrix*normal);
      vec4 wp=modelMatrix*vec4(position,1.0); vW=wp.xyz;
      gl_Position=projectionMatrix*viewMatrix*wp; }`,
  fragmentShader:`
    uniform float uTime,uIntensity; uniform vec3 uColor;
    varying vec2 vUv; varying vec3 vN,vW;
    void main(){
      vec3 V=normalize(cameraPosition-vW);
      float body=pow(abs(dot(normalize(vN),V)),1.3);
      float streak=0.7+0.3*sin(vUv.x*44.0+sin(vUv.x*17.0+uTime*0.25)*2.0);
      float a=pow(vUv.y,1.9)*body*streak*uIntensity;
      gl_FragColor=vec4(uColor,a);
    }`
});
const shafts=[];
for(const li of lightIdx){
  const L=lanterns[li];
  const h=L.ay-0.3;
  const cone=new THREE.Mesh(new THREE.CylinderGeometry(0.14,1.9,h,12,1,true),shaftMat);
  cone.position.set(L.ax,h/2+0.15,L.az); cone.renderOrder=6; cone.layers.set(1);
  scene.add(cone); shafts.push(cone);
}
/* moonbeams slanting across the river near the bridge */
const moonShaftUni={uTime:{value:0},uIntensity:{value:0},uColor:{value:new THREE.Color(0x8fb8e8)}};
const moonShaftMat=new THREE.ShaderMaterial({
  transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide,
  uniforms:moonShaftUni,
  vertexShader:fogMatProto.vertexShader,
  fragmentShader:`
    uniform float uTime,uIntensity; uniform vec3 uColor; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
    float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
    void main(){
      float n=noise(vec2(vUv.x*7.0+uTime*0.03,vUv.y*1.2));
      float edge=smoothstep(0.0,0.3,vUv.x)*smoothstep(1.0,0.7,vUv.x)*smoothstep(0.0,0.25,vUv.y)*smoothstep(1.0,0.6,vUv.y);
      gl_FragColor=vec4(uColor,edge*(0.4+0.6*n)*uIntensity);
    }`
});
for(const cfg of [[-4,-14,0.5],[5,-34,0.35]]){
  const m=new THREE.Mesh(new THREE.PlaneGeometry(7,42),moonShaftMat);
  m.position.set(cfg[0],12,cfg[1]);
  m.rotation.set(0.62,0.2,cfg[2]); m.renderOrder=6; m.layers.set(1);
  scene.add(m);
}

/* ================= fireflies ================= */
const FF=46;
const ffGeo=new THREE.BufferGeometry();
const ffBase=[], ffPos=new Float32Array(FF*3), ffSize=new Float32Array(FF), ffPhase=new Float32Array(FF), ffCol=new Float32Array(FF*3);
for(let i=0;i<FF;i++){
  const side=Math.random()<0.5?-1:1;
  ffBase.push({x:side*(7.6+Math.random()*3.5),y:1.6+Math.random()*2.6,z:28-Math.random()*95,
    p1:Math.random()*6.28,p2:Math.random()*6.28,p3:Math.random()*6.28});
  ffSize[i]=0.3+Math.random()*0.3; ffPhase[i]=Math.random()*6.28;
  ffCol[i*3]=0.72; ffCol[i*3+1]=1.0; ffCol[i*3+2]=0.42;
}
ffGeo.setAttribute('position',new THREE.BufferAttribute(ffPos,3).setUsage(THREE.DynamicDrawUsage));
ffGeo.setAttribute('aSize',new THREE.BufferAttribute(ffSize,1));
ffGeo.setAttribute('aPhase',new THREE.BufferAttribute(ffPhase,1));
ffGeo.setAttribute('aColor',new THREE.BufferAttribute(ffCol,3));
const ffUni={uTime:{value:0},uIntensity:{value:0},uTex:{value:glowTex},uPR:{value:1}};
const ffMat=haloMat.clone(); ffMat.uniforms=ffUni;
const fireflies=new THREE.Points(ffGeo,ffMat); fireflies.frustumCulled=false; fireflies.layers.set(1); scene.add(fireflies);

/* ================= dynamic halo slots（船灯、窗光） ================= */
const haloFreeList=[]; for(let i=haloN-1;i>=NL;i--) haloFreeList.push(i);
function haloAlloc(){ return haloFreeList.length? haloFreeList.pop() : -1; }
function haloRelease(i){ if(i<NL) return; haloPos[i*3+1]=-500; haloCol[i*3]=haloCol[i*3+1]=haloCol[i*3+2]=0; haloFreeList.push(i); }
function haloSet(i,x,y,z,size,r,g,b){
  if(i<0) return;
  haloPos[i*3]=x; haloPos[i*3+1]=y; haloPos[i*3+2]=z; haloSize[i]=size;
  haloCol[i*3]=r; haloCol[i*3+1]=g; haloCol[i*3+2]=b;
}
haloGeo.attributes.aSize.setUsage(THREE.DynamicDrawUsage);
haloGeo.attributes.aColor.setUsage(THREE.DynamicDrawUsage);

/* 窗户点亮时的一团暖光，慢慢收进窗里 */
const pulses=[];
function pulseAt(pos, ry){
  const slot=haloAlloc(); if(slot<0) return;
  const nx=Math.sin(ry)*0.35, nz=Math.cos(ry)*0.35; // 朝河面方向略微外移
  pulses.push({slot, x:pos.x+nx, y:pos.y, z:pos.z+nz, t:0});
}
function updatePulses(dt){
  for(let i=pulses.length-1;i>=0;i--){
    const p=pulses[i]; p.t+=dt;
    const life=3.2, k=p.t<0.35? p.t/0.35 : Math.max(0,1-(p.t-0.35)/(life-0.35));
    haloSet(p.slot,p.x,p.y,p.z,3.4+1.2*(1-k),2.6*k,1.7*k,0.8*k);
    if(p.t>=life){ haloRelease(p.slot); pulses.splice(i,1); }
  }
}

/* ================= post-processing ================= */
composer=new THREE.EffectComposer(renderer);
composer.addPass(new THREE.RenderPass(scene,camera));
bloomPass=new THREE.UnrealBloomPass(new THREE.Vector2(W,H),S.bloom,0.55,0.72);
composer.addPass(bloomPass);
fxaaPass=new THREE.ShaderPass(THREE.FXAAShader);
composer.addPass(fxaaPass);
function setFXAA(){
  const pr=renderer.getPixelRatio();
  fxaaPass.material.uniforms.resolution.value.set(1/(W*pr),1/(H*pr));
}
setFXAA();

/* ================= 造境 panel wiring ================= */
const $=id=>document.getElementById(id);
const timeNames=[[0.22,'黄昏','落日衔桥'],[0.5,'入夜','灯火初上'],[0.78,'夜深','月满西楼'],[1.01,'夜阑','万籁俱寂']];
function timeLabel(t){ for(const [lim,n,s] of timeNames) if(t<lim) return [n,s]; return ['夜阑','万籁俱寂']; }
function syncUI(){
  $('cLamp').value=S.lamp; $('cWind').value=S.wind; $('cBloom').value=S.bloom;
  $('cFog').value=S.fog; $('cWave').value=S.wave; $('cBoat').value=S.boat; $('cQuality').value=S.quality;
  $('vLamp').textContent=S.lamp.toFixed(2)+'×';
  $('vWind').textContent=S.wind.toFixed(2);
  $('vBloom').textContent=S.bloom.toFixed(2);
  $('vFog').textContent=S.fog.toFixed(2)+'×';
  $('vWave').textContent=S.wave.toFixed(2)+'×';
  $('vBoat').textContent=S.boat.toFixed(2)+'×';
}
$('cLamp').addEventListener('input',e=>{ S.lamp=+e.target.value; $('vLamp').textContent=S.lamp.toFixed(2)+'×'; });
$('cWind').addEventListener('input',e=>{ S.wind=+e.target.value; $('vWind').textContent=S.wind.toFixed(2); });
$('cBloom').addEventListener('input',e=>{ S.bloom=+e.target.value; bloomPass.strength=S.bloom; $('vBloom').textContent=S.bloom.toFixed(2); });
$('cFog').addEventListener('input',e=>{ S.fog=+e.target.value; $('vFog').textContent=S.fog.toFixed(2)+'×'; });
$('cWave').addEventListener('input',e=>{ S.wave=+e.target.value; $('vWave').textContent=S.wave.toFixed(2)+'×'; });
$('cBoat').addEventListener('input',e=>{ S.boat=+e.target.value; $('vBoat').textContent=S.boat.toFixed(2)+'×'; });
$('cQuality').addEventListener('change',e=>{ S.quality=e.target.value; applyQuality(); });
function applyQuality(){
  const q=S.quality;
  const ULTRA=isUltra();
  dprCap=ULTRA?devicePixelRatio:(q==='high'?2:q==='mid'?1.5:1);
  renderer.setPixelRatio(Math.min(devicePixelRatio,dprCap));
  const rt=ULTRA?2048:(q==='high'?1024:q==='mid'?768:512);
  water.getRenderTarget().setSize(rt,rt);
  const pr=ULTRA?renderer.getPixelRatio()/PR_BASE:1;
  haloUni.uPR.value=pr; ffUni.uPR.value=pr;
  const qn=document.getElementById('qNote'); if(qn) qn.hidden=!ULTRA;
  if(!ULTRA_URL){ try{ localStorage.setItem(Q_KEY,q); }catch(e){} }
  onResize();
}
$('bReset').addEventListener('click',()=>{
  Object.assign(S,JSON.parse(JSON.stringify(DEFAULTS)));
  bloomPass.strength=S.bloom; applyQuality(); syncUI();
  setView('far'); setOrbit(false);
});
$('bGust').addEventListener('click',()=>{ S.gust=1.6; });
$('bShot').addEventListener('click',()=>{
  composer.render();
  const a=document.createElement('a');
  a.download='江南入夜.png';
  if(JN.Data&&JN.Data.mode==='demo'&&JN.Recap&&JN.Recap.drawDemoStamp){
    const src=renderer.domElement, cv=document.createElement('canvas');
    cv.width=src.width; cv.height=src.height;
    const g=cv.getContext('2d'); g.drawImage(src,0,0);
    JN.Recap.drawDemoStamp(g,cv.width,cv.height);
    a.href=cv.toDataURL('image/png');
  }else{
    a.href=renderer.domElement.toDataURL('image/png');
  }
  a.click();
});
$('fsBtn').addEventListener('click',()=>{
  if(document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen();
});

/* ================= camera presets ================= */
const VIEWS={
  far:   {p:[2,8.5,30],   t:[0,3.2,-35]},
  bridge:{p:[6.8,3.6,-9], t:[0,4.2,-23]},
  pier:  {p:[1.6,4.4,25], t:[-4.6,1.4,6]},
  eaves: {p:[-6.2,4.6,2], t:[-9.6,4.2,-6]}
};
const VIEW_NAMES={far:'望全河',bridge:'拱桥畔',pier:'河埠头',eaves:'檐灯下',boat:'夜航随船'};
let tween=null, curView='far';
function markView(name){
  curView=name;
  document.querySelectorAll('.vbtn[data-view]').forEach(b=>b.classList.toggle('on',b.dataset.view===name));
  const cv=$('viewCur'); if(cv) cv.textContent=VIEW_NAMES[name]||'近看';
}
function setViewPT(p,t,name){
  S.follow=-1;
  tween={t:0,fp:camera.position.clone(),ft:controls.target.clone(),
    tp:new THREE.Vector3(...p),tt:new THREE.Vector3(...t)};
  markView(name||'');
}
function setView(name){
  if(typeof name==='number') name=['far','bridge','pier','eaves','boat'][name]||'far';
  if(name==='boat'){ tween=null; S.follow=0; markView('boat'); return; }
  const v=VIEWS[name];
  if(!v){
    const r=(window.JN.Board&&JN.Board.viewFor(name))||(window.JN.Rewards&&JN.Rewards.viewFor(name));
    if(r){ setViewPT(r.p,r.t,''); return; }
    throw new Error('unknown view '+name);
  }
  setViewPT(v.p,v.t,name);
}
document.querySelectorAll('.vbtn[data-view]').forEach(btn=>{
  btn.addEventListener('click',()=>setView(btn.dataset.view));
});
function setOrbit(on){ S.orbit=on; controls.autoRotate=on; $('bOrbit').classList.toggle('on',on); }
$('bOrbit').addEventListener('click',()=>setOrbit(!S.orbit));
controls.addEventListener('start',()=>{
  tween=null;
  if(S.follow>=0){ S.follow=-1; markView(''); }
});

/* ================= resize ================= */
function onResize(){
  W=Math.max(2,innerWidth); H=Math.max(2,innerHeight);
  camera.aspect=W/H; camera.updateProjectionMatrix();
  renderer.setSize(W,H); composer.setSize(W,H); setFXAA();
}
addEventListener('resize',onResize);

/* ================= per-frame updates ================= */
const _lm=new THREE.Matrix4(), _pm=new THREE.Matrix4(), _lv=new THREE.Vector3(), _ls=new THREE.Vector3(1,1,1);
const fogColor=new THREE.Color(), tmpColor=new THREE.Color();
let lastShadowT=-1;
const lampK=()=>S.lamp*(1+0.12*G.lampLevel)*(1+0.6*G.night);

function updateTime(dt){
  if(G.timeSnap){ S.time=G.timeTarget; G.timeSnap=false; return; }
  const d=G.timeTarget-S.time, step=0.04*dt;
  S.time+=Math.max(-step,Math.min(step,d));
}
function updateEnvironment(){
  const t=S.time, n=nightK(t);
  const sd=sunDir(t);
  skyUni.uNight.value=n; skyUni.uTime.value=elapsed;
  skyUni.uSunDir.value.copy(sd);
  fogColor.copy(C.duskFog).lerp(C.nightFog,n);
  skyUni.uFogColor.value.copy(fogColor);
  scene.fog.color.copy(fogColor);
  scene.fog.density=0.0058*S.fog*(1+n*0.35);
  hemi.color.copy(C.duskHemi).lerp(C.nightHemi,n);
  hemi.groundColor.copy(C.duskGround).lerp(C.nightGround,n);
  hemi.intensity=0.55-n*0.25;
  sunLight.position.copy(sd).multiplyScalar(140).add(new THREE.Vector3(0,0,-40));
  sunLight.target.position.set(0,0,-40);
  sunLight.intensity=1.35*(1-THREE.MathUtils.smoothstep(t,0.22,0.5));
  sunLight.color.copy(C.sun).lerp(tmpColor.set(0xff7a40),THREE.MathUtils.smoothstep(t,0.05,0.3));
  moonLight.position.copy(MOON_DIR).multiplyScalar(140).add(new THREE.Vector3(0,0,-40));
  moonLight.target.position.set(0,0,-40);
  moonLight.intensity=0.62*THREE.MathUtils.smoothstep(t,0.4,0.75);
  if(Math.abs(t-lastShadowT)>0.025){ renderer.shadowMap.needsUpdate=true; lastShadowT=t; }
  /* water */
  const wu=water.material.uniforms;
  wu.uTime.value=elapsed; wu.uNight.value=n; wu.uWaveAmp.value=S.wave*(1+S.gust*0.5);
  wu.uSunDir.value.copy(sd); wu.uFogColor.value.copy(fogColor); wu.uFogDensity.value=scene.fog.density;
  /* fog layers */
  for(const f of fogLayers){
    f.m.material.uniforms.uTime.value=elapsed*(1+S.gust*1.5);
    f.m.material.uniforms.uColor.value.copy(fogColor).multiplyScalar(1.12);
    f.m.material.uniforms.uOpacity.value=f.base*S.fog*(0.55+n*0.7);
    f.m.rotation.y=Math.atan2(camera.position.x-f.m.position.x,camera.position.z-f.m.position.z);
  }
  /* shafts */
  const lk=lampK();
  shaftUni.uTime.value=elapsed;
  shaftUni.uIntensity.value=0.16*n*lk;
  moonShaftUni.uTime.value=elapsed;
  moonShaftUni.uIntensity.value=0.05*n;
  /* windows & lantern emissive */
  winLitMat.emissiveIntensity=0.55+n*0.8; // 白天也看得出哪扇窗亮了
  lampMat.emissiveIntensity=(0.95+n*1.2)*lk; // 白天点亮的灯笼也要醒目
  boatLampLevel=(1.0+n*1.1)*lk;
  haloUni.uTime.value=elapsed;
  haloUni.uIntensity.value=(0.3+n*0.45)*lk;
  ffUni.uTime.value=elapsed;
  ffUni.uIntensity.value=n*0.9;
  /* ribbon */
  const [nm,sub]=timeLabel(t);
  if($('rbTime').textContent!==nm){ $('rbTime').textContent=nm; $('rbSub').textContent=sub; $('vTime').textContent=nm; }
  $('rbDot').style.background=n>0.6?'#cfe0ff':'#d9a441';
  $('rbDot').style.boxShadow=n>0.6?'0 0 10px #cfe0ff':'0 0 10px #d9a441';
  return n;
}
let boatLampLevel=1;

const _lq=new THREE.Quaternion(), _le=new THREE.Euler();
let lampSnap=true;
function updateLanterns(dt,n){
  /* 点灯目标 */
  const litN=Math.round(NL*Math.max(0,Math.min(1,Math.max(G.lampFrac,G.night))));
  for(let k=0;k<NL;k++) lampTarget[lampOrder[k]]=k<litN?1:0;
  const windBase=S.wind*(1+S.gust*2.2);
  const lk=lampK();
  for(let i=0;i<NL;i++){
    if(lampSnap) lampGlow[i]=lampTarget[i];
    else if(lampGlow[i]!==lampTarget[i]){
      const d=lampTarget[i]-lampGlow[i];
      lampGlow[i]+=Math.sign(d)*Math.min(Math.abs(d),dt*0.7);
    }
    const L=lanterns[i];
    const hid=!!L.slot&&(L.glb?!slotHidden[L.slot]:!!slotHidden[L.slot]);
    const gl=hid?0:lampGlow[i];
    const a=windBase*0.16*(Math.sin(elapsed*1.25+L.phase)+0.45*Math.sin(elapsed*2.9+L.phase*1.7));
    const b=windBase*0.1*(Math.sin(elapsed*0.9+L.phase*2.3)+0.4*Math.sin(elapsed*2.2+L.phase));
    const px=L.ax+Math.sin(a)*L.len, py=L.ay-Math.cos(a)*Math.cos(b)*L.len, pz=L.az+Math.sin(b)*L.len;
    lampPos[i].set(px,py,pz);
    _le.set(b,0,a); _lq.setFromEuler(_le);
    const sz=hid?0:L.size;
    _lm.compose(_lv.set(px,py,pz),_lq,_ls.set(sz,sz,sz));
    lampBody.setMatrixAt(i,_lm);
    lampBody.setColorAt(i,_ic.setScalar(0.3+0.7*gl));
    _pm.makeTranslation(0,0.24,0); _pm.premultiply(_lm); lampCapT.setMatrixAt(i,_pm);
    _pm.makeTranslation(0,-0.24,0); _pm.premultiply(_lm); lampCapB.setMatrixAt(i,_pm);
    _pm.makeTranslation(0,-0.4,0); _pm.premultiply(_lm); lampTassel.setMatrixAt(i,_pm);
    const sl=L.len;
    _pm.compose(_lv.set(L.ax,L.ay-sl/2,L.az),_lq.identity(),_ls.set(hid?0:1,hid?0:sl,hid?0:1));
    lampString.setMatrixAt(i,_pm);
    haloPos[i*3]=px; haloPos[i*3+1]=py; haloPos[i*3+2]=pz;
    haloCol[i*3]=gl; haloCol[i*3+1]=0.32*gl; haloCol[i*3+2]=0.1*gl;
  }
  lampSnap=false;
  lampBody.instanceMatrix.needsUpdate=true;
  if(lampBody.instanceColor) lampBody.instanceColor.needsUpdate=true;
  lampCapT.instanceMatrix.needsUpdate=true;
  lampCapB.instanceMatrix.needsUpdate=true;
  lampTassel.instanceMatrix.needsUpdate=true;
  lampString.instanceMatrix.needsUpdate=true;
  const lampOff=i=>{ const L=lanterns[i]; return !!L.slot&&(L.glb?!slotHidden[L.slot]:!!slotHidden[L.slot]); };
  for(const {pl,idx} of lampLights){
    pl.position.copy(lampPos[idx]);
    pl.intensity=(0.25+n*1.8)*lk*(0.9+0.1*Math.sin(elapsed*7+idx))*lampGlow[idx]*(lampOff(idx)?0:1);
  }
  for(let k=0;k<shafts.length;k++) shafts[k].visible=lampGlow[lightIdx[k]]>0.5&&!lampOff(lightIdx[k]);
}

function updateFireflies(){
  for(let i=0;i<FF;i++){
    const b=ffBase[i];
    ffPos[i*3]=b.x+Math.sin(elapsed*0.5+b.p1)*1.4+Math.sin(elapsed*1.3+b.p2)*0.4;
    ffPos[i*3+1]=b.y+Math.sin(elapsed*0.7+b.p2)*0.7;
    ffPos[i*3+2]=b.z+Math.sin(elapsed*0.4+b.p3)*1.8;
  }
  ffGeo.attributes.position.needsUpdate=true;
}

const _fw=new THREE.Vector3(), _want=new THREE.Vector3(), _tg=new THREE.Vector3();
function updateCamera(dt){
  if(tween){
    tween.t=Math.min(1,tween.t+dt/1.4);
    const k=tween.t*tween.t*(3-2*tween.t);
    camera.position.lerpVectors(tween.fp,tween.tp,k);
    controls.target.lerpVectors(tween.ft,tween.tt,k);
    if(tween.t>=1)tween=null;
  }else if(S.follow>=0){
    const f=window.JN.Fleet&&JN.Fleet.followTarget();
    if(f){
      _fw.set(Math.cos(f.heading),0,-Math.sin(f.heading)); // 船尾方向
      _want.copy(f.pos).addScaledVector(_fw,6.2);
      /* 过拱桥时镜头压低，从桥洞里穿过去；平时比旧版更近更高，避免被近处船篷挡住 */
      const nearBridge=THREE.MathUtils.smoothstep(Math.abs(_want.z-BRIDGE_Z),9,3.5);
      _want.add(_tg.set(3.0*(1-nearBridge),5.0-2.6*nearBridge,0));
      camera.position.lerp(_want,Math.min(1,dt*2.2));
      controls.target.lerp(_tg.copy(f.pos).add(_lv.set(0,1.4,0)),Math.min(1,dt*3));
    }else{
      const v=VIEWS.pier; camera.position.lerp(_want.set(...v.p),Math.min(1,dt*2)); controls.target.lerp(_tg.set(...v.t),Math.min(1,dt*2));
    }
  }
  controls.target.x=THREE.MathUtils.clamp(controls.target.x,-35,35);
  controls.target.y=THREE.MathUtils.clamp(controls.target.y,0.4,30);
  controls.target.z=THREE.MathUtils.clamp(controls.target.z,-145,42);
  controls.update();
}

/* 场景每帧：先更新环境（返回夜色 n），船和奖励由别的模块更新，最后 postUpdate + render */
let loaderDone=false;
function preUpdate(dt){
  elapsed+=dt;
  updateTime(dt);
  S.gust=Math.max(0,S.gust-dt*0.35);
  const n=updateEnvironment();
  updateLanterns(dt,n);
  updateFireflies();
  updatePulses(dt);
  for(const w of willows){
    w.grp.rotation.z=0.02*Math.sin(elapsed*0.8+w.phase)*(1+S.gust*3)*(0.4+S.wind*0.6);
    w.grp.rotation.x=0.012*Math.sin(elapsed*0.6+w.phase*1.7)*(1+S.gust*2);
  }
  return n;
}
function postUpdate(dt){
  updateCamera(dt);
  haloGeo.attributes.position.needsUpdate=true;
  haloGeo.attributes.aColor.needsUpdate=true;
  haloGeo.attributes.aSize.needsUpdate=true;
}
function render(){
  composer.render();
  if(!loaderDone && elapsed>0.3){
    const k=Math.min(1,(elapsed-0.3)/0.9), el=$('loader');
    el.style.opacity=String(1-k);
    if(k>=1){ loaderDone=true; el.classList.add('done'); el.style.display='none'; }
  }
}

syncUI();
applyQuality();
renderer.shadowMap.needsUpdate=true;

return {
  S, G, DEFAULTS, scene, camera, controls, renderer, get composer(){return composer;}, M,
  tex:{canopyTex, glowTex, stoneTex, tileTex, lanternTex, windowTex},
  geo:{unitBox, unitPrism, unitCyl, unitCone},
  K:{RIVER_HALF, BANK_TOP, HOUSE_FRONT, BRIDGE_Z},
  nightK, sunDir, timeLabel,
  get elapsed(){ return elapsed; },
  get boatLampLevel(){ return boatLampLevel; },
  get lampK(){ return lampK(); },
  get viewName(){ return curView; },
  isMoving(){ return !!tween || S.follow>=0 || S.orbit; },
  spawnRipple, lightWindow, resetWindows, winState, windowCount:NW, lanternCount:NL,
  haloAlloc, haloRelease, haloSet,
  setView, setViewPT, setOrbit, VIEWS,
  applyQuality, onResize, syncUI,
  preUpdate, postUpdate, render,
  shadowsDirty(){ renderer.shadowMap.needsUpdate=true; },
  snapLamps(){ lampSnap=true; },
  get ULTRA(){ return isUltra(); },
  lanternAnchors(){ return lanterns.map(L=>({x:L.ax,y:L.ay,z:L.az,slot:L.slot})); },
  isSlotHiddenRaw:id=>!!slotHidden[id],
  get water(){ return water; },
  saveView(){ return {p:camera.position.clone(),t:controls.target.clone(),tween,follow:S.follow}; },
  restoreView(v){ camera.position.copy(v.p); controls.target.copy(v.t); tween=v.tween; S.follow=v.follow; camera.lookAt(controls.target); },
  slots, setSlotHidden, isSlotHidden:id=>!!slotHidden[id],
  GLB_HOUSES, HOUSE_V, glbHouseXform,
  /* GLB 房子加载后，按射线打到的真实墙面重新放窗（略微浮在墙面前面） */
  glbWindows(id){ const out=[]; windows.forEach((w,i)=>{ if(w.slot===id&&w.glb) out.push({i,anchor:w.glbAnchor,pos:w.pos.clone(),ry:w.ry}); }); return out; },
  setWindowPos(i,pos){ const w=windows[i]; const sc=new THREE.Vector3(); w.m.decompose(new THREE.Vector3(),new THREE.Quaternion(),sc); _e.set(0,w.ry,0); _q.setFromEuler(_e); w.m.compose(pos,_q,sc); w.pos.copy(pos); applyWindow(i); winLitIM.instanceMatrix.needsUpdate=true; winDarkIM.instanceMatrix.needsUpdate=true; },
};
})();

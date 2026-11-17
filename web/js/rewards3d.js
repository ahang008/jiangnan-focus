/* 江南入夜 · 奖励在水乡里的样子
   建筑和生灵：GLTFLoader 读 rewards.json 里登记的 glb，按包围盒统一缩放、坐在地上、朝向河面；
              没登记或读不到时用代码搭的替身，不报错
   天气：细雨、萤火、飘雪，都用着色器粒子，轻柔不满屏
   声音：交给 audio.js 合成 */
window.JN = window.JN || {};
JN.Rewards = (function(){
'use strict';
const SC=JN.Scene; if(!SC) return null;
const THREE=window.THREE, M=SC.M, BANK=SC.K.BANK_TOP;
const NO_MODELS=new URLSearchParams(location.search).get('nomodels')==='1';

/* ---------- 摆放规划（俯视：河道 |x|<7，石岸 7~9.6，民居正面 |x|=9.2，拱桥 z=-22） ----------
   front：模型正面朝向的本地轴；face：世界里要朝的方向 [dx,dz]；height：统一缩放到的高度（米） */
/* 茶楼、凉亭、牌坊「换房」：占一栋临河民居的地块（scene.js 的 SLOT_DEFS），得到时民居整栋隐藏，
   收起时民居原样回来。地块位置从场景里读，不写死 */
const GROUND=BANK+0.18;          // 石岸步道顶面
const FRONT=SC.K.HOUSE_FRONT;    // 民居正面 |x|=9.2，步道外沿 |x|=9.6
const SL=SC.slots||{};
const sx=(id,d)=>(SL[id]?SL[id].side:1)*d, sz=id=>SL[id]?SL[id].c:0;
const PLACE={
  teahouse:{slot:'teahouse',front:'x',height:9.6,items:[{pos:[sx('teahouse',13.85),GROUND,sz('teahouse')],face:[-(SL.teahouse?SL.teahouse.side:-1),0]}],
    lamps:[[sx('teahouse',9.1),GROUND+4.75,sz('teahouse')-2.6],[sx('teahouse',9.1),GROUND+4.75,sz('teahouse')+2.6],[sx('teahouse',9.05),GROUND+2.75,sz('teahouse')]],
    view:{p:[-1.0,5.0,15.5],t:[-12.5,4.6,3.8]}},
  pagoda:{front:'x',height:17,items:[{pos:[14.8,BANK+0.3,-35.6],face:[-1,0]}],
    base:{x:14.8,z:-35.6,w:6.6,d:6.6,top:BANK+0.3}, view:{p:[1.5,6.5,-8],t:[14,9.5,-35]}},
  /* 凉亭做成水榭：前沿压在石岸边（|x|=7.15），比民居正面往河里多出 2 米，望全河斜着也看得见；不伸进河道 */
  pavilion:{slot:'pavilion',front:'x',height:5.6,items:[{pos:[sx('pavilion',9.5),GROUND,sz('pavilion')+0.2],face:[-(SL.pavilion?SL.pavilion.side:1),0]}],
    lamps:[[sx('pavilion',9.5),GROUND+4.15,sz('pavilion')+0.2]], garden:true,
    view:{p:[2.4,4.6,8.5],t:[12.2,3.0,-1.6]}},
  /* 牌坊横跨临河步道（x 7.1~13.7），正面朝镜头（+z），沿河走的人从下面穿过，后面是进巷口的院墙 */
  archway:{slot:'archway',front:'x',height:5.8,items:[{pos:[sx('archway',10.4),GROUND,sz('archway')],face:[0,1]}],
    lamps:[[sx('archway',8.2),GROUND+3.5,sz('archway')+1.25],[sx('archway',12.6),GROUND+3.5,sz('archway')+1.25]], lane:true,
    view:{p:[-1.5,4.6,4.5],t:[-10.6,3.4,-9]}},
  lion:{front:'x',height:1.25,items:[
      {pos:[-12.35,3.38,-23.5],face:[-1,0.25]},{pos:[-12.35,3.38,-20.5],face:[-1,-0.25]},
      {pos:[12.35,3.38,-23.5],face:[1,0.25]},{pos:[12.35,3.38,-20.5],face:[1,-0.25]}],
    view:{p:[-6.5,5.6,-15.5],t:[-12.3,3.9,-22]}},
  cat:{front:'x',height:0.62,items:[{pos:[8.7,BANK+0.18,11.4],face:[-1,0.7]}], view:{p:[5.0,2.7,15.6],t:[8.6,1.7,11.2]}},
  egret:{front:'z',height:1.15,items:[{pos:[7.6,BANK+0.18,4.6],face:[-1,0.45]}], view:{p:[4.0,2.6,9.4],t:[7.6,2.0,4.6]}},
  koi:{front:'x',height:0.6,items:[], view:{p:[2.2,4.6,10.5],t:[5.2,0.2,1.5]}},
  rain:{view:null}, fireflies:{view:null}, snow:{view:null}
};
const KOI_C={x:5.25,z:1.6};

let defs=[], byId={};
const models={};      // id -> {scene|null, failed}
const live={};        // id -> {group, parts...}
let ownedSet=new Set(), hiddenSet=new Set();
const loader=THREE.GLTFLoader?new THREE.GLTFLoader():null;
const waiters=[];

/* ---------- 工具 ---------- */
function faceAngle(front,dx,dz){ return front==='z'?Math.atan2(dx,dz):Math.atan2(-dz,dx); }
function stoneBox(w,h,d,mat){
  const g=new THREE.BoxGeometry(w,h,d);
  const pos=g.attributes.position, uv=g.attributes.uv;
  for(let i=0;i<pos.count;i++){ uv.setXY(i,(pos.getX(i)+pos.getZ(i))*0.22,pos.getY(i)*0.22); }
  const m=new THREE.Mesh(g,mat||M.stoneDark); m.castShadow=true; m.receiveShadow=true; return m;
}
function prepModel(root,lift){
  root.traverse(o=>{
    if(!o.isMesh) return;
    o.castShadow=true; o.receiveShadow=true;
    const mats=Array.isArray(o.material)?o.material:[o.material];
    for(const m of mats){
      if(m.map){ m.map.encoding=THREE.LinearEncoding; m.map.anisotropy=4; m.map.needsUpdate=true; }
      if(m.emissiveMap){ m.emissiveMap.encoding=THREE.LinearEncoding; }
      m.metalness=0; m.metalnessMap=null; m.roughness=Math.max(0.75,m.roughness||1);
      if(m.color) m.color.multiplyScalar(0.92);
      if(m.map&&lift){ m.emissive=new THREE.Color(lift,lift*0.92,lift*0.85); m.emissiveMap=m.map; }
      m.needsUpdate=true;
    }
  });
}
/* 按包围盒缩放到指定高度、底面中心落在原点 */
function normalized(src,height){
  const inner=src.clone(true);
  const box=new THREE.Box3().setFromObject(inner), size=new THREE.Vector3(), c=new THREE.Vector3();
  box.getSize(size); box.getCenter(c);
  const k=height/Math.max(1e-6,size.y);
  inner.scale.setScalar(k);
  inner.position.set(-c.x*k,-box.min.y*k,-c.z*k);
  const g=new THREE.Group(); g.add(inner); return g;
}

/* ---------- 代码替身（模型缺席时） ---------- */
const FB={
  wood:new THREE.MeshStandardMaterial({color:0x6a2418,roughness:0.8}),
  white:new THREE.MeshStandardMaterial({color:0xf2efe6,roughness:0.7}),
  black:new THREE.MeshStandardMaterial({color:0x15181c,roughness:0.8}),
  beak:new THREE.MeshStandardMaterial({color:0xd9a441,roughness:0.6}),
  orange:new THREE.MeshStandardMaterial({color:0xe07a2e,roughness:0.7}),
  stone:new THREE.MeshStandardMaterial({color:0x8a9098,roughness:0.95})
};
function roof(w,d,h,mat){ const m=new THREE.Mesh(SC.geo.unitPrism,mat||M.roof); m.scale.set(w/2,h,d/2); m.castShadow=true; return m; }
function fallback(id){
  const g=new THREE.Group();
  const add=(m,x,y,z)=>{ m.position.set(x,y,z); m.castShadow=true; g.add(m); return m; };
  if(id==='teahouse'){
    add(new THREE.Mesh(SC.geo.unitBox,M.wall),0,2.4,0).scale.set(6.6,4.8,7.2);
    const r1=roof(8,8.6,1.6); r1.rotation.y=Math.PI/2; add(r1,0,4.8,0);
    add(new THREE.Mesh(SC.geo.unitBox,M.wall2),0,6.3,0).scale.set(5.4,2.6,6);
    const r2=roof(6.8,7.6,1.9); r2.rotation.y=Math.PI/2; add(r2,0,7.6,0);
    add(new THREE.Mesh(SC.geo.unitBox,M.wood),3.5,3.2,0).scale.set(0.9,0.12,6.2);
    for(const z of [-2,0,2]) add(new THREE.Mesh(SC.geo.unitBox,M.woodDark),3.32,1.4,z).scale.set(0.1,2.0,1.2);
    for(const z of [-3,3]) add(new THREE.Mesh(new THREE.SphereGeometry(0.32,12,10),M.paper),3.9,4.2,z);
  }else if(id==='pagoda'){
    for(let i=0;i<7;i++){ const w=4.4-i*0.42, y=i*2.2; add(new THREE.Mesh(SC.geo.unitBox,FB.stone),0,y+0.9,0).scale.set(w*0.62,1.8,w*0.62); add(roof(w,w,0.7,M.roof),0,y+1.8,0); }
    add(new THREE.Mesh(SC.geo.unitCone,FB.stone),0,16.2,0).scale.set(0.3,1.6,0.3);
  }else if(id==='pavilion'){
    for(let i=0;i<6;i++){ const a=i/6*Math.PI*2; add(new THREE.Mesh(SC.geo.unitCyl,FB.wood),Math.cos(a)*1.9,1.9,Math.sin(a)*1.9).scale.set(0.12,3.4,0.12); }
    add(new THREE.Mesh(new THREE.CylinderGeometry(2.6,2.7,0.35,6),FB.stone),0,0.18,0);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.15,3.0,1.6,6),M.roof),0,4.4,0);
    add(new THREE.Mesh(SC.geo.unitCone,M.ridge),0,5.5,0).scale.set(0.15,0.6,0.15);
  }else if(id==='archway'){
    for(const z of [-2.6,-0.9,0.9,2.6]) add(new THREE.Mesh(SC.geo.unitBox,FB.stone),0,2.2,z).scale.set(0.5,4.4,0.5);
    add(new THREE.Mesh(SC.geo.unitBox,FB.stone),0,3.9,0).scale.set(0.5,0.5,6);
    for(const [z,w] of [[0,2.4],[-1.75,1.7],[1.75,1.7]]){ const r=roof(1.2,w,0.6,M.roof); add(r,0,z===0?4.9:4.4,z); }
  }else if(id==='lion'){
    add(new THREE.Mesh(SC.geo.unitBox,FB.stone),0,0.15,0).scale.set(0.8,0.3,0.7);
    add(new THREE.Mesh(new THREE.SphereGeometry(0.32,10,8),FB.stone),-0.05,0.55,0).scale.set(1,1.2,0.9);
    add(new THREE.Mesh(new THREE.SphereGeometry(0.24,10,8),FB.stone),0.12,0.98,0);
  }else if(id==='cat'){
    add(new THREE.Mesh(new THREE.SphereGeometry(0.16,12,10),FB.orange),0,0.17,0).scale.set(0.9,1.1,0.8);
    add(new THREE.Mesh(new THREE.SphereGeometry(0.11,12,10),FB.orange),0.04,0.42,0);
    for(const z of [-0.06,0.06]) add(new THREE.Mesh(SC.geo.unitCone,FB.orange),0.04,0.54,z).scale.set(0.035,0.08,0.035);
  }else if(id==='egret'){
    add(new THREE.Mesh(new THREE.SphereGeometry(0.2,12,10),FB.white),0,0.7,0).scale.set(0.8,0.9,1.5);
    const neck=add(new THREE.Mesh(SC.geo.unitCyl,FB.white),0,0.98,0.2); neck.scale.set(0.04,0.42,0.04); neck.rotation.x=0.35;
    add(new THREE.Mesh(new THREE.SphereGeometry(0.07,10,8),FB.white),0,1.18,0.28);
    const bk=add(new THREE.Mesh(SC.geo.unitCone,FB.beak),0,1.18,0.42); bk.scale.set(0.025,0.2,0.025); bk.rotation.x=Math.PI/2;
    for(const x of [-0.05,0.05]) add(new THREE.Mesh(SC.geo.unitCyl,FB.black),x,0.28,0).scale.set(0.015,0.56,0.015);
  }else if(id==='koi'){
    add(new THREE.Mesh(new THREE.SphereGeometry(0.12,12,8),FB.orange),0,0.1,0).scale.set(2.2,0.8,0.9);
    const t=add(new THREE.Mesh(SC.geo.unitCone,FB.white),-0.3,0.1,0); t.scale.set(0.08,0.16,0.02); t.rotation.z=Math.PI/2;
  }
  return g;
}

/* ---------- 锦鲤：水面下浅处的影子 + 偶尔跃出水面 ---------- */
function koiTexture(){
  const cv=document.createElement('canvas'); cv.width=128; cv.height=48; const g=cv.getContext('2d');
  const body=(c)=>{ g.beginPath(); g.moveTo(8,24); g.bezierCurveTo(30,4,80,6,100,24); g.bezierCurveTo(80,42,30,44,8,24); g.fillStyle=c; g.fill(); };
  body('rgba(238,120,40,0.95)');
  g.fillStyle='rgba(250,244,232,0.95)'; g.beginPath(); g.ellipse(70,20,14,7,0.3,0,Math.PI*2); g.fill(); g.beginPath(); g.ellipse(36,27,10,6,-0.2,0,Math.PI*2); g.fill();
  g.fillStyle='rgba(238,120,40,0.85)'; g.beginPath(); g.moveTo(100,24); g.lineTo(124,10); g.lineTo(118,24); g.lineTo(124,38); g.closePath(); g.fill();
  g.fillStyle='rgba(240,150,70,0.6)'; g.beginPath(); g.ellipse(46,10,9,4,-0.6,0,Math.PI*2); g.fill(); g.beginPath(); g.ellipse(46,38,9,4,0.6,0,Math.PI*2); g.fill();
  return new THREE.CanvasTexture(cv);
}
function buildKoi(model){
  const grp=new THREE.Group();
  const tex=koiTexture();
  const mat=new THREE.MeshBasicMaterial({map:tex,transparent:true,opacity:0.82,depthWrite:false,color:0xc8a090,fog:true});
  const fish=[];
  for(let i=0;i<3;i++){
    const m=new THREE.Mesh(new THREE.PlaneGeometry(0.95,0.36),mat);
    m.rotation.x=-Math.PI/2; const holder=new THREE.Group(); holder.add(m); m.position.y=0.025;
    holder.renderOrder=3; grp.add(holder);
    fish.push({holder,r:0.6+i*0.25,ph:i*2.1,w:(i%2?-1:1)*(0.32+i*0.05)});
  }
  let jumper=null;
  if(model){ jumper=normalized(model,0.55); }
  else { jumper=fallback('koi'); }
  jumper.position.y=-3; grp.add(jumper); // 不跳时藏在不透明水面下（一直可见，资源只上传一次，内存稳定）
  SC.scene.add(grp);
  return {group:grp,fish,jumper,nextJump:SC.elapsed+3,jump:null};
}
function updateKoi(k,dt,t){
  for(const f of k.fish){
    const a=t*f.w+f.ph;
    const x=KOI_C.x+Math.cos(a)*f.r*1.15, z=KOI_C.z+Math.sin(a)*f.r*1.7;
    const tx=-Math.sin(a)*f.w, tz=Math.cos(a)*f.w*1.48;
    f.holder.position.set(x,0,z);
    f.holder.rotation.y=Math.atan2(-tz,tx)+Math.PI+0.18*Math.sin(t*5+f.ph);
  }
  if(!k.jump&&t>k.nextJump){
    const f=k.fish[Math.floor(Math.random()*3)];
    const p=f.holder.position, dir=Math.random()*Math.PI*2;
    k.jump={t:0,x:p.x,z:p.z,dx:Math.cos(dir),dz:Math.sin(dir),dir};
    SC.spawnRipple(p.x,p.z,0.6);
  }
  if(k.jump){
    const j=k.jump; j.t+=dt/1.1;
    const u=Math.min(1,j.t), d=1.3*u;
    k.jumper.position.set(j.x+j.dx*d,-0.25+Math.sin(u*Math.PI)*0.85,j.z+j.dz*d);
    k.jumper.rotation.set(0,Math.atan2(j.dx,j.dz),0);
    k.jumper.rotateX(-1.1+2.2*u);
    if(u>=1){ SC.spawnRipple(j.x+j.dx*1.3,j.z+j.dz*1.3,0.7); k.jump=null; k.nextJump=t+7+Math.random()*9; k.jumper.position.y=-3; }
  }
}

/* ---------- 天气 ---------- */
const VOL=new THREE.Vector3(46,22,46);
function weatherCenter(out){
  const cam=SC.camera, tg=SC.controls.target;
  out.copy(tg).sub(cam.position).setY(0).normalize().multiplyScalar(14).add(cam.position);
  return out;
}
function makeRain(){
  const N=700, pos=new Float32Array(N*2*3), seed=new Float32Array(N*2*3), end=new Float32Array(N*2);
  for(let i=0;i<N;i++){ const a=Math.random(),b=Math.random(),c=Math.random(); for(let k=0;k<2;k++){ seed.set([a,b,c],(i*2+k)*3); end[i*2+k]=k; } }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(pos,3)); g.setAttribute('aSeed',new THREE.BufferAttribute(seed,3)); g.setAttribute('aEnd',new THREE.BufferAttribute(end,1));
  const mat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,
    uniforms:{uTime:{value:0},uCenter:{value:new THREE.Vector3()},uSize:{value:VOL},uOpacity:{value:0.3},uColor:{value:new THREE.Color(0xb8c8d8)}},
    vertexShader:`attribute vec3 aSeed; attribute float aEnd; uniform float uTime; uniform vec3 uCenter,uSize; varying float vA;
      void main(){ vec3 p=aSeed*uSize; p.y=mod(p.y-uTime*(12.0+aSeed.x*4.0),uSize.y);
        vec2 c=uCenter.xz-uSize.xz*0.5; p.xz=c+mod(p.xz-c,uSize.xz);
        p.y+=aEnd*0.6; p.x+=aEnd*0.1; vec4 mv=viewMatrix*vec4(p,1.0);
        vA=(1.0-aEnd*0.8)*smoothstep(0.0,2.0,p.y)*smoothstep(2.5,8.0,-mv.z);
        gl_Position=projectionMatrix*mv; }`,
    fragmentShader:`uniform float uOpacity; uniform vec3 uColor; varying float vA; void main(){ gl_FragColor=vec4(uColor,uOpacity*vA); }`});
  const l=new THREE.LineSegments(g,mat); l.frustumCulled=false; l.layers.set(1); l.renderOrder=7; SC.scene.add(l);
  return {obj:l,mat,nextRipple:0};
}
function makeSnow(){
  const N=650, pos=new Float32Array(N*3), seed=new Float32Array(N*3);
  for(let i=0;i<N;i++) seed.set([Math.random(),Math.random(),Math.random()],i*3);
  const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.BufferAttribute(pos,3)); g.setAttribute('aSeed',new THREE.BufferAttribute(seed,3));
  const mat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,
    uniforms:{uTime:{value:0},uCenter:{value:new THREE.Vector3()},uSize:{value:VOL},uOpacity:{value:0.8},uTex:{value:SC.tex.glowTex}},
    vertexShader:`attribute vec3 aSeed; uniform float uTime; uniform vec3 uCenter,uSize; varying float vA;
      void main(){ vec3 p=aSeed*uSize; float sp=0.55+aSeed.z*0.5; p.y=mod(p.y-uTime*sp,uSize.y);
        p.x+=sin(uTime*0.6+aSeed.y*40.0)*0.6; p.z+=cos(uTime*0.45+aSeed.x*30.0)*0.5;
        vec2 c=uCenter.xz-uSize.xz*0.5; p.xz=c+mod(p.xz-c,uSize.xz);
        vec4 mv=viewMatrix*vec4(p,1.0); gl_PointSize=(0.4+aSeed.x*0.45)*(140.0/max(1.0,-mv.z));
        vA=smoothstep(0.0,1.5,p.y)*smoothstep(uSize.y,uSize.y-3.0,p.y)*smoothstep(3.0,10.0,-mv.z); gl_Position=projectionMatrix*mv; }`,
    fragmentShader:`uniform sampler2D uTex; uniform float uOpacity; varying float vA; void main(){ float a=texture2D(uTex,gl_PointCoord).a; gl_FragColor=vec4(vec3(0.93,0.95,1.0),a*uOpacity*vA); }`});
  const p=new THREE.Points(g,mat); p.frustumCulled=false; p.layers.set(1); p.renderOrder=7; SC.scene.add(p);
  return {obj:p,mat};
}
function makeFireflies(){
  const N=120, pos=new Float32Array(N*3), seed=new Float32Array(N*4);
  for(let i=0;i<N;i++){
    const r=Math.random(); let x,y,z;
    if(r<0.45){ x=(Math.random()<0.5?-1:1)*(7.4+Math.random()*2.4); y=1.7+Math.random()*2.6; z=24-Math.random()*80; }
    else if(r<0.8){ x=(Math.random()*2-1)*6; y=0.5+Math.random()*2.2; z=20-Math.random()*70; }
    else { x=(Math.random()*2-1)*20; y=2+Math.random()*4; z=-14-Math.random()*26; }
    pos.set([x,y,z],i*3); seed.set([Math.random()*6.28,Math.random()*6.28,Math.random()*6.28,0.6+Math.random()*0.8],i*4);
  }
  const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.BufferAttribute(pos,3)); g.setAttribute('aSeed',new THREE.BufferAttribute(seed,4));
  const mat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
    uniforms:{uTime:{value:0},uIntensity:{value:1},uTex:{value:SC.tex.glowTex}},
    vertexShader:`attribute vec4 aSeed; uniform float uTime; varying float vA; varying vec3 vC;
      void main(){ vec3 p=position;
        p.x+=sin(uTime*0.45+aSeed.x)*1.5+sin(uTime*1.2+aSeed.y)*0.35; p.y+=sin(uTime*0.62+aSeed.y)*0.8; p.z+=sin(uTime*0.38+aSeed.z)*1.9;
        vA=pow(0.5+0.5*sin(uTime*(0.9+aSeed.w)+aSeed.x*3.0),2.0);
        vC=mix(vec3(0.72,1.0,0.42),vec3(1.0,0.86,0.45),step(0.75,fract(aSeed.z*7.0)));
        vec4 mv=modelViewMatrix*vec4(p,1.0); gl_PointSize=(0.35*aSeed.w+0.18)*(240.0/max(1.0,-mv.z)); gl_Position=projectionMatrix*mv; }`,
    fragmentShader:`uniform sampler2D uTex; uniform float uIntensity; varying float vA; varying vec3 vC; void main(){ vec4 t=texture2D(uTex,gl_PointCoord); gl_FragColor=vec4(vC,t.a*vA*uIntensity); }`});
  const p=new THREE.Points(g,mat); p.frustumCulled=false; p.layers.set(1); SC.scene.add(p);
  return {obj:p,mat};
}

/* 奖励建筑上挂的灯笼（和沿河灯笼一样随夜色亮） */
const LAMP_GEO=new THREE.SphereGeometry(0.3,14,12); LAMP_GEO.scale(1,0.85,1);
const LAMP_CAP=new THREE.CylinderGeometry(0.12,0.15,0.1,10);
const LAMP_MAT=new THREE.MeshStandardMaterial({map:SC.tex.lanternTex,emissive:0xff3a14,emissiveMap:SC.tex.lanternTex,emissiveIntensity:1,roughness:0.55});
/* 地块：民居拿掉后的地面（和步道同高的石铺地）、园墙或巷墙，不露出底下的水面 */
const WHITE=new THREE.MeshStandardMaterial({color:0xe8e0cc,roughness:0.92});
function wallBox(group,w,h,d,x,y,z){
  const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),WHITE); m.position.set(x,y,z); m.castShadow=true; m.receiveShadow=true; group.add(m);
  const cap=new THREE.Mesh(new THREE.BoxGeometry(w+0.22,0.16,d+0.22),M.ridge); cap.position.set(x,y+h/2+0.08,z); cap.castShadow=true; group.add(cap);
}
function buildLot(group,P){
  const L=SL[P.slot], s=L.side, back=FRONT+L.depth+0.3, len=L.w+0.3;
  const x0=FRONT+0.4, x1=back, cx=s*(x0+x1)/2, dx=x1-x0;
  const g=stoneBox(dx,GROUND+0.2,len,M.stone); g.position.set(cx,(GROUND+0.2)/2-0.2,L.c); group.add(g);
  if(P.garden||P.lane){
    const wh=P.lane?2.6:1.9, bz=P.lane?L.c:L.c;
    wallBox(group,0.35,wh+0.6,len,s*(x1-0.18),GROUND+(wh+0.6)/2,bz);                       // 后墙
    const sx0=P.lane?FRONT+2.6:FRONT+5.4;
    for(const e of [-1,1]) wallBox(group,x1-sx0,wh,0.3,s*(sx0+x1)/2,GROUND+wh/2,L.c+e*(len/2-0.2)); // 两侧墙
    if(P.lane){ const d=new THREE.Mesh(new THREE.BoxGeometry(0.12,2.3,1.5),M.woodDark); d.position.set(s*(x1-0.4),GROUND+1.15,L.c); group.add(d); }
    if(P.garden) for(const e of [-1,1]){ const b=new THREE.Mesh(new THREE.SphereGeometry(0.9,10,8),M.green); b.scale.set(1,0.8,1); b.position.set(s*(x1-1.4),GROUND+0.6,L.c+e*(len/2-1.4)); b.castShadow=true; group.add(b); }
  }
}
/* ---------- 实例化 ---------- */
function build(id){
  const P=PLACE[id]; if(!P) return null;
  if(id==='rain') return makeRain();
  if(id==='snow') return makeSnow();
  if(id==='fireflies') return makeFireflies();
  if(id==='koi'){ const mm=models.koi&&models.koi.scene; return Object.assign(buildKoi(mm),{kind:'koi'}); }
  const src=models[id]&&models[id].scene;
  const group=new THREE.Group();
  if(P.slot&&SL[P.slot]) buildLot(group,P);
  if(P.base){
    const b=P.base; const h=b.top+0.2;
    const pl=stoneBox(b.w,h,b.d); pl.position.set(b.x,h/2-0.2,b.z); group.add(pl);
    const cap=stoneBox(b.w+0.25,0.14,b.d+0.25,M.stone); cap.position.set(b.x,b.top-0.06,b.z); group.add(cap);
  }
  const parts=[], lamps=[];
  for(const L of (P.lamps||[])){
    const m=new THREE.Mesh(LAMP_GEO,LAMP_MAT); m.scale.set(1.25,1,1.25); m.position.set(...L); group.add(m);
    const cap=new THREE.Mesh(LAMP_CAP,M.ridge); cap.position.set(L[0],L[1]+0.3,L[2]); group.add(cap);
    lamps.push({m,x:L[0],y:L[1],z:L[2],halo:SC.haloAlloc(),ph:Math.random()*6});
  }
  for(const it of P.items){
    const g=src?normalized(src,P.height):fallback(id);
    if(!src){ const bb=new THREE.Box3().setFromObject(g), s=new THREE.Vector3(); bb.getSize(s); const k=P.height/Math.max(1e-6,s.y); g.scale.setScalar(k); }
    g.position.set(...it.pos);
    g.rotation.y=faceAngle(P.front,it.face[0],it.face[1]);
    group.add(g); parts.push({g,base:g.rotation.y,ph:Math.random()*6});
  }
  SC.scene.add(group);
  if(P.slot) SC.setSlotHidden(P.slot,true);
  SC.shadowsDirty();
  return {group,parts,lamps,id,usingModel:!!src};
}
function destroy(id){
  const o=live[id]; if(!o) return;
  const root=o.group||o.obj;
  SC.scene.remove(root);
  if(o.lamps) for(const l of o.lamps) SC.haloRelease(l.halo);
  if(PLACE[id]&&PLACE[id].slot) SC.setSlotHidden(PLACE[id].slot,false);
  /* 释放这个实例自己建的几何、材质、贴图；共享的（场景公共件、替身材质、灯笼、缓存的 glb）不动 */
  const geos=new Set(), mats=new Set(), texs=new Set();
  root.traverse(m=>{
    if(m.geometry&&!SHARED.has(m.geometry)) geos.add(m.geometry);
    const ms=m.material?(Array.isArray(m.material)?m.material:[m.material]):[];
    for(const mt of ms){
      if(SHARED.has(mt)) continue;
      mats.add(mt);
      for(const k of TEX_KEYS) if(mt[k]&&!SHARED.has(mt[k])) texs.add(mt[k]);
    }
  });
  geos.forEach(g=>g.dispose()); mats.forEach(m=>m.dispose()); texs.forEach(t=>t.dispose());
  delete live[id];
  SC.shadowsDirty();
}

function apply(owned, hidden){
  ownedSet=new Set(owned||[]); hiddenSet=new Set(hidden||[]);
  for(const d of defs){
    const want=ownedSet.has(d.id)&&!hiddenSet.has(d.id);
    if(d.category==='声音'){ JN.Audio&&JN.Audio.setEnabled(d.id,want,SC.elapsed); continue; }
    if(!PLACE[d.id]) continue;
    const ready=!d.model||NO_MODELS||(models[d.id]&&(models[d.id].scene||models[d.id].failed));
    if(want&&!live[d.id]&&ready){ const o=build(d.id); if(o) live[d.id]=o; }
    else if(!want&&live[d.id]) destroy(d.id);
    else if(want&&live[d.id]&&live[d.id].usingModel===false&&models[d.id]&&models[d.id].scene&&live[d.id].kind!=='koi'){ destroy(d.id); live[d.id]=build(d.id); }
  }
}

/* 共享资源登记表：这些不随奖励实例释放 */
const TEX_KEYS=['map','normalMap','roughnessMap','metalnessMap','emissiveMap','aoMap','bumpMap','alphaMap'];
const SHARED=new Set();
function share(o){ if(o) SHARED.add(o); }
Object.values(SC.geo).forEach(share); Object.values(SC.tex).forEach(share); Object.values(M).forEach(share);
Object.values(FB).forEach(share); [LAMP_GEO,LAMP_CAP,LAMP_MAT,WHITE].forEach(share);
function shareModel(root){
  root.traverse(o=>{
    if(o.geometry) share(o.geometry);
    const ms=o.material?(Array.isArray(o.material)?o.material:[o.material]):[];
    for(const m of ms){ share(m); for(const k of TEX_KEYS) share(m[k]); }
  });
}
function init(list){
  defs=list||[]; byId={}; for(const d of defs) byId[d.id]=d;
  for(const d of defs){
    if(!d.model||!PLACE[d.id]||NO_MODELS||!loader) continue;
    models[d.id]={scene:null,failed:false};
    loader.load(d.model,gl=>{ prepModel(gl.scene,d.category==='生灵'?0.2:0.15); shareModel(gl.scene); models[d.id].scene=gl.scene; apply([...ownedSet],[...hiddenSet]); },
      undefined,()=>{ models[d.id].failed=true; apply([...ownedSet],[...hiddenSet]); });
  }
}

const _c=new THREE.Vector3();
function update(dt,n,t){
  LAMP_MAT.emissiveIntensity=(0.95+n*1.2)*SC.lampK;
  for(const id in live){
    const o=live[id];
    if(o.lamps) for(const l of o.lamps){
      const a=0.06*Math.sin(t*1.2+l.ph)*SC.S.wind;
      l.m.position.set(l.x+a,l.y,l.z+0.5*a);
      const k=1;
      SC.haloSet(l.halo,l.x+a,l.y,l.z+0.5*a,2.6,k,0.32*k,0.1*k);
    }
    if(id==='rain'){ o.mat.uniforms.uTime.value=t; weatherCenter(o.mat.uniforms.uCenter.value); o.mat.uniforms.uOpacity.value=0.2+0.12*(1-n);
      if(t>o.nextRipple){ o.nextRipple=t+0.3; const c=o.mat.uniforms.uCenter.value; SC.spawnRipple(THREE.MathUtils.clamp(c.x+(Math.random()*2-1)*6,-6.5,6.5),c.z+(Math.random()*2-1)*14,0.14); } }
    else if(id==='snow'){ o.mat.uniforms.uTime.value=t; weatherCenter(o.mat.uniforms.uCenter.value); o.mat.uniforms.uOpacity.value=0.5+0.2*n; }
    else if(id==='fireflies'){ o.mat.uniforms.uTime.value=t; o.mat.uniforms.uIntensity.value=0.35+0.75*n; }
    else if(id==='koi'){ updateKoi(o,dt,t); }
    else if(id==='egret'){ for(const p of o.parts){ const s=Math.sin(t*0.35+p.ph); p.g.rotation.y=p.base+0.35*s*s*Math.sign(s); } }
    else if(id==='cat'){ for(const p of o.parts){ p.g.scale.y=p.g.scale.x*(1+0.018*Math.sin(t*2.1+p.ph)); } }
  }
}
function viewFor(id){ const P=PLACE[id]; return P&&P.view?P.view:null; }
function info(){ const r={}; for(const id in live) r[id]={usingModel:live[id].usingModel!==false}; return r; }

return {init,apply,update,viewFor,info,PLACE,get defs(){return defs;},byId:()=>byId,models};
})();

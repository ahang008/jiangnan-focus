/* 江南入夜 · 船队：一个会话一条乌篷船
   - 河里最多 6 条，绕一条固定航线（左侧下行、远端掉头、右侧上行、近端掉头），同速保持间距，不会相撞
   - 码头在左岸近处，5 个泊位：排队的船亮灯候着，结束的船熄灯靠着
   - 工具调用：摇一下桨、船灯闪一下，同时来的排队依次播放，相同的合并成 x3
   - 改文件：岸边一扇暗窗亮起；子代理：船后跟一条小船，一阵子后离开 */
window.JN = window.JN || {};
JN.Fleet = (function(){
'use strict';
const SC = JN.Scene; if(!SC) return null;
const THREE = window.THREE;
const M = SC.M;

/* ---------- 船的造型（沿用原网页） ---------- */
const hullShape=new THREE.Shape();
hullShape.moveTo(-3.1,0);
hullShape.quadraticCurveTo(-2.3,0.85,0,0.85);
hullShape.quadraticCurveTo(2.3,0.85,3.1,0);
hullShape.quadraticCurveTo(2.3,-0.85,0,-0.85);
hullShape.quadraticCurveTo(-2.3,-0.85,-3.1,0);
const hullGeo=new THREE.ExtrudeGeometry(hullShape,{depth:0.55,bevelEnabled:true,bevelThickness:0.12,bevelSize:0.1,bevelSegments:2,curveSegments:14});
hullGeo.rotateX(-Math.PI/2);
const hullMat=new THREE.MeshStandardMaterial({color:0x2b1d12,roughness:0.75});
const canopyMatB=new THREE.MeshStandardMaterial({map:SC.tex.canopyTex,color:0x4a4038,roughness:0.9});
const figureMat=new THREE.MeshStandardMaterial({color:0x191411,roughness:0.9});
const canopyGeo=new THREE.CylinderGeometry(0.8,0.8,2.4,12,1,true,0,Math.PI); canopyGeo.rotateZ(Math.PI/2);
const bodyGeo=new THREE.CylinderGeometry(0.16,0.24,0.85,8);
const headGeo=new THREE.SphereGeometry(0.14,8,8);
const hatGeo=new THREE.CylinderGeometry(0.02,0.34,0.16,10);
const oarGeo=new THREE.BoxGeometry(0.07,2.6,0.16);
const poleGeo=new THREE.CylinderGeometry(0.03,0.03,1.1,6);
const lampGeo=new THREE.SphereGeometry(0.17,10,8);
const LAMP_ON=new THREE.Color(0xd83a18), LAMP_OFF=new THREE.Color(0x3a2219), LAMP_EM=new THREE.Color(0xff4a1a);

/* ---------- 六个平台各一种船 ----------
   claude 乌篷船（陶橙旗）· codex 小画舫（白旗黑边）· deepseek 细长快船（深蓝船舷、深蓝旗）
   grok 高篷黑漆船（炭黑旗银边）· cursor 小舢板（银灰篷、银白旗）· magpie 敞口划子（船头木雕喜鹊、青绿旗）
   models/manifest.json 里登记了对应 GLB 时用 GLB 做船身（人和桨在模型里），船灯、旗、木牌仍用代码件，节拍时整条船轻轻一顿 */
const PLATFORMS=['claude','codex','deepseek','grok','magpie','cursor'];
const PCOLOR={claude:'#d0602e',codex:'#f2efe6',deepseek:'#2a4f9a',grok:'#2e2e30',magpie:'#2f8f8a',cursor:'#dfe3e8'};
const PNAME={claude:'Claude',codex:'Codex',deepseek:'DeepSeek',grok:'Grok',magpie:'Magpie',cursor:'Cursor'};
function srcOf(id,s){ const v=(s&&s.source)||String(id||'').split(':')[0]; return PLATFORMS.includes(v)?v:'claude'; }
const swallow=(()=>{ const sh=new THREE.Shape(); sh.moveTo(0,0); sh.lineTo(1.0,0.02); sh.lineTo(0.78,-0.2); sh.lineTo(1.0,-0.42); sh.lineTo(0,-0.4); sh.closePath(); return new THREE.ShapeGeometry(sh); })();
const flagPoleGeo=new THREE.CylinderGeometry(0.025,0.03,1.6,6);
const T={}; // 按类型缓存的几何和材质（每种只建一次）
function mat(c,o){ return new THREE.MeshStandardMaterial(Object.assign({color:c,roughness:0.75},o||{})); }
function typeKit(type){
  if(T[type]) return T[type];
  const k={};
  k.flag=new THREE.MeshStandardMaterial({color:PCOLOR[type],roughness:0.8,side:THREE.DoubleSide,emissive:PCOLOR[type],emissiveIntensity:0.12});
  k.flagEdge=type==='codex'?mat(0x1a1a1a):type==='grok'?mat(0xc8ccd2,{metalness:0.6,roughness:0.35}):null;
  if(type==='claude'){ k.hull=hullMat; }
  if(type==='codex'){ k.hull=mat(0x2e1c12); k.wall=mat(0x9a8f78,{roughness:0.95}); k.red=mat(0x7a1f12); k.roof=M.roof; k.win=new THREE.MeshStandardMaterial({color:0x6a4a2a,emissive:0xff9040,emissiveIntensity:0.1,roughness:0.75}); }
  if(type==='deepseek'){ k.hull=mat(0x23170f); k.stripe=mat(0x1f3d7a,{roughness:0.5,emissive:0x0a1a3a,emissiveIntensity:0.3}); k.canopy=mat(0x2a2622,{map:SC.tex.canopyTex}); }
  if(type==='grok'){ k.hull=mat(0x1b1612,{roughness:0.5}); k.canopy=mat(0x161618,{roughness:0.3,metalness:0.15,side:THREE.DoubleSide}); k.silver=mat(0x8e949c,{metalness:0.35,roughness:0.45}); k.curtain=mat(0x8f877a,{roughness:0.95}); }
  if(type==='cursor'){ k.hull=mat(0x6a4e34); k.canopy=mat(0x80868e,{roughness:0.75,side:THREE.DoubleSide}); }
  if(type==='magpie'){ k.hull=mat(0x3a2416); k.seat=M.wood; k.black=mat(0x121418,{roughness:0.5}); k.white=mat(0xf0eee8); k.blue=mat(0x284a7a,{roughness:0.4,metalness:0.3}); }
  return T[type]=k;
}
const UNIT_BOX=new THREE.BoxGeometry(1,1,1);
function addBox(grp,m,w,h,d,x,y,z){ const o=new THREE.Mesh(UNIT_BOX,m); o.scale.set(w,h,d); o.position.set(x,y,z); o.castShadow=true; grp.add(o); return o; }
const sphereG=new THREE.SphereGeometry(1,10,8), coneG=new THREE.ConeGeometry(1,1,8), prismG=SC.geo.unitPrism, cylG=new THREE.CylinderGeometry(1,1,1,8);
const tallCanopyGeo=new THREE.CylinderGeometry(0.85,0.85,2.6,14,1,true,0,Math.PI); tallCanopyGeo.rotateZ(Math.PI/2);
const shortCanopyGeo=new THREE.CylinderGeometry(0.62,0.62,1.7,12,1,true,0,Math.PI); shortCanopyGeo.rotateZ(Math.PI/2);
const silverArcGeo=new THREE.TorusGeometry(0.86,0.035,6,16,Math.PI); silverArcGeo.rotateY(Math.PI/2);

function buildBoat(type){
  type=PLATFORMS.includes(type)?type:'claude';
  const k=typeKit(type);
  const grp=new THREE.Group(); grp.userData.type=type;
  const body=new THREE.Group(); grp.add(body);          // 船身（有 GLB 时整组换掉）
  /* 船体比例：deepseek 细长、cursor 和 magpie 短小 */
  const sx=type==='deepseek'?1.16:type==='cursor'?0.84:type==='magpie'?0.8:1, sz=type==='deepseek'?0.78:type==='magpie'?0.9:1;
  const hull=new THREE.Mesh(hullGeo,k.hull); hull.scale.set(sx,1,sz); hull.position.y=0.12; hull.castShadow=true; body.add(hull);
  const gun=new THREE.Mesh(hullGeo,M.wood); gun.scale.set(0.94*sx,0.3,0.86*sz); gun.position.y=0.62; body.add(gun);
  if(type==='claude'){ const c=new THREE.Mesh(canopyGeo,canopyMatB); c.position.set(-0.2,0.72,0); c.castShadow=true; body.add(c); }
  if(type==='codex'){ // 画舫：船舱 + 小瓦顶 + 红柱 + 暖光窗
    addBox(body,k.wall,2.5,1.15,1.35,-0.25,1.25,0);
    for(const x of [-1.45,0.95]) for(const z of [-0.7,0.7]) addBox(body,k.red,0.1,1.3,0.1,x,1.3,z);
    for(const z of [-0.69,0.69]) for(const x of [-0.9,-0.25,0.4]) addBox(body,k.win,0.42,0.42,0.02,x,1.35,z);
    const r=new THREE.Mesh(prismG,k.roof); r.scale.set(0.95,0.55,1.55); r.rotation.y=Math.PI/2; r.position.set(-0.25,1.83,0); r.castShadow=true; body.add(r);
    addBox(body,k.red,2.9,0.08,1.6,-0.25,1.85,0);
  }
  if(type==='deepseek'){ // 细长快船：低矮短篷 + 两舷深蓝条
    const c=new THREE.Mesh(shortCanopyGeo,k.canopy); c.position.set(-0.1,0.7,0); c.castShadow=true; body.add(c);
    for(const z of [-1,1]) addBox(body,k.stripe,5.6,0.1,0.04,0,0.5,z*0.7);
  }
  if(type==='grok'){ // 高篷黑漆，银边，篷下白帘
    const c=new THREE.Mesh(tallCanopyGeo,k.canopy); c.scale.set(1,1.28,1); c.position.set(-0.2,0.72,0); c.castShadow=true; body.add(c);
    for(const x of [-1.5,-0.2,1.1]){ const a=new THREE.Mesh(silverArcGeo,k.silver); a.scale.set(1,1.28,1); a.position.set(x,0.72,0); body.add(a); }
    for(const x of [-1.48,1.08]) addBox(body,k.curtain,0.02,0.75,1.3,x,1.05,0); // 篷两头垂着的布帘
  }
  if(type==='cursor'){ const c=new THREE.Mesh(shortCanopyGeo,k.canopy); c.scale.set(1.05,1.15,1.2); c.position.set(-0.3,0.72,0); c.castShadow=true; body.add(c); }
  if(type==='magpie'){ // 敞口划子：横座板 + 船头木雕喜鹊
    for(const x of [-1.2,0,1.0]) addBox(body,k.seat,0.28,0.06,1.3,x,0.66,0);
    const bird=new THREE.Group(); bird.position.set(-2.35,0.95,0);
    const b1=new THREE.Mesh(sphereG,k.black); b1.scale.set(0.24,0.16,0.14); bird.add(b1);
    const belly=new THREE.Mesh(sphereG,k.white); belly.scale.set(0.15,0.1,0.13); belly.position.set(0.02,-0.05,0); bird.add(belly);
    const hd=new THREE.Mesh(sphereG,k.black); hd.scale.setScalar(0.09); hd.position.set(-0.22,0.1,0); bird.add(hd);
    const bk=new THREE.Mesh(coneG,k.black); bk.scale.set(0.03,0.09,0.03); bk.rotation.z=Math.PI/2; bk.position.set(-0.34,0.1,0); bird.add(bk);
    const tail=new THREE.Mesh(UNIT_BOX,k.blue); tail.scale.set(0.42,0.03,0.08); tail.position.set(0.36,0.06,0); tail.rotation.z=-0.35; bird.add(tail);
    const wing=new THREE.Mesh(sphereG,k.blue); wing.scale.set(0.16,0.05,0.15); wing.position.set(0.05,0.06,0); bird.add(wing);
    body.add(bird);
  }
  /* 船夫和桨（GLB 船会自带，届时隐藏这两样） */
  const man=new THREE.Group();
  const mb=new THREE.Mesh(bodyGeo,figureMat); mb.position.y=0.45; man.add(mb);
  const head=new THREE.Mesh(headGeo,figureMat); head.position.y=1.0; man.add(head);
  const hat=new THREE.Mesh(hatGeo,figureMat); hat.position.y=1.12; man.add(hat);
  man.position.set(type==='magpie'?0.6:2.0*sx,0.62,0); man.rotation.z=-0.12; grp.add(man);
  const oar=new THREE.Mesh(oarGeo,M.woodDark);
  oar.position.set(type==='magpie'?0.9:2.35*sx,0.5,0.5); oar.rotation.x=0.5; grp.add(oar);
  /* 船头灯杆和灯（位置所有船一致，木牌和光晕都挂在这里） */
  const pole=new THREE.Mesh(poleGeo,M.woodDark); pole.position.set(-2.5,1.15,0); grp.add(pole);
  const lampMat=new THREE.MeshStandardMaterial({color:LAMP_OFF.clone(),emissive:LAMP_EM,emissiveIntensity:0});
  const lamp=new THREE.Mesh(lampGeo,lampMat);
  lamp.scale.y=0.8; lamp.position.set(-2.5,1.72,0); grp.add(lamp);
  lamp.userData.ownMat=true;
  /* 平台旗：船尾一根短杆，燕尾旗 */
  const fp=new THREE.Mesh(flagPoleGeo,M.woodDark); fp.position.set(1.15*sx,1.45,-0.45*sz); grp.add(fp);
  pole.userData.lampPole=true;
  const flag=new THREE.Group(); flag.position.set(1.15*sx,2.2,-0.45*sz);
  const fm=new THREE.Mesh(swallow,k.flag); fm.scale.set(0.95,1,1); flag.add(fm);
  if(k.flagEdge){ const e=new THREE.Mesh(UNIT_BOX,k.flagEdge); e.scale.set(0.95,0.035,0.01); e.position.set(0.47,-0.4,0.002); flag.add(e); const e2=e.clone(); e2.position.y=0.01; flag.add(e2); }
  grp.add(flag);
  grp.userData.owned=[lampMat];
  SC.scene.add(grp);
  const parts={grp,body,oar,man,lamp,lampMat,flag,flagPole:fp,pole,type,lampLocal:new THREE.Vector3(-2.5,1.72,0)};
  applyModel(parts);
  return parts;
}

/* ---------- GLB 清单（models/manifest.json）：登记了才加载，没登记不发请求，控制台零报错 ---------- */
const MODELS={}; let manifest=null;
const loader=THREE.GLTFLoader?new THREE.GLTFLoader():null;
const pendingApply=new Set();
function applyModel(parts){
  const m=MODELS['boat_'+parts.type];
  if(!m||!m.scene){ if(manifest===null) pendingApply.add(parts); return; }
  if(parts.glb) return;
  const g=m.scene.clone(true), e=m.entry||{};
  parts.body.visible=false; parts.man.visible=false; parts.oar.visible=false;
  /* 模型自带船夫、桨、船头灯笼和平台色的燕尾旗（按概念图做的）：默认不再叠代码件，免得出现两面旗、两盏灯；
     清单里写 "pennant":true / "lamp3d":true 可以把代码件加回来。船灯的闪光和木牌挂在模型灯笼的位置 */
  if(!e.pennant){ parts.flag.visible=false; parts.flagPole.visible=false; }
  if(!e.lamp3d){ parts.lamp.visible=false; parts.pole.visible=false; }
  if(Array.isArray(e.lamp)) parts.lampLocal.set(e.lamp[0],e.lamp[1],0);
  if(parts.sign) parts.sign.position.set(parts.lampLocal.x,parts.lampLocal.y+0.21,0);
  parts.lamp.position.copy(parts.lampLocal); parts.pole.position.set(parts.lampLocal.x,parts.lampLocal.y-0.57,0);
  parts.glb=g; parts.grp.add(g);
}
function normalizeBoat(root,entry){
  const box=new THREE.Box3().setFromObject(root), size=new THREE.Vector3(), c=new THREE.Vector3(); box.getSize(size); box.getCenter(c);
  const front=entry.front||'-x';            // 模型船头朝哪根轴；代码里船头是本地 -x
  const len=front.includes('x')?size.x:size.z;
  const k=(entry.length||6.2)/Math.max(1e-6,len);
  const inner=root; inner.position.set(-c.x,-box.min.y,-c.z);
  const g=new THREE.Group(); g.add(inner); g.scale.setScalar(k);
  g.rotation.y={'-x':0,'x':Math.PI,'z':-Math.PI/2,'-z':Math.PI/2}[front]||0;
  g.position.y=entry.sink!=null?-entry.sink:-0.15; // 吃水（米）
  root.traverse(o=>{ if(o.isMesh){ o.castShadow=true; const ms=Array.isArray(o.material)?o.material:[o.material]; for(const mm of ms){ if(mm.map){ mm.map.encoding=THREE.LinearEncoding; mm.map.anisotropy=4; mm.map.needsUpdate=true; } mm.metalness=0; mm.metalnessMap=null; mm.roughness=Math.max(0.7,mm.roughness||1); mm.side=THREE.DoubleSide; } } });
  return g;
}
JN.manifest=JN.manifest||(/[?&]nomodels=1/.test(location.search)?Promise.resolve({}):fetch('models/manifest.json',{cache:'no-cache'}).then(r=>r.ok?r.json():{}).catch(()=>({}))); // ?nomodels=1：全用程序版（对比用）
JN.manifest.then(man=>{
  manifest=man||{};
  const list=(manifest.boats)||{};
  for(const type of PLATFORMS){
    const e=list[type]; if(!e||!e.file||!loader) continue;
    MODELS['boat_'+type]={scene:null,entry:e};
    loader.load(e.file,gl=>{ MODELS['boat_'+type].scene=normalizeBoat(gl.scene,e); for(const p of [...pendingApply]) if(p.type===type){ applyModel(p); } for(const b of boats.values()) if(b.type===type) applyModel(b); },undefined,()=>{});
  }
  pendingApply.clear();
});

/* 渐隐：共享材质第一次需要时换成这条船独占的透明副本（记账，退场时释放）；船灯材质本来独占，直接改 */
function setOpacity(grp, a){
  grp.traverse(o=>{
    if(!o.isMesh) return;
    if(!o.userData.ownMat){ o.material=o.material.clone(); o.userData.ownMat=true; grp.userData.owned.push(o.material); }
    if(!o.material.transparent){ o.material.transparent=true; o.material.needsUpdate=true; }
    o.material.opacity=a; o.material.depthWrite=a>0.98;
  });
}
function disposeGroup(grp){
  for(const m of grp.userData.owned||[]) m.dispose();
  grp.userData.owned=[];
  grp.traverse(o=>{ if(o.isSprite){ o.material.map&&o.material.map.dispose(); o.material.dispose(); } });
  SC.scene.remove(grp);
}

/* ---------- 船头木牌（字始终朝向镜头，远了自动放大一点保证看得清） ---------- */
const SIGN_W=384, SIGN_H=170;
const SS=SC.ULTRA?2:1; // 超清档：木牌和浮字画布用 2 倍分辨率（坐标不变，只是更细）
const FONT_K='"STKaiti","KaiTi","Kaiti SC","Songti SC","Noto Serif SC",serif';
/* 木牌两行：上行项目名，下行「已办 128」（这个会话今天执行过的任务数）。
   每条船一张画布一张贴图，数字变了就在原画布上重画（每条船每秒最多一次），不新建贴图 */
function drawSign(cv,label,tools){
  const g=cv.getContext('2d'); g.setTransform(SS,0,0,SS,0,0); g.clearRect(0,0,SIGN_W,SIGN_H);
  g.strokeStyle='rgba(30,18,10,.9)'; g.lineWidth=3;
  g.beginPath(); g.moveTo(90,2); g.lineTo(104,18); g.moveTo(294,2); g.lineTo(280,18); g.stroke();
  const x=6,y=14,w=372,h=SIGN_H-20,r=12;
  const gr=g.createLinearGradient(0,y,0,y+h); gr.addColorStop(0,'#6e4729'); gr.addColorStop(.5,'#5a3820'); gr.addColorStop(1,'#3e2616');
  g.fillStyle=gr; g.beginPath();
  g.moveTo(x+r,y); g.arcTo(x+w,y,x+w,y+h,r); g.arcTo(x+w,y+h,x,y+h,r); g.arcTo(x,y+h,x,y,r); g.arcTo(x,y,x+w,y,r); g.closePath(); g.fill();
  g.strokeStyle='rgba(20,12,6,.8)'; g.lineWidth=3; g.stroke();
  g.strokeStyle='rgba(217,164,65,.8)'; g.lineWidth=2; g.strokeRect(x+7,y+7,w-14,h-14);
  for(let i=0;i<10;i++){ g.strokeStyle='rgba(30,16,8,.18)'; g.lineWidth=1; g.beginPath(); g.moveTo(x+12,y+16+i*13); g.bezierCurveTo(x+120,y+10+i*13,x+240,y+22+i*13,x+w-12,y+14+i*13); g.stroke(); }
  let fs=62; const text=label||'…';
  do{ g.font=`700 ${fs}px ${FONT_K}`; fs-=2; } while(g.measureText(text).width>w-40 && fs>26);
  g.textAlign='center'; g.textBaseline='middle';
  const ly=y+40;
  g.fillStyle='rgba(0,0,0,.55)'; g.fillText(text,192+2,ly+3);
  g.fillStyle='#f4e3c2'; g.fillText(text,192,ly);
  /* 第二行：已办 N */
  g.strokeStyle='rgba(217,164,65,.35)'; g.lineWidth=1; g.beginPath(); g.moveTo(x+60,y+76); g.lineTo(x+w-60,y+76); g.stroke();
  const n=String(Math.max(0,tools|0));
  g.font=`600 44px "Songti SC","Noto Serif SC",serif`; const lw=g.measureText('已办 ').width;
  g.font=`700 58px ${FONT_K}`; const nw=g.measureText(n).width;
  const sx=192-(lw+nw)/2, ny=y+h-28;
  g.textAlign='left';
  g.font=`600 44px "Songti SC","Noto Serif SC",serif`; g.fillStyle='rgba(0,0,0,.5)'; g.fillText('已办 ',sx+1,ny+2); g.fillStyle='#d9c39a'; g.fillText('已办 ',sx,ny);
  g.font=`700 58px ${FONT_K}`; g.fillStyle='rgba(0,0,0,.55)'; g.fillText(n,sx+lw+2,ny+2); g.fillStyle='#ffd27a'; g.fillText(n,sx+lw,ny);
}
function signTexture(label,tools){
  const cv=document.createElement('canvas'); cv.width=SIGN_W*SS; cv.height=SIGN_H*SS;
  drawSign(cv,label,tools);
  const t=new THREE.CanvasTexture(cv); t.anisotropy=4; t.minFilter=THREE.LinearMipmapLinearFilter;
  return t;
}
/* 木牌宽度：按距离放大，让字在屏幕上大约 15 像素高 */
function signWidth(d){ return THREE.MathUtils.clamp(d*0.095,1.7,6.2); }
function makeSign(label){
  const mat=new THREE.SpriteMaterial({map:signTexture(label),transparent:true,depthWrite:false,fog:false,toneMapped:false});
  mat.color.setScalar(0.92);
  const sp=new THREE.Sprite(mat); sp.center.set(0.5,0); sp.renderOrder=20;
  return sp;
}
/* 「x3」浮字：8 个 sprite 的池子，画布原地重画，不新建贴图 */
function drawFloat(cv,tool,count){
  const g=cv.getContext('2d'); g.setTransform(SS,0,0,SS,0,0); g.clearRect(0,0,256,112); g.textAlign='center'; g.textBaseline='alphabetic';
  if(tool){ g.font=`600 34px "Songti SC","Noto Serif SC",serif`; g.fillStyle='rgba(0,0,0,.65)'; g.fillText(tool,129,38); g.fillStyle='#ecdcb8'; g.fillText(tool,128,36); }
  g.font=`700 60px ${FONT_K}`; const s='x'+count;
  g.fillStyle='rgba(0,0,0,.65)'; g.fillText(s,130,102); g.fillStyle='#f0c060'; g.fillText(s,128,100);
}
const floatPool=[];
for(let i=0;i<8;i++){
  const cv=document.createElement('canvas'); cv.width=256*SS; cv.height=112*SS;
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(cv),transparent:true,depthWrite:false,fog:false,toneMapped:false}));
  sp.center.set(0.5,0); sp.renderOrder=21; sp.visible=false; SC.scene.add(sp);
  floatPool.push({sp,cv,busy:false});
}

/* ---------- 航线 ---------- */
const XD=-2.9, XU=2.9, R=2.9, ZN=27, ZF=-128;
const LD=ZN-ZF, LU=Math.PI*R, L=2*LD+2*LU;
const BX=-5.9, BERTHS=[17,9.5,2,-5.5,-13];
const PATH=8, RIVER_MAX=6, HALF=3.1;
const _p={x:0,z:0,tx:0,tz:-1};
function loopAt(s, phase, out){
  s=((s%L)+L)%L; let x,z,tx,tz,straight=false;
  if(s<LD){ x=XD; z=ZN-s; tx=0; tz=-1; straight=true; }
  else if(s<LD+LU){ const a=(s-LD)/R; x=-R*Math.cos(a); z=ZF-R*Math.sin(a); tx=Math.sin(a); tz=-Math.cos(a); }
  else if(s<2*LD+LU){ x=XU; z=ZF+(s-LD-LU); tx=0; tz=1; straight=true; }
  else { const a=(s-2*LD-LU)/R; x=R*Math.cos(a); z=ZN+R*Math.sin(a); tx=-Math.sin(a); tz=Math.cos(a); }
  if(straight){ const env=THREE.MathUtils.smoothstep(Math.min(z-ZF,ZN-z),0,14); x+=0.3*Math.sin(z*0.045+phase)*env; }
  out.x=x; out.z=z; out.tx=tx; out.tz=tz; return out;
}
function sOfDownZ(z){ return ZN-z; }
const headingOf=(tx,tz)=>Math.atan2(tz,-tx); // 船头是本地 -x
const ss=(u)=>u*u*(3-2*u);

/* ---------- 状态 ---------- */
const boats=new Map();      // id -> boat
const berthOcc=new Array(BERTHS.length).fill(null);
const ended=new Map();      // id -> 结束时的 lastAt
let firstSync=true, followId=null, lastState=null;
const queue=[]; let nextBeatAt=0;
const floats=[];
let endMin=10;

function shortLabel(id){ return '新会话'; }

/* 隐藏项目名（开源版分享用）：只存 localStorage，打开后船牌显示「项目 1、项目 2…」，
   回顾卡里的场景截图也一并匿名，截图分享不泄露真实项目/文件夹名 */
let hideProjects=false;
const projNames=new Map();
let projSeq=0;
function displayName(id, raw){
  if(!hideProjects) return raw||shortLabel(id);
  if(!projNames.has(id)) projNames.set(id, `项目 ${++projSeq}`);
  return projNames.get(id);
}
function setHideProjects(v){
  hideProjects=!!v;
  if(hideProjects){
    projNames.clear(); projSeq=0;
    [...boats.values()].sort((a,b)=>(a.startedAt||0)-(b.startedAt||0)).forEach(b=>{ projNames.set(b.id, `项目 ${++projSeq}`); });
  }
  for(const b of boats.values()) redrawSign(b);
}

function newBoat(id, label, startedAt, source){
  const parts=buildBoat(srcOf(id,{source}));
  const b={id,label:label||'',startedAt:startedAt||0,lastAt:0,alive:true,active:true,status:'queued',
    berth:-1,s:0,u:0,phase:Math.random()*6.28,speed:0,rowAmp:1,stroke:1,flash:0,lampOn:0,lampTarget:1,
    halo:SC.haloAlloc(),followers:[],fade:1,returning:false,readyAt:0,heading:-Math.PI/2,pos:new THREE.Vector3(),
    tail:HALF,hidden:false,pathZ:0,seenOnce:false,bornT:SC.elapsed,...parts};
  b.sign=makeSign(displayName(id, b.label||'')); b.sign.position.set(b.lampLocal.x,b.lampLocal.y+0.21,0); b.grp.add(b.sign);
  b.toolsState=0; b.toolsPend=0; b.signTools=0; b.signDrawT=-9;
  b.signLabel=b.label;
  b.grp.userData.sessionId=id; // 验收脚本按这个数船
  boats.set(id,b);
  return b;
}
function redrawSign(b){
  const tex=b.sign.material.map;
  b.signTools=(b.toolsState|0)+(b.toolsPend|0);
  drawSign(tex.image,displayName(b.id, b.signLabel||b.label||''),b.signTools);
  tex.needsUpdate=true; b.signDrawT=SC.elapsed;
}
function relabel(b,label){
  if(!label||label===b.signLabel) return;
  b.signLabel=label; b.label=label;
  redrawSign(b);
}
/* 找一个泊位：先找空的；没有就请走熄灯最久的船；allowBump 时（返航船快到码头）
   再把最晚来的排队船请到岸上看不见处等着——它还活着，有空泊位时再出现。
   这样返航船总有地方靠，不会和排队船互相等死 */
function freeBerth(allowBump){
  for(let i=0;i<BERTHS.length;i++) if(!berthOcc[i]) return i;
  let old=null;
  for(const o of boats.values()) if(o.status==='moored'&&o.berth>=0&&(!old||o.lastAt<old.lastAt)) old=o;
  if(old){ const i=old.berth; startFade(old); return i; }
  if(allowBump){
    let q=null;
    for(const o of boats.values()) if(o.status==='queued'&&!o.hidden&&o.berth>=0&&(!q||o.startedAt>q.startedAt)) q=o;
    if(q){ const i=q.berth; leaveBerth(q); q.hidden=true; q.grp.visible=false; SC.haloSet(q.halo,0,-500,0,0,0,0,0); return i; }
  }
  return -1;
}
/* 不变式：berthOcc[i]===b 当且仅当 b.berth===i */
function takeBerth(b,i){ if(b.berth===i) return; leaveBerth(b); if(berthOcc[i]&&berthOcc[i]!==b) leaveBerth(berthOcc[i]); b.berth=i; berthOcc[i]=b; }
function leaveBerth(b){ if(b.berth>=0&&berthOcc[b.berth]===b) berthOcc[b.berth]=null; b.berth=-1; }
function startFade(b){
  leaveBerth(b); b.status='fading'; b.fade=1; b.lampTarget=0; b.hidden=false;
  for(const f of b.followers) f.leaving=true;
}
function dispose(b){
  leaveBerth(b);
  SC.haloRelease(b.halo);
  for(const f of b.followers){ SC.haloRelease(f.halo); disposeGroup(f.grp); }
  disposeGroup(b.grp);
  boats.delete(b.id);
  if(followId===b.id) followId=null;
}
function placeAtBerth(b){
  if(b.berth<0) return;
  const z=BERTHS[b.berth]; b.pos.set(BX,0,z); b.heading=-Math.PI/2;
}
function riverCount(){ let n=0; for(const b of boats.values()) if(b.status==='departing'||b.status==='loop'||b.status==='docking') n++; return n; }

/* 新会话：码头泊位上出现一条船，船灯慢慢亮起，然后开出去 */
function ensureBoat(id, s, initial){
  let b=boats.get(id);
  if(b&&b.status!=='fading'){
    if(!b.alive) revive(b);
    return b;
  }
  if(b) dispose(b);
  b=newBoat(id, s&&s.label, s&&s.startedAt, s&&s.source);
  const i=freeBerth();
  if(i>=0){ takeBerth(b,i); placeAtBerth(b); }
  else { b.hidden=true; b.grp.visible=false; }
  if(initial){ b.lampOn=1; }
  return b;
}
/* 结束过的会话又有了动静：
   moored 改回排队；docking 继续靠岸，到岸后（alive）进排队再出发；loop 上的返航取消、退回预订的泊位 */
function revive(b){
  b.alive=true; b.lampTarget=1;
  if(b.returning){ b.returning=false; if(b.status==='loop') leaveBerth(b); }
  if(b.status==='moored') b.status='queued';
}
function endSession(id, lastAt){
  const b=boats.get(id); ended.set(id, lastAt||Date.now());
  if(!b||!b.alive) return;
  b.alive=false; b.active=false;
  if(b.hidden){ dispose(b); return; }
  if(b.status==='queued'){ b.status='moored'; b.lampTarget=0; return; }
  if(b.status==='departing'){ b.returning=true; return; } // 出发泊位不动，离岸完成后再要返航泊位
  if(b.status==='loop'){ b.returning=true; const i=freeBerth(false); if(i>=0) takeBerth(b,i); }
  /* docking：到岸后看 alive 决定熄灯靠着还是排队 */
}

/* ---------- 同步 state ---------- */
function sync(st){
  lastState=st;
  endMin=(st.settings&&st.settings.endMin)||10;
  const now=st.now||Date.now(), endMs=endMin*60000;
  const list=(st.sessions||[]).slice().sort((a,b)=>(a.startedAt||0)-(b.startedAt||0));
  const seen=new Set();
  const isAlive=s=>{
    if(s.ended){ if(!ended.has(s.id)) ended.set(s.id,s.lastAt||0); return false; }
    const e=ended.get(s.id);
    if(e!==undefined && !(s.active && (s.lastAt||0)>e)) return false;
    if(e!==undefined) ended.delete(s.id);
    return !!s.active || (now-(s.lastAt||0))<endMs;
  };
  if(firstSync){
    firstSync=false;
    const alive=list.filter(isAlive), dead=list.filter(s=>!isAlive(s)).sort((a,b)=>(b.lastAt||0)-(a.lastAt||0));
    const onRiver=alive.slice(0,RIVER_MAX), rest=alive.slice(RIVER_MAX);
    onRiver.forEach((s,k)=>{
      const b=newBoat(s.id,s.label,s.startedAt,s.source); b.lampOn=1; b.status='loop';
      b.s=(30+k*L/onRiver.length)%L; b.active=!!s.active; b.lastAt=s.lastAt||0; seen.add(s.id);
    });
    rest.forEach(s=>{ const b=ensureBoat(s.id,s,true); b.active=!!s.active; b.lastAt=s.lastAt||0; seen.add(s.id); });
    for(const s of dead){
      if(!berthOcc.includes(null)) break;
      const b=ensureBoat(s.id,s,true); b.alive=false; b.active=false; b.status='moored'; b.lampOn=0; b.lampTarget=0; b.lastAt=s.lastAt||0;
      ended.set(s.id,s.lastAt||0); seen.add(s.id);
    }
    for(const b of boats.values()) b.seenOnce=true; // 首次快照建的船都已被 state 确认
  }
  for(const s of list){
    seen.add(s.id);
    const alive=isAlive(s);
    let b=boats.get(s.id);
    if(alive){
      if(!b||b.status==='fading'||!b.alive) b=ensureBoat(s.id,s,false);
      b.active=!!s.active; b.lastAt=s.lastAt||0; b.startedAt=s.startedAt||b.startedAt;
      b.lampTarget=b.active?1:0.6;
      relabel(b,s.label);
    }else if(b){
      relabel(b,s.label); b.lastAt=s.lastAt||b.lastAt;
      if(b.alive) endSession(s.id,s.lastAt);
    }
  }
  /* 木牌第二行「已办」：以 state 里的 tools 为准，节拍带来的临时加数清零 */
  for(const x of list){ const b=boats.get(x.id); if(b){ b.toolsState=x.tools|0; b.toolsPend=0; } }
  /* 完整快照对账：确认过却不在快照里的船结束；节拍先建、15 秒还没进快照的船也结束 */
  for(const b of [...boats.values()]){
    if(seen.has(b.id)){ b.seenOnce=true; continue; }
    if(b.alive&&(b.seenOnce||SC.elapsed-b.bornT>15)) endSession(b.id);
  }
  /* ended 表只留快照里还有、或场景里还有船的会话，最多 300 条 */
  for(const id of [...ended.keys()]) if(!seen.has(id)&&!boats.has(id)) ended.delete(id);
  while(ended.size>300) ended.delete(ended.keys().next().value);
}
function sessionAliveInState(id){
  if(!lastState) return false;
  const s=(lastState.sessions||[]).find(x=>x.id===id);
  return !!s&&!s.ended&&!ended.has(id);
}

/* ---------- 节拍 ---------- */
function beat(bt){
  if(!bt||!bt.kind) return;
  const count=Math.max(1,(bt.count|0)||1);
  if(bt.kind==='session_start'){
    const s=lastState&&(lastState.sessions||[]).find(x=>x.id===bt.session);
    if(s&&s.ended) return;
    ended.delete(bt.session);
    const b=ensureBoat(bt.session,s||null,false); if(s) b.seenOnce=true; return;
  }
  if(bt.kind==='session_end'){ endSession(bt.session); return; }
  if(bt.kind!=='tool'&&bt.kind!=='file'&&bt.kind!=='subagent') return;
  if(bt.kind==='tool'){
    for(let i=queue.length-1;i>=0;i--){ const q=queue[i]; if(q.kind==='tool'&&q.session===bt.session&&q.tool===(bt.tool||'')){ q.count+=count; return; } }
  }
  if(queue.length>=80){
    const q=queue.find(q=>q.kind===bt.kind&&q.session===bt.session);
    if(q){ q.count+=count; if(q.tool!==bt.tool) q.tool=''; return; }
    queue.shift();
  }
  queue.push({kind:bt.kind,session:bt.session,tool:bt.tool||'',count});
}
function playBeat(q,b,t){
  if(q.kind==='tool'){
    if(b){ b.toolsPend+=q.count; b.stroke=0; b.flash=1; if(b.status!=='queued'&&b.status!=='moored'){ const st=sternWorld(b); SC.spawnRipple(st.x,st.z,0.5); } }
    if(b&&q.count>1) addFloat(b,q.tool,q.count);
  }else if(q.kind==='file'){
    const n=Math.min(q.count,4);
    for(let i=0;i<n;i++){ const w=SC.lightWindow(b&&!b.hidden?b.pos:null); if(w>=0) JN.Fleet.onWindowLit&&JN.Fleet.onWindowLit(w); }
    if(b){ b.flash=Math.max(b.flash,0.6); }
  }else if(q.kind==='subagent'){
    if(b) for(let i=0;i<Math.min(q.count,3);i++) addFollower(b,t);
  }
}
const _st=new THREE.Vector3();
function sternWorld(b){ return _st.set(2.6,0,0).applyMatrix4(b.grp.matrixWorld); }

function addFloat(b,tool,count){
  let p=floatPool.find(x=>!x.busy);
  if(!p){ const old=floats.shift(); p=old.p; }
  p.busy=true; drawFloat(p.cv,tool,count); p.sp.material.map.needsUpdate=true; p.sp.visible=true;
  floats.push({sp:p.sp,p,b,t:0});
}

/* 子代理小船 */
const FOLLOW_LIFE_DEMO=26, FOLLOW_LIFE=90;
function addFollower(b,t){
  if(b.followers.filter(f=>!f.leaving).length>=3){ const old=b.followers.find(f=>!f.leaving); if(old) old.leaving=true; }
  const parts=buildBoat(b.type); parts.grp.scale.setScalar(0.6);
  setOpacity(parts.grp,0);
  const f={...parts,halo:SC.haloAlloc(),born:t,life:(JN.Data&&JN.Data.mode==='demo')?FOLLOW_LIFE_DEMO:FOLLOW_LIFE,
    gap:7,leaving:false,alpha:0,side:(b.followers.length%2?1:-1)*0.45,phase:Math.random()*6.28,lampOn:0};
  f.lampMat.color.copy(LAMP_ON);
  b.followers.push(f);
}

/* ---------- 每帧 ---------- */
function update(dt, n){
  const t=SC.elapsed, base=2.3*SC.S.boat;
  /* 1. 排队的船出发 */
  let rc=riverCount();
  const qd=[...boats.values()].filter(b=>b.status==='queued'&&b.alive&&!b.hidden&&b.lampOn>0.8).sort((a,b)=>a.startedAt-b.startedAt);
  const loopers=[...boats.values()].filter(b=>b.status==='loop');
  for(const b of qd){
    if(rc>=RIVER_MAX) break;
    const sj=sOfDownZ(BERTHS[b.berth]-PATH);
    let clear=true;
    for(const o of loopers){
      const behind=(sj-o.s+L)%L, ahead=(o.s-sj+L)%L;
      if(behind<20||ahead<o.tail+HALF+6){ clear=false; break; }
    }
    for(const o of boats.values()) if(o!==b&&o.status==='departing'&&Math.abs(o.pathZ-BERTHS[b.berth])<14) clear=false;
    if(!clear) break; // 先来先走，后面的不插队
    b.status='departing'; b.u=0; b.pathZ=BERTHS[b.berth]; rc++;
  }
  /* 隐藏的等候船补泊位 */
  for(const b of [...boats.values()].filter(x=>x.hidden&&x.alive).sort((a,c)=>a.startedAt-c.startedAt)){ const i=berthOcc.indexOf(null); if(i<0) break; takeBerth(b,i); placeAtBerth(b); b.hidden=false; b.grp.visible=true; }

  /* 2. 航线上的船保持间距 */
  loopers.sort((a,b)=>a.s-b.s);
  const nL=loopers.length;
  for(let k=0;k<nL;k++){
    const b=loopers[k];
    let f=1;
    if(nL>1){
      const a=loopers[(k+1)%nL], c=loopers[(k-1+nL)%nL];
      const gA=((a.s-b.s+L)%L)-a.tail-HALF, gB=((b.s-c.s+L)%L)-b.tail-HALF;
      f = gA<16 ? THREE.MathUtils.clamp((gA-3)/13,0,1) : 1+0.12*THREE.MathUtils.clamp((gA-gB)/60,-1,1);
    }
    b.speed+= (base*f-b.speed)*Math.min(1,dt*1.5);
  }

  /* 3. 移动 */
  for(const b of [...boats.values()]){
    b.tail=HALF+b.followers.filter(f=>!f.leaving).length*4.6;
    if(b.hidden){ SC.haloSet(b.halo,0,-500,0,0,0,0,0); for(const f of b.followers) SC.haloSet(f.halo,0,-500,0,0,0,0,0); continue; }
    if(b.status==='loop'){
      if(b.returning&&b.berth>=0){
        const sx=sOfDownZ(BERTHS[b.berth]+PATH), ds=(sx-b.s+L)%L;
        if(ds<=b.speed*dt+1e-3){ b.status='docking'; b.u=0; b.pathZ=BERTHS[b.berth]; }
      }
      if(b.status==='loop'){
        b.s=(b.s+b.speed*dt)%L;
        if(b.returning&&b.berth<0){
          /* 先找空位或请走熄灯船；快到码头（近端掉头处）还没有，就请一条排队船上岸等 */
          const near=b.s>L-45||b.s<1;
          const i=freeBerth(near); if(i>=0) takeBerth(b,i);
        }
        loopAt(b.s,b.phase,_p);
        b.pos.set(_p.x,0,_p.z); b.heading=headingOf(_p.tx,_p.tz);
      }
    }
    if(b.status==='departing'){
      const bz=b.pathZ;
      b.speed=base*(0.35+0.65*ss(Math.min(1,b.u*1.6)));
      b.u=Math.min(1,b.u+b.speed*dt/(PATH+0.6));
      const x=BX+(XD-BX)*ss(b.u), z=bz-PATH*b.u;
      const dx=(XD-BX)*6*b.u*(1-b.u)/PATH;
      b.pos.set(x,0,z); b.heading=headingOf(dx,-1);
      if(b.u>=1){
        leaveBerth(b); b.status='loop'; b.s=sOfDownZ(z);
        if(b.returning){ const i=freeBerth(false); if(i>=0) takeBerth(b,i); }
      }
    }else if(b.status==='docking'){
      const bz=b.pathZ;
      const v=base*(1-0.8*b.u);
      b.u=Math.min(1,b.u+v*dt/(PATH+0.6));
      const x=XD+(BX-XD)*ss(b.u), z=bz+PATH-PATH*b.u;
      const dx=(BX-XD)*6*b.u*(1-b.u)/PATH;
      b.pos.set(x,0,z); b.heading=headingOf(dx,-1);
      if(b.u>=1){
        b.returning=false;
        if(b.alive){ b.status='queued'; b.lampTarget=b.active?1:0.6; } // 靠岸途中会话又活了：排队再出发
        else { b.status='moored'; b.lampTarget=0; b.lastAt=b.lastAt||Date.now(); }
      }
    }else if(b.status==='queued'||b.status==='moored'){
      if(b.berth>=0) placeAtBerth(b);
    }
    if(b.status==='fading'){
      b.fade-=dt/2.2; setOpacity(b.grp,Math.max(0,b.fade)); b.sign.material.opacity=Math.max(0,b.fade);
      if(b.fade<=0){ dispose(b); continue; }
    }

    /* 摇桨、灯 */
    const moving=b.status==='loop'||b.status==='departing'||b.status==='docking';
    const rowTarget=moving?(b.active?1:0.25):0;
    b.rowAmp+=(rowTarget-b.rowAmp)*Math.min(1,dt*1.5);
    b.stroke=Math.min(1,b.stroke+dt/0.85);
    b.flash*=Math.exp(-dt*3.2);
    const lt=b.alive?(b.status==='moored'?0:b.lampTarget):(b.status==='moored'||b.status==='fading'?0:0.7);
    const ld=lt-b.lampOn; b.lampOn+=Math.sign(ld)*Math.min(Math.abs(ld),dt/1.3);
    const kick=b.stroke<1?Math.sin(b.stroke*Math.PI*2):0;
    const bob=moving?1:0.5;
    b.grp.position.set(b.pos.x,0.03*Math.sin(t*1.4+b.phase)*bob,b.pos.z);
    b.grp.rotation.set(0.02*Math.sin(t*0.9+b.phase*2)*bob,b.heading,0.028*Math.sin(t*1.1+b.phase)*bob);
    b.oar.rotation.x=0.5+Math.sin(t*2.2+b.phase)*0.35*b.rowAmp+0.55*kick*(1-b.stroke*0.5);
    b.man.rotation.z=-0.12+Math.sin(t*2.2+b.phase)*0.06*b.rowAmp+0.1*kick;
    b.flag.rotation.y=0.35*Math.sin(t*1.9+b.phase)+0.12*Math.sin(t*4.3+b.phase*2); // 旗子迎风摆
    if(b.glb) b.glb.rotation.z=0.04*kick;                                              // GLB 船：节拍时整条船轻轻一顿
    const lon=b.lampOn, fl=b.flash;
    b.lampMat.color.copy(LAMP_OFF).lerp(LAMP_ON,Math.min(1,lon));
    b.lampMat.emissiveIntensity=SC.boatLampLevel*lon*(1+fl*2.2);
    if(moving&&b.speed>0.4){
      b.rippleT=(b.rippleT||0)-dt;
      if(b.rippleT<=0){ b.rippleT=0.55; b.grp.updateMatrixWorld(); const st=sternWorld(b); SC.spawnRipple(st.x,st.z,0.45*Math.min(1,b.speed/2)); }
    }
    b.grp.updateMatrixWorld();
    const lw=_st.copy(b.lampLocal).applyMatrix4(b.grp.matrixWorld);
    const hk=lon*(1+fl*1.6)*(b.fade);
    SC.haloSet(b.halo,lw.x,lw.y,lw.z,1.6*(1+fl*0.9),hk,0.32*hk,0.1*hk);
    if((b.toolsState+b.toolsPend)!==b.signTools&&SC.elapsed-b.signDrawT>=1) redrawSign(b); // 每秒最多重画一次
    /* 木牌：远处放大，过远淡出 */
    const d=SC.camera.position.distanceTo(lw);
    const w=signWidth(d);
    b.sign.scale.set(w,w*SIGN_H/SIGN_W,1);
    const far=1-THREE.MathUtils.smoothstep(d,95,140);
    b.sign.material.opacity=(b.status==='fading'?Math.max(0,b.fade):1)*far*(b.alive?1:(b.status==='moored'?0.12:0.55)); // 已结束靠岸的船木牌几乎隐去，不让码头堆满字
    b.sign.visible=far>0.01;

    updateFollowers(b,dt,t);
  }

  /* 4. 节拍队列：同一帧最多播一个，同一条船至少隔 0.6 秒 */
  if(t>=nextBeatAt&&queue.length){
    for(let i=0;i<queue.length;i++){
      const q=queue[i], b=boats.get(q.session)||null;
      if(b&&b.readyAt>t) continue;
      queue.splice(i,1);
      /* 找不到船：只有 state 里这个会话还活着才补建；否则是过期节拍，丢掉（改文件仍点亮窗户） */
      const bb=b||(q.kind!=='file'&&sessionAliveInState(q.session)?ensureBoat(q.session,(lastState.sessions||[]).find(x=>x.id===q.session),false):null);
      if(bb&&!b) bb.seenOnce=true;
      if(!bb&&q.kind!=='file'){ nextBeatAt=t; break; }
      playBeat(q,bb,t);
      if(bb) bb.readyAt=t+0.6;
      nextBeatAt=t+0.16;
      break;
    }
  }

  /* 5. 浮字 */
  for(let i=floats.length-1;i>=0;i--){
    const f=floats[i]; f.t+=dt;
    const k=f.t/1.8;
    if(k>=1||!boats.has(f.b.id)){ f.sp.visible=false; f.p.busy=false; floats.splice(i,1); continue; }
    const b=f.b; const lw=_st.copy(b.lampLocal).applyMatrix4(b.grp.matrixWorld);
    const d=SC.camera.position.distanceTo(lw);
    const w=THREE.MathUtils.clamp(d*0.1,1.4,6);
    const sw=signWidth(d);
    f.sp.position.set(lw.x,lw.y+0.25+sw*SIGN_H/SIGN_W+0.15+k*1.2*(w/1.4),lw.z);
    f.sp.scale.set(w,w*112/256,1);
    f.sp.material.opacity=k<0.15?k/0.15:(k>0.6?1-(k-0.6)/0.4:1);
  }
}

function updateFollowers(b,dt,t){
  const onLoop=b.status==='loop';
  let idx=0;
  for(let i=b.followers.length-1;i>=0;i--){
    const f=b.followers[i];
    if(!f.leaving&&t-f.born>f.life) f.leaving=true;
    if(f.leaving){ f.alpha-=dt/3; f.gap+=dt*2.2; }
    else f.alpha=Math.min(1,f.alpha+dt/1.2);
    if(f.alpha<=0&&f.leaving){ SC.haloRelease(f.halo); disposeGroup(f.grp); b.followers.splice(i,1); continue; }
  }
  for(const f of b.followers){
    const want=HALF+2.6+idx*4.6+(f.leaving?0:0);
    if(!f.leaving) f.gap+=(want-f.gap)*Math.min(1,dt*0.8);
    if(!f.leaving) idx++;
    const vis=onLoop&&b.status!=='fading';
    f.grp.visible=vis;
    if(!vis){ SC.haloSet(f.halo,0,-500,0,0,0,0,0); continue; }
    loopAt(b.s-f.gap,b.phase,_p);
    const nx=-_p.tz, nz=_p.tx;
    f.grp.position.set(_p.x+nx*f.side,0.03*Math.sin(t*1.6+f.phase),_p.z+nz*f.side);
    f.grp.rotation.set(0.02*Math.sin(t*1.0+f.phase),headingOf(_p.tx,_p.tz),0.03*Math.sin(t*1.3+f.phase));
    f.oar.rotation.x=0.5+Math.sin(t*2.6+f.phase)*0.35;
    setOpacity(f.grp,Math.max(0,f.alpha));
    f.lampMat.emissiveIntensity=SC.boatLampLevel*Math.max(0,f.alpha);
    f.grp.updateMatrixWorld();
    const lw=_st.copy(f.lampLocal).applyMatrix4(f.grp.matrixWorld);
    const a=Math.max(0,f.alpha)*0.8;
    SC.haloSet(f.halo,lw.x,lw.y,lw.z,1.0,a,0.32*a,0.1*a);
  }
}

/* 夜航随船：跟住一条在河里的船（尽量不换） */
function followTarget(){
  let b=followId&&boats.get(followId);
  const onRiver=o=>o&&(o.status==='loop'||o.status==='departing'||o.status==='docking');
  if(!onRiver(b)){
    b=null; let best=Infinity;
    for(const o of boats.values()) if(onRiver(o)){ const sc=Math.abs(o.pos.z+20)+(o.status==='loop'?0:30); if(sc<best){ best=sc; b=o; } }
    followId=b?b.id:null;
  }
  return b?{pos:b.grp.position,heading:b.heading}:null;
}

function stats(){
  let river=0, queued=0, moored=0, active=0;
  for(const b of boats.values()){
    if(b.status==='loop'||b.status==='departing'||b.status==='docking') river++;
    else if(b.status==='queued'||b.hidden) queued++;
    else if(b.status==='moored') moored++;
    if(b.alive&&b.active) active++;
  }
  return {river,queued,moored,active,queue:queue.length};
}
function busy(){ return queue.length>0||floats.length>0; }

/* 自检：泊位占用和船的状态是否一致（压力测试用） */
function check(){
  const bad=[];
  for(let i=0;i<BERTHS.length;i++){ const o=berthOcc[i]; if(o&&(!boats.has(o.id)||boats.get(o.id)!==o||o.berth!==i)) bad.push('berth'+i+'->'+(o&&o.id)); }
  for(const b of boats.values()){
    if(b.berth>=0&&berthOcc[b.berth]!==b) bad.push(b.id+' berth '+b.berth+' not owned');
    if((b.status==='queued'||b.status==='moored')&&b.berth<0&&!b.hidden) bad.push(b.id+' '+b.status+' without berth');
    if(b.status==='docking'&&b.berth<0) bad.push(b.id+' docking without berth');
    if(b.alive&&b.status==='moored') bad.push(b.id+' alive but moored');
  }
  return bad;
}
return { sync, beat, update, followTarget, stats, busy, check, boats, BERTHS, BX, ended, PLATFORMS, PCOLOR, PNAME, buildBoat, onWindowLit:null, setHideProjects, get hideProjects(){ return hideProjects; } };
})();

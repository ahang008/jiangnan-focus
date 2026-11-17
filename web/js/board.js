/* 江南入夜 · 今日水牌
   东岸拱桥脚下、临河步道上一块雕花木牌，石座、小瓦顶、红结；牌面是一张实时画布：
   「今日水牌」+ 六个平台各一行（旗色、名字、今日 token、占比、细条），没有用量的平台灰着照列。
   数字变了才重画，每秒最多一次；超清画质下画布加倍。点水牌，镜头飞到它跟前（setView('board')）。 */
window.JN = window.JN || {};
JN.Board = (function(){
'use strict';
const SC=JN.Scene; if(!SC) return null;
const THREE=window.THREE, M=SC.M;
const F=JN.Fleet;
const P=F?F.PLATFORMS:['claude','codex','deepseek','grok','magpie','cursor'];
const COLOR=F?F.PCOLOR:{}, NAME=F?F.PNAME:{};
const GROUND=SC.K.BANK_TOP+0.18;
const POS={x:8.9,z:-16.7,yaw:-0.1};      // 临河步道上，正面大致朝望全河的镜头
const PW=2.3, PH=1.56;                     // 牌面（米）
const CW=1024, CH=Math.round(1024*PH/PW), RS=SC.ULTRA?2:1;

/* ---------- 木牌本体 ---------- */
const grp=new THREE.Group(); grp.position.set(POS.x,GROUND,POS.z); grp.rotation.y=POS.yaw;
const red=new THREE.MeshStandardMaterial({color:0x6a1f12,roughness:0.7});
const gold=new THREE.MeshStandardMaterial({color:0xc9962e,metalness:0.55,roughness:0.4,emissive:0x3a2606,emissiveIntensity:0.4});
const knot=new THREE.MeshStandardMaterial({color:0xc0301a,emissive:0x5a0c04,emissiveIntensity:0.5,roughness:0.6});
const box=(m,w,h,d,x,y,z)=>{ const o=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m); o.position.set(x,y,z); o.castShadow=true; o.receiveShadow=true; grp.add(o); return o; };
box(M.stoneDark,2.9,0.42,0.8,0,0.21,0);                     // 石座
box(M.stone,3.05,0.08,0.92,0,0.46,0);
for(const x of [-1.3,1.3]){ box(red,0.16,2.62,0.16,x,0.5+1.31,0); box(M.stone,0.34,0.2,0.34,x,0.6,0); }
box(red,2.62,0.14,0.14,0,0.5+2.55,0);                       // 上横梁
box(red,2.62,0.12,0.14,0,0.5+0.62,0);                       // 下横梁
const cy=0.5+0.62+0.08+PH/2+0.02;                           // 牌面中心高度
box(M.woodDark,PW+0.12,PH+0.12,0.06,0,cy,-0.03);            // 背板
for(const [w,h,x,y] of [[PW+0.16,0.035,0,cy+PH/2+0.05],[PW+0.16,0.035,0,cy-PH/2-0.05],[0.035,PH+0.1,-PW/2-0.06,cy],[0.035,PH+0.1,PW/2+0.06,cy]]) box(gold,w,h,0.05,x,y,0.01);
const roof=new THREE.Mesh(SC.geo.unitPrism,M.roof); roof.scale.set(1.75,0.42,0.62); roof.rotation.y=Math.PI/2; roof.position.set(0,0.5+2.62,0); roof.castShadow=true; grp.add(roof);
const ridge=box(M.ridge,3.4,0.09,0.12,0,0.5+2.62+0.44,0);
for(const x of [-1.42,1.42]){                                // 两侧红结和流苏
  const k=new THREE.Mesh(new THREE.SphereGeometry(0.09,10,8),knot); k.position.set(x,cy+0.45,0.12); grp.add(k);
  const t=new THREE.Mesh(new THREE.CylinderGeometry(0.02,0.05,0.42,6),knot); t.position.set(x,cy+0.18,0.12); grp.add(t);
}
/* 牌面画布 */
const cv=document.createElement('canvas'); cv.width=CW*RS; cv.height=CH*RS;
const tex=new THREE.CanvasTexture(cv); tex.anisotropy=8; tex.minFilter=THREE.LinearMipmapLinearFilter;
const panel=new THREE.Mesh(new THREE.PlaneGeometry(PW,PH),new THREE.MeshStandardMaterial({map:tex,roughness:0.85,emissive:0xffffff,emissiveMap:tex,emissiveIntensity:0.18}));
panel.position.set(0,cy,0.005); grp.add(panel);
const codeBody=grp.children.filter(o=>o!==panel); // 代码搭的木牌本体（GLB 来了就藏起）
/* 换成 Tripo 水牌：按空白牌面的宽度缩放，让空白牌面正好落在原牌面的位置；再用射线找牌面真实深度，画布贴在前面 1.5 厘米 */
function useModel(root,rect){
  const [x0,x1,y0,y1]=rect, k=PW/(x1-x0);
  const g=new THREE.Group(); const inner=root; g.add(inner); g.scale.setScalar(k);
  g.position.set(-k*(x0+x1)/2,0,0);                 // 模型底面落在石座位置（模型底就是 y=0）
  const dy=k*(y0+y1)/2-panel.position.y; panel.position.y+=dy; VIEW.t[1]+=dy; VIEW.p[1]+=dy;
  root.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.receiveShadow=true; for(const m of [].concat(o.material)){ if(m.map){ m.map.encoding=THREE.LinearEncoding; m.map.anisotropy=8; m.map.needsUpdate=true; } m.metalness=0; m.metalnessMap=null; m.side=THREE.DoubleSide; } } });
  grp.add(g); for(const o of codeBody) o.visible=false;
  grp.updateMatrixWorld(true);
  const ray=new THREE.Raycaster(); const o2=new THREE.Vector3(0,cy,3).applyMatrix4(grp.matrixWorld), d=new THREE.Vector3(0,0,-1).transformDirection(grp.matrixWorld);
  o2.set(0,panel.position.y,3).applyMatrix4(grp.matrixWorld);
  ray.set(o2,d); const hit=ray.intersectObject(g,true)[0];
  if(hit){ const local=grp.worldToLocal(hit.point.clone()); panel.position.z=local.z+0.015; }
  SC.shadowsDirty();
}
/* 步道外侧（|x|>9.6）没有地面，补一块石地，免得木牌后面露出水面 */
const pad=new THREE.Mesh(new THREE.BoxGeometry(2.2,GROUND+0.2,3.2),M.stone); pad.position.set(10.7,(GROUND+0.2)/2-0.2,POS.z); pad.receiveShadow=true;
SC.scene.add(pad); SC.scene.add(grp);
SC.shadowsDirty();

/* ---------- 画牌面 ---------- */
function wan(n){ n=Math.max(0,n||0); if(n<1e4) return n.toLocaleString('en-US'); return (n/1e4).toFixed(n<1e5?1:0).replace(/\.0$/,'')+' 万'; }
let last='', lastT=-9, data=null;
function draw(by){
  const g=cv.getContext('2d'); g.setTransform(RS,0,0,RS,0,0);
  const gr=g.createLinearGradient(0,0,0,CH); gr.addColorStop(0,'#f1e6ca'); gr.addColorStop(1,'#e2d2ae');
  g.fillStyle=gr; g.fillRect(0,0,CW,CH);
  for(let i=0;i<500;i++){ g.fillStyle=`rgba(120,90,50,${Math.random()*0.05})`; g.fillRect(Math.random()*CW,Math.random()*CH,Math.random()*3+1,1); }
  g.strokeStyle='rgba(150,110,40,.75)'; g.lineWidth=2; g.strokeRect(18,18,CW-36,CH-36);
  g.strokeStyle='rgba(150,110,40,.35)'; g.lineWidth=1; g.strokeRect(26,26,CW-52,CH-52);
  const K='"STKaiti","KaiTi","Kaiti SC",serif', SONG='"Songti SC","Noto Serif SC",serif';
  g.textBaseline='middle'; g.textAlign='center'; g.fillStyle='#2a170c'; g.font=`700 64px ${K}`;
  g.fillText('今 日 水 牌',CW/2,82);
  /* 朱砂小印 */
  g.fillStyle='#b8321c'; g.fillRect(CW-150,52,62,62); g.fillStyle='#fff1df'; g.font=`700 24px ${K}`; g.fillText('江南',CW-119,72); g.fillText('入夜',CW-119,98);
  const total=P.reduce((a,k)=>a+(by[k]?by[k].tokens:0),0);
  g.strokeStyle='rgba(150,110,40,.55)'; g.beginPath(); g.moveTo(70,128); g.lineTo(CW-70,128); g.stroke();
  const top=154, rowH=(CH-top-72)/6;
  P.forEach((k,i)=>{
    const v=by[k]||{tokens:0}, y=top+i*rowH+rowH*0.42, zero=!v.tokens;
    const share=total?v.tokens/total:0;
    g.globalAlpha=zero?0.42:1;
    /* 燕尾小旗当色块 */
    g.fillStyle=COLOR[k]||'#999'; g.beginPath(); g.moveTo(72,y-15); g.lineTo(122,y-14); g.lineTo(110,y); g.lineTo(122,y+14); g.lineTo(72,y+15); g.closePath(); g.fill();
    g.strokeStyle='rgba(40,24,12,.6)'; g.lineWidth=1.2; g.stroke();
    g.textAlign='left'; g.fillStyle='#2a170c'; g.font=`600 34px ${SONG}`; g.fillText(NAME[k]||k,146,y);
    g.textAlign='right'; g.font=`700 38px ${K}`; g.fillText(zero?'—':wan(v.tokens),CW-210,y);
    g.font=`500 28px ${SONG}`; g.fillStyle='#6a4a2a'; g.fillText(zero?'0%':(share*100).toFixed(share<0.1?1:0)+'%',CW-76,y);
    /* 细条 */
    const bx=146, bw=CW-146-76, by0=y+rowH*0.36;
    g.fillStyle='rgba(120,90,50,.18)'; g.fillRect(bx,by0,bw,5);
    g.fillStyle=k==='codex'||k==='cursor'?'#8a8f96':(COLOR[k]||'#999'); g.fillRect(bx,by0,Math.max(zero?0:3,bw*share),5);
    g.globalAlpha=1;
  });
  g.textAlign='center'; g.fillStyle='#5a3a1e'; g.font=`500 26px ${SONG}`;
  g.fillText(`合计 ${wan(total)} token`,CW/2,CH-44);
  tex.needsUpdate=true;
}
draw({});
function update(state,t){
  const by=(state&&state.today&&state.today.bySource)||{};
  const sig=P.map(k=>by[k]?by[k].tokens:0).join(',');
  if(sig===last||t-lastT<1) return;
  last=sig; lastT=t; data=JSON.parse(JSON.stringify(by)); draw(by);
}

/* ---------- 点水牌：镜头飞过去 ---------- */
const ray=new THREE.Raycaster(), ndc=new THREE.Vector2(); let down=null;
const dom=SC.renderer.domElement;
dom.addEventListener('pointerdown',e=>{ down={x:e.clientX,y:e.clientY}; });
dom.addEventListener('pointerup',e=>{
  if(!down||Math.hypot(e.clientX-down.x,e.clientY-down.y)>6) return; down=null;
  const r=dom.getBoundingClientRect(); ndc.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);
  ray.setFromCamera(ndc,SC.camera);
  if(ray.intersectObject(grp,true).length) SC.setView('board');
});
const front=new THREE.Vector3(Math.sin(POS.yaw),0,Math.cos(POS.yaw));
const center=new THREE.Vector3(POS.x,GROUND+cy,POS.z);
const VIEW={p:center.clone().addScaledVector(front,3.0).add(new THREE.Vector3(-2.2,0.25,0)).toArray(),t:center.clone().add(new THREE.Vector3(0,-0.1,0)).toArray()}; // 从河面一侧斜着看，避开身后民居的屋檐
function viewFor(name){ return name==='board'?VIEW:null; }
return {update,viewFor,useModel,get data(){ return data; },group:grp};
})();

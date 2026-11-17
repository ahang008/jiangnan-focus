/* 江南入夜 · 场景模型：按 models/manifest.json 的 scene 一栏，把 Tripo 的拱桥、水牌、三种房子换进来
   - 房子：七栋临河民居（scene.js GLB_HOUSES）换成 house_a/b/c，同一变体共用几何和材质（clone 共享）；
     原民居整栋藏起，事先量好的窗口叠层接手点亮（射线找真实墙面，叠在墙前 4 厘米），house_c 檐下补两盏灯
   - 拱桥：程序拱桥整组藏起，Tripo 拱桥按桥长 26 米放在原位（中拱净空在两条航道处约 4 到 5 米，船过得去）
   - 水牌：交给 board.js 换本体、对齐牌面
   没登记的模型不加载、不发请求；加载失败就保持程序版 */
window.JN = window.JN || {};
JN.SceneModels = (function(){
'use strict';
const SC=JN.Scene; if(!SC||!THREE.GLTFLoader) return null;
const THREE_=window.THREE, loader=new THREE_.GLTFLoader();
const status={};
function prep(root){
  root.traverse(o=>{
    if(!o.isMesh) return;
    o.castShadow=true; o.receiveShadow=true;
    for(const m of [].concat(o.material)){
      if(m.map){ m.map.encoding=THREE_.LinearEncoding; m.map.anisotropy=8; m.map.needsUpdate=true; }
      m.metalness=0; m.metalnessMap=null; m.roughness=Math.max(0.75,m.roughness||1);
      m.side=THREE_.DoubleSide;           // 减面后少数三角朝向反了，双面渲染免得露出小洞
      m.needsUpdate=true;
    }
  });
  return root;
}
function placeHouses(variant,src){
  const ray=new THREE_.Raycaster();
  for(const def of SC.GLB_HOUSES.filter(d=>d.v===variant)){
    if(!SC.slots[def.id]) continue;
    const T=SC.glbHouseXform(def);
    const g=src.clone(true); g.scale.setScalar(T.k); g.position.copy(T.O); g.rotation.y=T.ry; g.name='glb:'+def.id;
    SC.scene.add(g); g.updateMatrixWorld(true);
    SC.setSlotHidden(def.id,true);
    /* 窗口叠层贴到真实墙面上 */
    const n=new THREE_.Vector3(-def.side,0,0); // 朝河的方向
    for(const w of SC.glbWindows(def.id)){
      ray.set(w.pos.clone().addScaledVector(n,3),n.clone().negate()); ray.far=6;
      const hit=ray.intersectObject(g,true)[0];
      if(hit&&hit.point.distanceTo(w.pos)<2.5) SC.setWindowPos(w.i,hit.point.clone().addScaledVector(n,0.04));
    }
  }
}
function placeBridge(src,e){
  const box=new THREE_.Box3().setFromObject(src), size=box.getSize(new THREE_.Vector3());
  const k=(e.span||26)/size.x;
  const g=new THREE_.Group(); const c=box.getCenter(new THREE_.Vector3());
  src.position.set(-c.x,-box.min.y,-c.z); g.add(src); g.scale.setScalar(k);
  g.position.set(0,0,SC.K.BRIDGE_Z); g.name='glb:bridge';
  SC.scene.add(g); SC.setSlotHidden('bridge',true);
}
JN.manifest=JN.manifest||(/[?&]nomodels=1/.test(location.search)?Promise.resolve({}):fetch('models/manifest.json',{cache:'no-cache'}).then(r=>r.ok?r.json():{}).catch(()=>({}))); // ?nomodels=1：全用程序版（对比用）
JN.manifest.then(man=>{
  const sc=(man&&man.scene)||{};
  for(const v of ['house_a','house_b','house_c']){
    const e=sc[v]; if(!e||!e.file) continue; status[v]='loading';
    loader.load(e.file,gl=>{ placeHouses(v,prep(gl.scene)); status[v]='ok'; SC.shadowsDirty(); },undefined,()=>{ status[v]='failed'; });
  }
  if(sc.bridge&&sc.bridge.file){ status.bridge='loading'; loader.load(sc.bridge.file,gl=>{ placeBridge(prep(gl.scene),sc.bridge); status.bridge='ok'; SC.shadowsDirty(); },undefined,()=>{ status.bridge='failed'; }); }
  const nb=sc.noticeboard;
  if(nb&&nb.file&&JN.Board&&JN.Board.useModel){ status.noticeboard='loading'; loader.load(nb.file,gl=>{ JN.Board.useModel(gl.scene,nb.panel||[-0.258,0.254,0.335,0.687]); status.noticeboard='ok'; },undefined,()=>{ status.noticeboard='failed'; }); }
});
return {status};
})();

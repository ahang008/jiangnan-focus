/* 江南入夜 · 场景模型：按 models/manifest.json 的 scene 一栏，把 Tripo 的拱桥、水牌、全部民居变体换进来
   - 房子：全部程序地块（scene.js slots）自动换成 house_a~g 变体，同一变体共用几何和材质（clone 共享）；
     原民居整栋藏起，事先量好的窗口叠层接手点亮（射线找真实墙面，叠在墙前 4 厘米），house_c 檐下补两盏灯；
     隔栋左右镜像（scale.x 取负，DoubleSide 保证不露反面）
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
const MIRROR_M=new THREE_.Matrix4().makeScale(-1,1,1);
function mirroredGeometry(geo){
  const g=geo.clone();
  g.applyMatrix4(MIRROR_M); // 预先把几何沿宽翻转，实例矩阵用正 scale，法线/光照方向才正确
  return g;
}
function placeHouses(variant,src){
  /* 同一变体的所有地块合并成 InstancedMesh：每个子 mesh 一组，镜像实例单独一组（几何已预翻转）。
     不再逐栋 clone 成独立 Mesh，draw call 从「栋数 × 子 mesh 数」降到「子 mesh 数 × 2」。 */
  const meshes=[];
  src.traverse(o=>{ if(o.isMesh) meshes.push(o); });
  const normal=[], mirror=[];
  for(const id in SC.slots){
    const sl=SC.slots[id];
    if(!sl||sl.glb!==variant) continue;
    (sl.mirror?mirror:normal).push(id);
  }
  const groups={normal:[],mirror:[]};
  function buildGroup(kind,ids){
    if(!ids.length) return;
    const isMirror=kind==='mirror';
    meshes.forEach((mesh,mi)=>{
      const geo=isMirror?mirroredGeometry(mesh.geometry):mesh.geometry;
      const im=new THREE_.InstancedMesh(geo,mesh.material,ids.length);
      im.castShadow=true; im.receiveShadow=true;
      im.name='glb:'+variant+':'+kind+':'+mi;
      SC.scene.add(im);
      groups[kind].push(im);
    });
  }
  buildGroup('normal',normal);
  buildGroup('mirror',mirror);
  const _e=new THREE_.Euler(), _q=new THREE_.Quaternion(), _v=new THREE_.Vector3(), _m=new THREE_.Matrix4();
  function setSlotMatrix(id,kind,index){
    const sl=SC.slots[id];
    const def={id,v:variant,side:sl.side,c:sl.c,w:sl.w,mirror:!!sl.mirror};
    const T=SC.glbHouseXform(def);
    _e.set(0,T.ry,0); _q.setFromEuler(_e);
    const sx=kind==='mirror'?Math.abs(T.sx):T.sx;
    _m.compose(T.O,_q,_v.set(sx,T.k,T.k));
    for(const im of groups[kind]) im.setMatrixAt(index,_m);
  }
  normal.forEach((id,i)=>setSlotMatrix(id,'normal',i));
  mirror.forEach((id,i)=>setSlotMatrix(id,'mirror',i));
  for(const im of [...groups.normal,...groups.mirror]) im.instanceMatrix.needsUpdate=true;

  /* 窗口叠层贴到真实墙面上（用临时单栋 clone 打射线，clone 共享几何、不进场景，射线完即弃）：
       - 没打到（悬空/高出屋顶）→ 不显示；
       - 打到屋顶斜面/檐口底面（|ny| 大）→ 不显示；
       - 打到正面墙（|nx| 大）→ 吸附到命中点，深度再和同排其它窗比，差太多 → 不显示；
       - 打到侧墙/窗洞侧壁（|nx|、|ny| 都小）→ 用同排已保留正面窗的墙深对准，同排没有可靠正面墙就藏；
       镜像房子法线判定取绝对值，天然适用。 */
  const ray=new THREE_.Raycaster();
  const nm=new THREE_.Matrix3();
  const medOf=arr=>{ const a=arr.slice().sort((a,b)=>a-b); return a.length?a[Math.floor(a.length/2)]:null; };
  for(const id of [...normal,...mirror]){
    const sl=SC.slots[id];
    SC.setSlotHidden(id,true);
    const def={id,v:variant,side:sl.side,c:sl.c,w:sl.w,mirror:!!sl.mirror};
    const T=SC.glbHouseXform(def);
    const g=src.clone(true); g.scale.set(T.sx,T.k,T.k); g.position.copy(T.O); g.rotation.y=T.ry; g.updateMatrixWorld(true);
    const n=new THREE_.Vector3(-def.side,0,0); // 朝河的方向
    const ws=SC.glbWindows(id);
    const front=[], side=[];
    for(const w of ws){
      const origin=w.pos.clone().addScaledVector(n,3);
      ray.set(origin,n.clone().negate()); ray.far=8;
      const hit=ray.intersectObject(g,true)[0];
      if(!hit){ SC.dropWindow(w.i); continue; }
      nm.getNormalMatrix(hit.object.matrixWorld);
      const wrld=hit.face.normal.clone().applyMatrix3(nm).normalize();
      if(Math.abs(wrld.y)>0.5){ SC.dropWindow(w.i); continue; }   // 屋顶斜面/檐口底面
      if(Math.abs(wrld.x)>=0.5) front.push({w,hit,depth:-def.side*hit.point.x}); // 正面墙：吸附
      else side.push({w,hit});                                   // 侧墙/窗洞侧壁：另行对准
    }
    const allFront=front.map(h=>h.depth);
    const globalMed=medOf(allFront);
    const rows={};
    for(const h of front){ (rows[h.w.anchor[1]]=rows[h.w.anchor[1]]||[]).push(h.depth); }
    const retained=[];
    for(const h of front){
      const row=rows[h.w.anchor[1]];
      const ref=(row&&row.length>=2)?medOf(row):globalMed;
      if(ref==null||Math.abs(h.depth-ref)>0.9){ SC.dropWindow(h.w.i); continue; }
      SC.setWindowPos(h.w.i,h.hit.point.clone().addScaledVector(n,0.04));
      retained.push(h);
    }
    const retainedRows={};
    for(const h of retained){ (retainedRows[h.w.anchor[1]]=retainedRows[h.w.anchor[1]]||[]).push(h.depth); }
    const retainedGlobal=medOf(retained.map(h=>h.depth));
    for(const s of side){
      const row=retainedRows[s.w.anchor[1]];
      const ref=(row&&row.length)?medOf(row):retainedGlobal;
      if(ref==null){ SC.dropWindow(s.w.i); continue; }
      const pos=s.w.pos.clone();
      pos.x=-def.side*ref;
      pos.addScaledVector(n,0.04);
      SC.setWindowPos(s.w.i,pos);
    }
    SC.disposeSlotGeometry(id); // 该变体全部地块已接管：释放并移除程序民居几何（失败变体不走到这里，保留回退）
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
  const low=(SC.S&&SC.S.quality==='low');
  for(const v of (SC.VARIANTS||['house_a','house_b','house_c'])){
    const e=sc[v]; if(!e||!e.file) continue;
    const file=(low&&e.low)?e.low:e.file;
    status[v]='loading';
    loader.load(file,gl=>{ placeHouses(v,prep(gl.scene)); status[v]='ok'; SC.shadowsDirty(); },undefined,()=>{ status[v]='failed'; });
  }
  if(sc.bridge&&sc.bridge.file){ status.bridge='loading'; loader.load(sc.bridge.file,gl=>{ placeBridge(prep(gl.scene),sc.bridge); status.bridge='ok'; SC.shadowsDirty(); },undefined,()=>{ status.bridge='failed'; }); }
  const nb=sc.noticeboard;
  if(nb&&nb.file&&JN.Board&&JN.Board.useModel){ status.noticeboard='loading'; loader.load(nb.file,gl=>{ JN.Board.useModel(gl.scene,nb.panel||[-0.258,0.254,0.335,0.687]); status.noticeboard='ok'; },undefined,()=>{ status.noticeboard='failed'; }); }
});
return {status};
})();

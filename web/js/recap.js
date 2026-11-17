/* 江南入夜 · 每日回顾卡
   1600x2000 竖版：上面是一张望全河的场景截图（离屏按 1 倍像素、高画质重渲一帧），下面是今天的数：
   总 token 和六个平台的条、在场专注 / AI 独航 / 成段、孔明灯盏数和功德、会话数和已办；楷体标题、金色细线、朱砂印「江南入夜」。
   生成后弹出预览，可下载 PNG。不用任何外部库。 */
window.JN = window.JN || {};
JN.Recap = (function(){
'use strict';
const SC=JN.Scene, D=JN.Data; if(!SC) return null;
const THREE=window.THREE;
const W=1600, H=2000, SW=1480, SH=Math.round(1480*9/16);
const K='"STKaiti","KaiTi","Kaiti SC",serif', SONG='"Songti SC","Noto Serif SC",serif';
const F=JN.Fleet, P=F?F.PLATFORMS:[], COLOR=F?F.PCOLOR:{}, NAME=F?F.PNAME:{};

/* 离屏重渲一帧望全河：临时把画布改成截图大小，渲完马上画到卡片上，再恢复 */
function snapshot(){
  const r=SC.renderer, cam=SC.camera;
  const v=SC.saveView(), pr=r.getPixelRatio(), aspect=cam.aspect;
  const far=SC.VIEWS.far;
  cam.position.set(...far.p); SC.controls.target.set(...far.t); cam.lookAt(SC.controls.target);
  r.setPixelRatio(1); r.setSize(SW,SH,false); SC.composer.setSize(SW,SH);
  cam.aspect=SW/SH; cam.updateProjectionMatrix();
  SC.composer.render();
  const shot=document.createElement('canvas'); shot.width=SW; shot.height=SH;
  shot.getContext('2d').drawImage(r.domElement,0,0,SW,SH);
  cam.aspect=aspect; r.setPixelRatio(pr); SC.restoreView(v); SC.onResize();
  return shot;
}
function wan(n){ n=Math.max(0,n||0); if(n<1e4) return n.toLocaleString('en-US'); return (n/1e4).toFixed(n<1e6?1:0).replace(/\.0$/,'')+' 万'; }
function hair(g,x1,y,x2,a){ g.strokeStyle=`rgba(217,164,65,${a||0.55})`; g.lineWidth=1.5; g.beginPath(); g.moveTo(x1,y); g.lineTo(x2,y); g.stroke(); }

function make(hide){
  const s=D.state; if(!s) return Promise.reject(new Error('no state'));
  const prevHide=F?F.hideProjects:false;
  const wantHide=hide===undefined?prevHide:!!hide;
  const cv=document.createElement('canvas'); cv.width=W; cv.height=H; const g=cv.getContext('2d');
  /* 底：墨色渐变 + 极淡的纸纹 */
  const bg=g.createLinearGradient(0,0,0,H); bg.addColorStop(0,'#0e1626'); bg.addColorStop(1,'#0a101b'); g.fillStyle=bg; g.fillRect(0,0,W,H);
  for(let i=0;i<2600;i++){ g.fillStyle=`rgba(236,225,200,${Math.random()*0.025})`; g.fillRect(Math.random()*W,Math.random()*H,Math.random()*3+1,1); }
  /* 场景（按「隐藏项目名」状态渲染船牌，拍完立即恢复现场设置） */
  if(F&&F.setHideProjects&&F.hideProjects!==wantHide) F.setHideProjects(wantHide);
  const shot=snapshot();
  if(F&&F.setHideProjects&&F.hideProjects!==prevHide) F.setHideProjects(prevHide);
  g.drawImage(shot,60,60);
  const fade=g.createLinearGradient(0,60+SH-180,0,60+SH); fade.addColorStop(0,'rgba(10,16,27,0)'); fade.addColorStop(1,'rgba(10,16,27,.75)'); g.fillStyle=fade; g.fillRect(60,60+SH-180,SW,180);
  g.strokeStyle='rgba(217,164,65,.7)'; g.lineWidth=2; g.strokeRect(60,60,SW,SH);
  g.strokeStyle='rgba(217,164,65,.3)'; g.lineWidth=1; g.strokeRect(48,48,SW+24,SH+24);
  /* 竖排题字和朱印，压在图的左上 */
  g.fillStyle='rgba(10,16,27,.35)'; g.fillRect(84,84,92,340);
  g.fillStyle='#f3e7cc'; g.font=`700 70px ${K}`; g.textAlign='center'; g.textBaseline='middle';
  ['江','南','入','夜'].forEach((c,i)=>g.fillText(c,130,130+i*80));
  /* 标题行 */
  const d=new Date(), date=`${d.getFullYear()} 年 ${d.getMonth()+1} 月 ${d.getDate()} 日`;
  const y0=60+SH+90;
  g.textAlign='left'; g.fillStyle='#f3e7cc'; g.font=`700 64px ${K}`; g.fillText('今 日 回 顾',80,y0);
  g.font=`500 30px ${SONG}`; g.fillStyle='rgba(217,164,65,.9)'; g.textAlign='right'; g.fillText(date,W-220,y0+4);
  /* 朱砂印 */
  const sx=W-180, sy=y0-58; g.fillStyle='#b8321c'; g.fillRect(sx,sy,112,112);
  g.strokeStyle='rgba(255,230,200,.5)'; g.lineWidth=2; g.strokeRect(sx+7,sy+7,98,98);
  g.fillStyle='#fff1df'; g.font=`700 42px ${K}`; g.textAlign='center'; g.fillText('江南',sx+56,sy+36); g.fillText('入夜',sx+56,sy+80);
  hair(g,80,y0+72,W-80,0.6);
  /* 总 token */
  const td=s.today, by=td.bySource||{}, total=td.tokens||0;
  g.textAlign='left'; g.fillStyle='rgba(236,225,200,.7)'; g.font=`500 30px ${SONG}`; g.fillText('今日 token',80,y0+130);
  g.fillStyle='#ffd987'; g.font=`700 96px ${K}`; g.fillText(wan(total),80,y0+210);
  /* 右边四个小数 */
  const lan=JN.Sky?JN.Sky.todayCount:0, merit=JN.Muyu&&JN.Muyu.enabled?JN.Muyu.count:0;
  const sess=P.reduce((a,k)=>a+((by[k]&&by[k].sessions)||0),0)||s.sessions.length, tools=P.reduce((a,k)=>a+((by[k]&&by[k].tools)||0),0);
  const facts=[['在场专注',Math.round(td.presentFocusMin||0)+' 分'],['AI 独航',Math.round(td.soloFocusMin||0)+' 分'],['成段',(td.segments||0)+' 段'],
    ['会话',sess+' 个'],['已办',tools.toLocaleString('en-US')+' 件'],merit?['功德',merit.toLocaleString('en-US')]:['孔明灯',lan.toLocaleString('en-US')+' 盏']];
  facts.forEach(([a,b],i)=>{ const cx=760+(i%3)*270, cy=y0+132+Math.floor(i/3)*92;
    g.textAlign='left'; g.fillStyle='rgba(236,225,200,.62)'; g.font=`500 26px ${SONG}`; g.fillText(a,cx,cy);
    g.fillStyle='#f3e7cc'; g.font=`700 44px ${K}`; g.fillText(b,cx,cy+44); });
  hair(g,80,y0+300,W-80,0.35);
  /* 六个平台 */
  const sum=P.reduce((a,k)=>a+((by[k]&&by[k].tokens)||0),0);
  const top=y0+350, rh=78;
  g.textAlign='left'; g.fillStyle='rgba(217,164,65,.9)'; g.font=`600 28px ${SONG}`; g.fillText('各 平 台',80,top-6);
  P.forEach((k,i)=>{
    const v=by[k]||{tokens:0}, y=top+50+i*rh, zero=!v.tokens, sh=sum?v.tokens/sum:0;
    g.globalAlpha=zero?0.4:1;
    g.fillStyle=COLOR[k]; g.beginPath(); g.moveTo(80,y-16); g.lineTo(132,y-15); g.lineTo(119,y); g.lineTo(132,y+15); g.lineTo(80,y+16); g.closePath(); g.fill();
    g.strokeStyle='rgba(236,225,200,.35)'; g.lineWidth=1; g.stroke();
    g.fillStyle='#ece1c8'; g.font=`600 34px ${SONG}`; g.fillText(NAME[k],160,y);
    const bx=420, bw=780;
    g.fillStyle='rgba(236,225,200,.08)'; g.fillRect(bx,y-6,bw,12);
    const bc=g.createLinearGradient(bx,0,bx+bw,0); bc.addColorStop(0,'#d9a441'); bc.addColorStop(1,'#e0492e');
    g.fillStyle=bc; g.fillRect(bx,y-6,Math.max(zero?0:4,bw*sh),12);
    g.textAlign='right'; g.fillStyle='#f3e7cc'; g.font=`700 38px ${K}`; g.fillText(zero?'—':wan(v.tokens),W-200,y+2);
    g.font=`500 26px ${SONG}`; g.fillStyle='rgba(217,164,65,.9)'; g.fillText((sh*100).toFixed(sh<0.1&&sh>0?1:0)+'%',W-80,y+2);
    g.textAlign='left'; g.globalAlpha=1;
  });
  /* 页脚 */
  hair(g,80,H-110,W-80,0.45);
  g.textAlign='center'; g.fillStyle='rgba(236,225,200,.55)'; g.font=`500 28px ${K}`; g.fillText('君到姑苏见 · 人家尽枕河',W/2,H-66);
  g.textAlign='center'; g.fillStyle='rgba(236,225,200,.52)'; g.font=`500 22px ${SONG}`; g.fillText('江南入夜 · github.com/ahang008/jiangnan-focus',W/2,H-28);
  /* 演示模式角标：避免把模拟数据误认成真实统计 */
  if(D.mode==='demo') drawDemoStamp(g,W,H);
  return Promise.resolve(cv.toDataURL('image/png'));
}

/* 演示模式印章：回顾卡和「留影」共用，画在画布右上角 */
function drawDemoStamp(g,w,h){
  g.save();
  g.translate(w-74,76); g.rotate(0.16);
  g.fillStyle='rgba(176,50,24,.92)'; g.fillRect(-98,-30,196,60);
  g.strokeStyle='rgba(255,220,180,.85)'; g.lineWidth=2; g.strokeRect(-98,-30,196,60);
  g.fillStyle='#fff2df'; g.textAlign='center'; g.textBaseline='middle';
  g.font=`700 26px ${K}`; g.fillText('演示数据',0,-8);
  g.font=`700 16px ${SONG}`; g.fillText('DEMO',0,20);
  g.restore();
}

/* 预览和下载 */
let busy=false;
function buildPreview(){
  const el=document.createElement('div'); el.id='recap';
  el.innerHTML='<div class="box"><img alt="今日回顾卡">'
    +'<div class="switchrow recapHideRow"><label>隐藏项目名</label><label class="sw"><input type="checkbox" id="recapHide"><i></i></label></div>'
    +'<div class="row"><button class="abtn red" data-a="dl">下载 PNG</button><button class="abtn" data-a="x">关闭</button></div></div>';
  document.body.appendChild(el);
  const cb=el.querySelector('#recapHide');
  cb.addEventListener('change',()=>{
    if(busy) return;
    const btn=el.querySelector('[data-a="dl"]');
    busy=true; if(btn) btn.disabled=true; cb.disabled=true;
    make(cb.checked).then(url=>{ el.querySelector('img').src=url; })
      .catch(()=>{}).then(()=>{ busy=false; if(btn) btn.disabled=false; cb.disabled=false; });
  });
  el.addEventListener('click',e=>{
    const a=e.target.dataset&&e.target.dataset.a;
    if(a==='x'||e.target===el) el.hidden=true;
    if(a==='dl'){ const l=document.createElement('a'); const d=new Date(); l.download=`江南入夜-今日回顾-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}.png`; l.href=el.querySelector('img').src; l.click(); }
  });
  return el;
}
function open(){
  return make(true).then(url=>{
    let el=document.getElementById('recap');
    if(!el) el=buildPreview();
    el.querySelector('#recapHide').checked=true;
    el.querySelector('img').src=url; el.hidden=false; return url;
  });
}
return {make,open,drawDemoStamp};
})();

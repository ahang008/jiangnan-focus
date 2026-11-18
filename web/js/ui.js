/* 江南入夜 · 界面层：专注进度环、今日统计、三选一、收藏册、设置、声音解锁提示、本地小程序离线提示 */
window.JN = window.JN || {};
JN.UI = (function(){
'use strict';
const $=id=>document.getElementById(id);
const D=JN.Data, A=JN.Audio;
const CAT_CLASS={'建筑':'','生灵':'c1','天气':'c2','声音':'c3'};
const LANTERN={id:'lantern',category:'灯火',name:'灯笼更亮一级',desc:'十四样都已收齐，沿河灯笼再亮一级',model:''};
let defs=[], defMap={}, state=null;
const REWARDS_ON=false; // 奖励系统暂不启用（不弹三选一、不显示待领和收藏），代码保留
let hidden=new Set(); try{ hidden=new Set(JSON.parse(localStorage.getItem('jnfocus.hidden')||'[]')); }catch(e){}
const HIDE_KEY='jnfocus.hideProjects';
function readHideProjects(){ try{ return localStorage.getItem(HIDE_KEY)==='1'; }catch(e){ return false; } }
function saveHideProjects(v){ try{ localStorage.setItem(HIDE_KEY, v?'1':'0'); }catch(e){} }
/* 零记录时的温和引导：按浏览器语言切中英文，附「看演示」按钮和「为什么没数字」链接 */
const REPO_URL='https://github.com/ahang008/jiangnan-focus';
const SRC_NAME={claude:'Claude',codex:'Codex',deepseek:'DeepSeek',grok:'Grok',magpie:'Magpie',cursor:'Cursor'};
const emptyHintText=String(navigator.language||'en').toLowerCase().startsWith('zh')
  ?'还没有检测到 AI 编程工具的记录，开始用 Claude Code、Codex 等工具干活，河上就会出现你的船。'
  :'No AI coding tool activity detected yet. Start working with Claude Code, Codex or similar tools, and your boats will appear on the river.';
const emptyHintHtml=String(navigator.language||'en').toLowerCase().startsWith('zh')
  ?`${emptyHintText}<br><a class="emptybtn" href="?demo=1">先看 60 秒演示</a> · <a class="emptylink" href="${REPO_URL}#常见问题" target="_blank" rel="noopener">为什么没数字</a>`
  :`${emptyHintText}<br><a class="emptybtn" href="?demo=1">Watch the 60-second demo</a> · <a class="emptylink" href="${REPO_URL}#FAQ" target="_blank" rel="noopener">Why no numbers?</a>`;
let offerOpen=false, offering=false, deferredAt=-1, choosing=false;
let soundTouchedAt=-1e9, settingsDirty=false;

function def(id){ return defMap[id]||(String(id).startsWith('lantern')?LANTERN:{id,category:'',name:id,desc:'',model:''}); }
function fmtTok(n){
  n=Math.max(0,n||0);
  if(n<1e4) return String(Math.round(n));
  if(n<1e8) return (n/1e4).toFixed(n<1e5?1:0).replace(/\.0$/,'')+'万';
  return (n/1e8).toFixed(2)+'亿';
}
function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.remove('show'); void t.offsetWidth; t.classList.add('show'); }

/* 首次提示文案按实际生效的 feedbackStyle 生成（演示模式 ?fb= 覆盖也一致） */
const TIP_TEXT={
  both:'孔明灯和木鱼都开着 · 右上角「设置」里可以换，还能生成今日回顾卡',
  lantern:'现在是放孔明灯 · 右上角「设置」里还能打开木鱼、生成今日回顾卡',
  muyu:'现在是敲木鱼 · 右上角「设置」里还能打开孔明灯、生成今日回顾卡'
};
function fbStyleOf(s){
  const FBS=['lantern','muyu','both'];
  const fix=new URLSearchParams(location.search).get('fb');
  if(D.mode==='demo'&&FBS.includes(fix)) return fix;
  return FBS.includes(s.settings.feedbackStyle)?s.settings.feedbackStyle:'both';
}
let tipShown=false;
function maybeShowFirstTip(){
  if(tipShown||!state) return;
  let show=false;
  try{ if(localStorage.getItem('jnfocus.tip1')!=='1'){ localStorage.setItem('jnfocus.tip1','1'); show=true; } }catch(e){}
  if(!show) return;
  tipShown=true;
  setTimeout(()=>{ const t=$('toast'); t.classList.add('long'); toast(TIP_TEXT[fbStyleOf(state)]||TIP_TEXT.both); setTimeout(()=>t.classList.remove('long'),9500); },4000);
}

/* ---------- 浮层开关（同一时间只开一个） ---------- */
const PANELS=['panel','settings','album'];
const BTN={panel:'panelBtn',settings:'setBtn',album:'albumBtn'};
function togglePanel(id,force){
  const open=force!==undefined?force:$(id).hidden;
  for(const p of PANELS){ const on=p===id&&open; $(p).hidden=!on; $(BTN[p]).classList.toggle('on',on); }
  if(id==='album'&&open) renderAlbum();
  if(id==='settings'&&open) fillSettings(true);
}

/* ---------- 声音 ---------- */
function applySound(vol,muted){
  A.setVolume(vol); A.setMuted(muted);
  $('cVol').value=Math.round(vol*100); $('vVol').textContent=Math.round(vol*100)+'%'; $('cMute').checked=!!muted;
  const btn=$('soundBtn'); const off=muted||vol<=0;
  btn.classList.toggle('off',off); btn.title=off?'开声音':'静音';
  btn.querySelectorAll('.wv').forEach(p=>p.style.display=off?'none':'');
  btn.querySelectorAll('.mute').forEach(p=>p.style.display=off?'':'none');
}
function saveSound(){
  soundTouchedAt=performance.now();
  D.saveSettings({volume:A.volume,muted:A.muted}).catch(()=>toast('音量只存在了本机，本地小程序没连上'));
}
/* 解锁要等 AudioContext 真的 running 才收起提示；失败就留着，下次点画面再试 */
function unlockAudio(){
  if(A.unlocked()){ $('hint').hidden=true; return; }
  A.unlock().then(ok=>{ if(ok) $('hint').hidden=true; });
}

/* ---------- 设置 ---------- */
function fillSettings(force){
  if(!state) return;
  if(settingsDirty&&!force) return;
  const s=state.settings;
  $('nActive').value=s.activeMin; $('nSegment').value=s.segmentMin; $('nGap').value=s.gapMin; $('nEnd').value=s.endMin;
  $('cPresent').checked=!!s.presentOnly;
  $('cHide').checked=readHideProjects();
  $('cUnit').value=String([500,1000,2000,5000].includes(s.lanternUnit)?s.lanternUnit:1000);
  $('fbUnit').textContent=$('cUnit').value;
  $('cFb').value=['lantern','muyu','both'].includes(s.feedbackStyle)?s.feedbackStyle:'both';

  settingsDirty=false;
}
function saveRules(){
  const num=(id,lo,hi,dv)=>{ const v=Math.round(+$(id).value); return isFinite(v)&&v>=lo&&v<=hi?v:dv; };
  const s=state?state.settings:D.DEFAULT_SETTINGS;
  const next={activeMin:num('nActive',1,30,s.activeMin),segmentMin:num('nSegment',5,120,s.segmentMin),gapMin:num('nGap',1,60,s.gapMin),
    endMin:num('nEnd',2,120,s.endMin),presentOnly:$('cPresent').checked};
  $('saveNote').textContent='正在存…';
  D.saveSettings(next).then(()=>{ settingsDirty=false; $('saveNote').textContent=D.mode==='demo'?'已存在本浏览器（演示模式）':'已存进本地小程序'; fillSettings(true); })
    .catch(()=>{ $('saveNote').textContent='没存上：本地小程序没开'; });
}

/* ---------- 三选一 ---------- */
/* 每次请求一个代次；响应回来时再核一遍资格（还有待领、自动弹的还要人在场、请求没被作废） */
let offerGen=0, offerAuto=false, offerSince=-1e9;
function openOffer(auto){
  if(offerOpen||offering) return;
  offering=true;
  const my=++offerGen;
  D.offer().then(ids=>{
    if(my!==offerGen) return;
    offering=false;
    const s=state;
    if(!s||s.pendingRewards<=0) return;
    if(auto&&!s.present) return;
    if(!ids||!ids.length){ if(!auto) toast('暂时没有可选的奖励'); return; }
    renderOffer(ids); offerOpen=true; offerAuto=!!auto; offerSince=performance.now(); $('offer').style.opacity='0'; $('offer').hidden=false; $('pendSeal').hidden=true;
    const first=$('offerCards').querySelector('.card'); if(first) first.focus({preventScroll:true});
  }).catch(()=>{ if(my!==offerGen) return; offering=false; if(!auto) toast('取奖励没成功，稍后点「待领」再试'); });
}
function cancelOffer(){ offerGen++; offering=false; }
function renderOffer(ids){
  const box=$('offerCards'); box.innerHTML=''; box.classList.remove('busy');
  const n=state?state.pendingRewards:1;
  $('offerTitle').textContent=n>1?`一段专注已成 · 还有 ${n} 份`:'一段专注已成';
  $('offerMsg').textContent='';
  for(const id of ids){
    const d=def(id);
    const b=document.createElement('button'); b.className='card'; b.type='button';
    b.innerHTML=`<span class="cat ${CAT_CLASS[d.category]||''}"></span><b></b><p></p><span class="pick">择此</span>`;
    b.querySelector('.cat').textContent=d.category||'奖励'; b.querySelector('b').textContent=d.name; b.querySelector('p').textContent=d.desc;
    b.addEventListener('click',()=>choose(id));
    box.appendChild(b);
  }
}
function closeOffer(){ offerOpen=false; $('offer').hidden=true; }
function choose(id){
  if(choosing) return; choosing=true;
  $('offerCards').classList.add('busy'); $('offerMsg').textContent='落笔中…';
  D.choose(id).then(()=>{
    choosing=false; closeOffer();
    const d=def(id);
    toast(`${d.name} · 已入水乡`);
    deferredAt=-1;
  }).catch(()=>{ choosing=false; $('offerCards').classList.remove('busy'); $('offerMsg').textContent='没选上：本地小程序没开，稍后再试'; });
}

/* ---------- 收藏册 ---------- */
function renderAlbum(){
  const owned=new Set(state?state.owned:[]);
  const body=$('albumBody'); body.innerHTML='';
  const wrap=document.createElement('div'); wrap.className='album'; body.appendChild(wrap);
  let have=0;
  for(const cat of ['建筑','生灵','天气','声音']){
    const g=document.createElement('div'); g.className='gt2'; g.textContent=cat; wrap.appendChild(g);
    for(const d of defs.filter(x=>x.category===cat)){
      const has=owned.has(d.id); if(has) have++;
      const it=document.createElement('div'); it.className='item'+(has?'':' no');
      it.innerHTML='<b></b><p></p><div class="acts"></div>';
      it.querySelector('b').textContent=d.name;
      it.querySelector('p').textContent=has?d.desc:'尚未得';
      const acts=it.querySelector('.acts');
      if(has){
        if(JN.Rewards&&JN.Rewards.viewFor(d.id)){
          const v=document.createElement('button'); v.textContent='看看';
          v.addEventListener('click',()=>{ JN.Scene.setView(d.id); if(innerWidth<760) togglePanel('album',false); });
          acts.appendChild(v);
        }
        if(cat!=='建筑'){
          const t=document.createElement('button'); const off=hidden.has(d.id);
          t.textContent=off?(cat==='声音'?'已关':'已收'):(cat==='声音'?'开着':'显着'); if(off) t.classList.add('off');
          t.title=cat==='声音'?'开关这个声音':'暂时收起 / 放出';
          t.addEventListener('click',()=>{ if(hidden.has(d.id)) hidden.delete(d.id); else { hidden.add(d.id); } saveHidden(); JN.Rewards.apply(state.owned,[...hidden]); if(cat==='声音'&&!hidden.has(d.id)) A.preview(d.id); renderAlbum(); });
          acts.appendChild(t);
        }
      }
      wrap.appendChild(it);
    }
  }
  const lamps=state?Math.max(state.lanternLevel|0,state.owned.filter(x=>String(x).startsWith('lantern')).length):0;
  if(lamps){ const l=document.createElement('div'); l.className='lamp'; l.textContent=`沿河灯笼已加亮 ${lamps} 级`; wrap.appendChild(l); }
  $('albumCount').textContent=`${have} / ${defs.length}`;
}
function saveHidden(){ try{ localStorage.setItem('jnfocus.hidden',JSON.stringify([...hidden])); }catch(e){} }

/* ---------- state ---------- */
let firstState=true, lastPending=0;
function onState(s){
  state=s;
  /* 进度环 */
  const seg=s.segment, tgt=Math.max(1,seg.targetMin||25), prog=Math.max(0,Math.min(tgt,seg.progressMin||0));
  $('ringFg').style.strokeDashoffset=(213.6*(1-prog/tgt)).toFixed(1);
  $('fLeft').textContent=Math.max(0,Math.ceil(tgt-prog-1e-6));
  const active=s.sessions.filter(x=>x.active).length;
  let st;
  if(s.settings.presentOnly&&!s.present) st='你不在 · 暂不累计';
  else if(active>0) st='专注中';
  else if(prog>0&&seg.idleMin>0) st=`停顿 ${Math.ceil(seg.idleMin)} 分 · 满 ${s.settings.gapMin} 分就断`;
  else st='静候';
  $('fState').textContent=st;
  $('sPresent').textContent=Math.round(s.today.presentFocusMin||0);
  $('sSolo').textContent=Math.round(s.today.soloFocusMin||0);
  $('sSeg').textContent=s.today.segments||0;
  $('sActive').textContent=active;
  $('rbTok').textContent=`今日 ${fmtTok(s.today.tokens)} token`;
  /* 没有任何会话和 token：给一句不挡画面的温和引导（演示模式不显示） */
  const eh=$('emptyHint');
  if(eh){ eh.innerHTML=emptyHintHtml; eh.hidden=!(D.mode!=='demo'&&s.today.tokens<=0&&!s.sessions.length); }
  /* 页面日志缺失提示：非阻断，写明哪个来源今天的日志暂时读不到 */
  const lh=$('logHint');
  if(lh){
    const missing=(s.today.logsMissingSources||[]).filter(Boolean);
    if(D.mode!=='demo'&&s.today.logsMissing&&missing.length){
      lh.textContent='今天的日志暂时读不到：'+(missing.map(x=>SRC_NAME[x]||x).join('、'))+'，水牌来自上次保存的快照';
      lh.hidden=false;
    }else lh.hidden=true;
  }
  /* 孔明灯进度 */
  if(JN.Sky){ const pr=JN.Sky.progress(); $('skyFill').style.width=(pr.frac*100).toFixed(1)+'%'; $('skyText').textContent=pr.text; }
  /* 待领 */
  const p=REWARDS_ON?(s.pendingRewards||0):0;
  $('pendN').textContent=p>1?('x'+p):'';
  if(p>0&&s.present&&!offerOpen&&!offering&&(deferredAt<0||p>deferredAt)) openOffer(true);
  if(p===0){ if(offering) cancelOffer(); if(offerOpen&&!choosing) closeOffer(); }
  /* 自动弹出的三选一：人离开了就收起，待领留着，回来再弹 */
  if(!s.present){ if(offering) cancelOffer(); if(offerOpen&&offerAuto&&!choosing){ closeOffer(); } }
  $('pendSeal').hidden=!(p>0&&!offerOpen);
  lastPending=p;
  /* 设置与声音：本机刚动过就不被 state 覆盖 */
  /* 本机有还没同步上去的声音改动时，以本机为准，等服务端确认后再跟 state */
  if(performance.now()-soundTouchedAt>4000&&!D.soundPending()){
    const vol=typeof s.settings.volume==='number'?s.settings.volume:0.3;
    applySound(vol,!!s.settings.muted);
  }
  if(!$('settings').hidden) fillSettings(false); else fillSettings(true);
  if(REWARDS_ON&&!$('album').hidden) renderAlbum();
  firstState=false;
  maybeShowFirstTip();
}
function onStatus(st){ $('offline').hidden=D.mode==='demo'||!!st.connected; if(D.mode!=='demo'&&!st.connected) $('fState').textContent='等本地小程序'; }
function onSegmentDone(){
  const r=$('ringBtn'); r.classList.add('glow');
  r.addEventListener('animationend',()=>{},{once:true});
  segGlowUntil=performance.now()+2600;
}
let segGlowUntil=0;
function tick(now){
  if(segGlowUntil&&now>segGlowUntil){ segGlowUntil=0; $('ringBtn').classList.remove('glow'); }
  if(offerOpen){ const k=Math.min(1,Math.max(0,(now-offerSince)/450)); const el=$('offer'); const v=String(Math.round(k*100)/100); if(el.style.opacity!==v) el.style.opacity=v; }
}

function init(list){
  defs=list||[]; defMap={}; for(const d of defs) defMap[d.id]=d;
  if(state){ onState(state); }
  JN.Rewards&&JN.Rewards.apply(state?state.owned:[],[...hidden]);
}

/* ---------- 绑定 ---------- */
(function wire(){
  $('panelBtn').addEventListener('click',()=>togglePanel('panel'));
  $('setBtn').addEventListener('click',()=>togglePanel('settings'));
  $('albumBtn').addEventListener('click',()=>togglePanel('album'));
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>togglePanel(b.dataset.close,false)));
  $('vToggle').addEventListener('click',()=>$('views').classList.toggle('collapsed'));
  $('soundBtn').addEventListener('click',()=>{ unlockAudio(); const off=A.muted||A.volume<=0; applySound(A.volume<=0?0.3:A.volume,!off); saveSound(); });
  $('cVol').addEventListener('input',e=>{ unlockAudio(); applySound((+e.target.value)/100,A.muted); soundTouchedAt=performance.now(); });
  $('cVol').addEventListener('change',saveSound);
  $('cMute').addEventListener('change',e=>{ unlockAudio(); applySound(A.volume,e.target.checked); saveSound(); });
  ['nActive','nSegment','nGap','nEnd'].forEach(id=>$(id).addEventListener('input',()=>{ settingsDirty=true; $('saveNote').textContent=''; }));
  $('cPresent').addEventListener('change',()=>{ settingsDirty=true; $('saveNote').textContent=''; });
  $('bSaveRules').addEventListener('click',saveRules);
  /* 第一次打开：提示一次新玩法在哪（只提示一次；文案等拿到第一次 state 后按实际设置生成） */
  $('bRecap').addEventListener('click',()=>{ if(!JN.Recap) return; $('bRecap').disabled=true; JN.Recap.open().catch(()=>toast('回顾卡没生成出来')).then(()=>{ $('bRecap').disabled=false; }); });
  $('cFb').addEventListener('change',e=>{ const v=e.target.value; D.saveSettings({feedbackStyle:v}).then(()=>toast(v==='muyu'?'改为敲木鱼':v==='both'?'孔明灯和木鱼两样都要':'改为放孔明灯'),()=>toast('没存上：本地小程序没开')); });
  $('cHide').addEventListener('change',e=>{ const v=e.target.checked; saveHideProjects(v); if(JN.Fleet&&JN.Fleet.setHideProjects) JN.Fleet.setHideProjects(v); });
  $('cUnit').addEventListener('change',e=>{ const v=+e.target.value; D.saveSettings({lanternUnit:v}).then(()=>toast(`改为每 ${v} token 放一盏`),()=>toast('没存上：本地小程序没开')); });
  $('offerLater').addEventListener('click',()=>{ deferredAt=state?state.pendingRewards:1; closeOffer(); if(state) $('pendSeal').hidden=!(state.pendingRewards>0); });
  $('pendSeal').addEventListener('click',()=>{ deferredAt=-1; openOffer(false); });
  $('ringBtn').addEventListener('click',()=>{ if(REWARDS_ON&&state&&state.pendingRewards>0){ deferredAt=-1; openOffer(false); } else togglePanel('settings'); });
  /* 专注归零：先点一下出确认，再点「确定归零」才执行 */
  const showConfirm=on=>{ $('resetRow').hidden=on; $('resetConfirm').hidden=!on; };
  $('bReset0').addEventListener('click',()=>{ showConfirm(true); $('resetNote').textContent=''; });
  $('bResetNo').addEventListener('click',()=>showConfirm(false));
  $('bResetYes').addEventListener('click',()=>{
    $('bResetYes').disabled=true; $('resetNote').textContent='正在归零…';
    D.resetFocus().then(()=>{ $('resetNote').textContent='已归零，今天的专注从现在重新算'; toast('专注已归零'); },
      ()=>{ $('resetNote').textContent='没归零：本地小程序没开'; })
      .then(()=>{ $('bResetYes').disabled=false; showConfirm(false); });
  });
  addEventListener('keydown',e=>{ if(e.key==='Escape'){ if(offerOpen) $('offerLater').click(); else PANELS.forEach(p=>togglePanel(p,false)); } });
  /* 第一次打开声音还没解锁 */
  $('hint').hidden=false;
  addEventListener('pointerdown',unlockAudio);
  addEventListener('keydown',unlockAudio);
  const ls=D.localSound(); applySound(ls?ls.volume:0.3, ls?ls.muted:false);
  /* 分享匿名：一开始就把「隐藏项目名」的本机状态同步给船队 */
  if(JN.Fleet&&JN.Fleet.setHideProjects) JN.Fleet.setHideProjects(readHideProjects());
  /* 演示模式：右上角常驻一枚印章 */
  $('demoSeal').hidden=D.mode!=='demo';
})();

return {init,onState,onStatus,onSegmentDone,tick,toast,openOffer,hidden:()=>[...hidden],modalOpen:()=>offerOpen,modalSince:()=>offerSince,renderAlbum};
})();

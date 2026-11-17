/* 江南入夜 · 木鱼（第二种反馈）：今日 token 每满一个单位（和孔明灯同一个单位，默认 1000）敲一下，「功德 +1」
   - 画面左下、机位按钮上方，一只 SVG 手绘木鱼：朱漆木胎、刻鳞、鱼口，暖色轮廓光和细金边，下面垫一方织锦小垫带流苏，木槌圆头
   - 敲击：木槌约 0.11 秒落下再抬起，木鱼压扁约 4% 回弹，一圈细金色涟漪散开，几点暖色火星；「功德 +1」金色楷体上浮约 70 像素、1.2 秒淡出
   - 连击（和孔明灯同一套队列）：约 0.14 秒一下笃笃笃，浮字合并成「功德 +6」；积压太多一次并成「功德 +55」
   - 计数「今日功德 14,750」按位滚动
   - 每满 100 万 token：正中「今日功德 一千」（整千用汉字），背后一朵淡金莲花光，一声磬
   - 首次打开最多补敲 8 下，提示一次「今日已积功德 N」
   全部按 rAF 场景时间驱动，不用 CSS 动画和 setTimeout */
window.JN = window.JN || {};
JN.Muyu = (function(){
'use strict';
const SVGNS='http://www.w3.org/2000/svg';
const KEY='jnfocus.muyu', MILE=1e6, WELCOME=8, MAXQ=12, VOLLEY=8;

/* ---------- 画 ---------- */
function scales(){
  let d='';
  for(let r=0;r<4;r++){ const y=52+r*11, off=(r%2)*7;
    for(let x=34+off;x<162;x+=14) d+=`M${x-7} ${y}a7 7 0 0 0 14 0`; }
  return d;
}
const SVG=`
<svg viewBox="0 0 220 176" xmlns="${SVGNS}" aria-hidden="true">
 <defs>
  <radialGradient id="myLac" cx="38%" cy="32%" r="78%">
   <stop offset="0" stop-color="#b4542c"/><stop offset=".35" stop-color="#8a2f17"/><stop offset=".75" stop-color="#5a1a0c"/><stop offset="1" stop-color="#2e0b05"/>
  </radialGradient>
  <linearGradient id="myRim" x1="0" y1="0" x2="1" y2="1">
   <stop offset="0" stop-color="#ffc88a" stop-opacity=".95"/><stop offset=".45" stop-color="#ff9a52" stop-opacity=".35"/><stop offset="1" stop-color="#ff8a40" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="myCush" x1="0" y1="0" x2="0" y2="1">
   <stop offset="0" stop-color="#d0472a"/><stop offset=".55" stop-color="#a62f17"/><stop offset="1" stop-color="#6e1a0b"/>
  </linearGradient>
  <pattern id="myBro" width="12" height="12" patternUnits="userSpaceOnUse">
   <path d="M6 1 L11 6 L6 11 L1 6 Z" fill="none" stroke="#e6b45a" stroke-opacity=".38" stroke-width=".8"/>
   <circle cx="6" cy="6" r="1" fill="#f0c56a" fill-opacity=".45"/>
  </pattern>
  <linearGradient id="myWood" x1="0" y1="0" x2="1" y2="0">
   <stop offset="0" stop-color="#3a2212"/><stop offset=".5" stop-color="#7a5232"/><stop offset="1" stop-color="#3a2212"/>
  </linearGradient>
  <radialGradient id="myHead" cx="35%" cy="30%" r="75%">
   <stop offset="0" stop-color="#c79a62"/><stop offset=".55" stop-color="#7b5130"/><stop offset="1" stop-color="#3b2312"/>
  </radialGradient>
  <clipPath id="myClip"><ellipse cx="98" cy="90" rx="66" ry="52"/></clipPath>
  <filter id="myGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter>
  <radialGradient id="myPulse" cx="50%" cy="50%" r="50%">
   <stop offset="0" stop-color="#ffd27a" stop-opacity=".9"/><stop offset=".55" stop-color="#ffb24e" stop-opacity=".35"/><stop offset="1" stop-color="#ff9a3a" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="mySpec" cx="50%" cy="50%" r="50%">
   <stop offset="0" stop-color="#fff3dc" stop-opacity=".55"/><stop offset="1" stop-color="#fff3dc" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="myHandle" x1="0" y1="0" x2="0" y2="1">
   <stop offset="0" stop-color="#9a6a3e"/><stop offset=".5" stop-color="#6b4325"/><stop offset="1" stop-color="#3f2614"/>
  </linearGradient>
 </defs>
 <!-- 敲击时的一圈暖金光 -->
 <ellipse class="pulse" cx="98" cy="92" rx="96" ry="78" fill="url(#myPulse)" opacity="0"/>
 <ellipse cx="100" cy="160" rx="84" ry="9" fill="#000" fill-opacity=".28"/>
 <!-- 织锦垫 -->
 <g class="cushion">
  <path d="M26 138 Q100 124 174 138 L170 156 Q100 166 30 156 Z" fill="url(#myCush)"/>
  <path d="M26 138 Q100 124 174 138 L170 156 Q100 166 30 156 Z" fill="url(#myBro)"/>
  <path d="M30 156 Q100 166 170 156 L168 160 Q100 171 32 160 Z" fill="#5a1508"/>
  <path d="M60 131 Q64 145 58 157 M140 131 Q136 145 142 157" fill="none" stroke="#5a1508" stroke-opacity=".35" stroke-width="2"/>
  <path d="M32 141 Q100 129 168 141" fill="none" stroke="#e8b85c" stroke-width="1" stroke-opacity=".8"/>
  <path d="M34 152 Q100 161 166 152" fill="none" stroke="#e8b85c" stroke-width=".8" stroke-opacity=".55"/>
  <g stroke="#e0ac52" stroke-width="1.2" fill="#e0ac52">
   <line x1="28" y1="150" x2="22" y2="166"/><circle cx="22" cy="167" r="2.4"/><line x1="22" y1="169" x2="20" y2="175" stroke-opacity=".7"/><line x1="22" y1="169" x2="24" y2="175" stroke-opacity=".7"/>
   <line x1="172" y1="150" x2="178" y2="166"/><circle cx="178" cy="167" r="2.4"/><line x1="178" y1="169" x2="176" y2="175" stroke-opacity=".7"/><line x1="178" y1="169" x2="180" y2="175" stroke-opacity=".7"/>
  </g>
 </g>
 <!-- 木鱼 -->
 <g class="fish">
  <ellipse cx="98" cy="90" rx="66" ry="52" fill="url(#myLac)"/>
  <g clip-path="url(#myClip)">
   <path d="${scales()}" fill="none" stroke="#2a0904" stroke-opacity=".55" stroke-width="1.4"/>
   <path d="${scales()}" fill="none" stroke="#ffb27a" stroke-opacity=".16" stroke-width=".8" transform="translate(0 1.2)"/>
   <ellipse cx="98" cy="146" rx="80" ry="22" fill="#1a0602" fill-opacity=".35"/>
  </g>
  <!-- 鱼口：横贯前脸的一道开口，两端收成圆孔（真木鱼的共鸣口） -->
  <path d="M40 106 C64 101 132 101 156 106 C132 115 64 115 40 106 Z" fill="#0e0301"/>
  <path d="M44 107 C68 103 128 103 152 107" fill="none" stroke="#3a1006" stroke-width="1"/>
  <path d="M46 112 C70 118 126 118 150 112" fill="none" stroke="#d27a44" stroke-opacity=".5" stroke-width="1.2"/>
  <circle cx="40" cy="106" r="5.6" fill="#0e0301"/><circle cx="156" cy="106" r="5.6" fill="#0e0301"/>
  <circle cx="40" cy="106" r="5.6" fill="none" stroke="#c9733e" stroke-opacity=".35" stroke-width=".8"/><circle cx="156" cy="106" r="5.6" fill="none" stroke="#c9733e" stroke-opacity=".35" stroke-width=".8"/>
  <!-- 两侧刻的卷云纹 -->
  <g fill="none" stroke="#2a0904" stroke-opacity=".6" stroke-width="1.3" stroke-linecap="round">
   <path d="M44 86 c2-8 12-9 14-2 c1 5-6 7-8 3"/><path d="M152 86 c-2-8-12-9-14-2 c-1 5 6 7 8 3"/>
  </g>
  <g fill="none" stroke="#ffb27a" stroke-opacity=".18" stroke-width=".8" stroke-linecap="round" transform="translate(0 1)">
   <path d="M44 86 c2-8 12-9 14-2 c1 5-6 7-8 3"/><path d="M152 86 c-2-8-12-9-14-2 c-1 5 6 7 8 3"/>
  </g>
  <!-- 轮廓光和金边 -->
  <path d="M44 66 A66 52 0 0 1 120 39" fill="none" stroke="url(#myRim)" stroke-width="5" stroke-linecap="round" filter="url(#myGlow)"/>
  <path d="M46 66 A66 52 0 0 1 118 40" fill="none" stroke="#ffd7a0" stroke-opacity=".75" stroke-width="1.4" stroke-linecap="round"/>
  <ellipse cx="98" cy="90" rx="66" ry="52" fill="none" stroke="#d9a441" stroke-opacity=".7" stroke-width="1.1"/>
  <ellipse cx="78" cy="60" rx="20" ry="9" fill="url(#mySpec)" transform="rotate(-20 78 60)"/>
  <ellipse cx="72" cy="57" rx="6" ry="2.4" fill="#fffaf0" fill-opacity=".55" transform="rotate(-20 72 57)"/>
  <!-- 底部细金线，坐在垫上的接缝 -->
  <path d="M50 128 Q98 146 146 128" fill="none" stroke="#e2b25a" stroke-opacity=".45" stroke-width="1"/>
 </g>
 <!-- 涟漪和火星 -->
 <g class="fx"></g>
 <!-- 木槌：绕右上角的握柄端转 -->
 <g class="mallet">
  <path d="M208 -2 L211 3 L151 37 L146 29 Z" fill="url(#myHandle)"/>
  <path d="M200 6 L160 28 M196 3 L168 19" stroke="#2f1b0d" stroke-opacity=".35" stroke-width=".6"/>
  <path d="M207 -1 L149 30" stroke="#c39060" stroke-opacity=".55" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M209 1 l7 8 m-7 -8 l3 11" stroke="#c0331a" stroke-width="1.6" stroke-linecap="round"/>
  <circle cx="216" cy="10" r="2" fill="#d9a441"/>
  <circle cx="139" cy="33" r="15" fill="url(#myHead)"/>
  <circle cx="139" cy="33" r="15" fill="none" stroke="#d9a441" stroke-opacity=".6" stroke-width="1"/>
  <path d="M127 28 a13 13 0 0 1 14 -9" fill="none" stroke="#ffe8c4" stroke-opacity=".55" stroke-width="2" stroke-linecap="round"/>
 </g>
</svg>`;

const root=document.createElement('div'); root.id='muyu'; root.hidden=true;
root.innerHTML=`<div class="mfloat"></div>${SVG}<div class="mcount"><span class="ml">今日功德</span><span class="mnum"></span></div>`;
document.body.appendChild(root);
const svg=root.querySelector('svg'), pulse=svg.querySelector('.pulse'), fish=svg.querySelector('.fish'), mallet=svg.querySelector('.mallet'), fx=svg.querySelector('.fx');
const floatEl=root.querySelector('.mfloat'), numEl=root.querySelector('.mnum');
const PIVOT='206 0', REST=26; // 正角度在 SVG 里是顺时针：槌头抬起
/* 涟漪 4 个、火星 16 个，一次建好反复用 */
const rings=[], sparks=[];
for(let i=0;i<4;i++){ const c=document.createElementNS(SVGNS,'circle'); c.setAttribute('cx',137); c.setAttribute('cy',47); c.setAttribute('fill','none'); c.setAttribute('stroke','#f3cf7e'); c.setAttribute('opacity','0'); fx.appendChild(c); rings.push({c,t:9}); }
for(let i=0;i<16;i++){ const c=document.createElementNS(SVGNS,'circle'); c.setAttribute('r','2.1'); c.setAttribute('fill','#ffd58a'); c.setAttribute('opacity','0'); fx.appendChild(c); sparks.push({c,t:9,dx:0,dy:0}); }

/* ---------- 计数：按位滚动 ---------- */
let shown=0, target=0;
const cols=[];
function setDigits(v){
  const str=Math.floor(v).toLocaleString("en-US");
  if(numEl.dataset.len!==String(str.length)){
    numEl.innerHTML=''; cols.length=0; numEl.dataset.len=String(str.length);
    for(const ch of str){
      if(ch===','){ const s=document.createElement('span'); s.className='sep'; s.textContent=','; numEl.appendChild(s); cols.push(null); continue; }
      const w=document.createElement('span'); w.className='dg'; const strip=document.createElement('span'); strip.className='strip';
      strip.textContent='0123456789'.split('').join('\n'); w.appendChild(strip); numEl.appendChild(w); cols.push({strip,pos:+ch});
    }
  }
}
function renderDigits(v){
  setDigits(v);
  const str=Math.floor(v).toLocaleString('en-US');
  const frac=v-Math.floor(v);
  let k=0;
  for(let i=str.length-1;i>=0;i--){
    const col=cols[i]; if(!col) continue;
    const d=+str[i];
    /* 个位连续滚，高位在下一位快到 9 时跟着进位 */
    let pos=d;
    if(k===0) pos=d+frac;
    else { const lower=Math.floor(v/Math.pow(10,k-1))%10; if(lower===9) pos=d+frac; }
    col.strip.style.transform=`translateY(${(-pos*10).toFixed(2)}%)`;
    k++;
  }
}

/* ---------- 声音、正中字 ---------- */
function cn(n){
  const D=['零','一','两','三','四','五','六','七','八','九'];
  if(n>0&&n%10000===0&&n<=90000) return D[n/10000]+'万';
  if(n>0&&n%1000===0&&n<10000) return D[n/1000]+'千';
  return n.toLocaleString('en-US');
}
let say=null;
function center(text){
  const el=document.getElementById('milestone'); if(!el) return;
  el.classList.add('lotus'); JN.Sky&&JN.Sky.say(text); say={t:0,el}; // 淡入淡出交给孔明灯模块那一套
}

/* ---------- 状态 ---------- */
const today=()=>{ const d=new Date(); return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); };
let rec=null, first=true, enabled=false, unit=1000;
const queue=[]; let pendingPlus=0, nextAt=0, volley=0;
let strikeT=9, cur=null; // cur: 当前浮字 {n,t}
function load(){ try{ const r=JSON.parse(localStorage.getItem(KEY)||'null'); if(r&&r.date===today()&&Number.isInteger(r.idx)) return r; }catch(e){} return null; }
function save(){ try{ localStorage.setItem(KEY,JSON.stringify(rec)); }catch(e){} }
function setEnabled(on){ enabled=!!on; root.hidden=!enabled; if(!enabled){ queue.length=0; pendingPlus=0; } }
function onTokens(tokens,demo,u){
  tokens=Math.max(0,tokens||0); unit=[500,1000,2000,5000].includes(u)?u:1000;
  const idx=Math.floor(tokens/unit), mile=Math.floor(tokens/MILE);
  target=idx;
  if(!rec||rec.date!==today()){ rec=(!demo&&load())||{date:today(),idx:0,unit,mile}; }
  if(rec.unit!==unit){ rec.unit=unit; rec.idx=idx; rec.mile=mile; shown=idx; save(); return; }
  if(first){
    first=false; shown=Math.max(0,idx-Math.min(WELCOME,Math.max(0,idx-rec.idx)));
    if(enabled&&!demo&&idx>0){
      const n=Math.min(WELCOME,Math.max(0,idx-rec.idx));
      for(let k=0;k<n;k++) queue.push({});
      center(`今日已积功德 ${idx.toLocaleString('en-US')}`);
    }
    if(demo) shown=idx;
    rec.idx=idx; rec.mile=mile; save(); return;
  }
  if(idx<rec.idx){ rec.idx=idx; rec.mile=mile; shown=idx; save(); return; }
  const add=idx-rec.idx; let changed=false;
  if(add>0){ rec.idx=idx; changed=true; if(enabled) for(let k=0;k<add;k++) queue.push({}); else shown=idx; }
  if(mile>rec.mile){ if(enabled) queue.unshift({mile}); rec.mile=mile; changed=true; } // 百万节点先响磬、先出字，连击跟在后面
  if(changed) save();
  if(queue.length>MAXQ){
    const keep=queue.filter(q=>q.mile).slice(-1), small=queue.filter(q=>!q.mile);
    pendingPlus+=small.length-VOLLEY;
    queue.length=0; queue.push(...keep); for(let k=0;k<VOLLEY;k++) queue.push({});
  }
}
function strike(){
  strikeT=0;
  const r=rings.find(x=>x.t>0.7)||rings[0]; r.t=0;
  let made=0; for(const s of sparks){ if(s.t>0.5&&made<5){ s.t=0; const a=-Math.PI*(0.15+Math.random()*0.7); const sp=14+Math.random()*16; s.dx=Math.cos(a)*sp; s.dy=Math.sin(a)*sp; made++; } }
  JN.Audio&&JN.Audio.woodfish&&JN.Audio.woodfish();
}
function bump(n){
  if(cur&&cur.t<0.75){ cur.n+=n; cur.t=Math.min(cur.t,0.12); }
  else cur={n,t:0};
  floatEl.textContent=`功德 +${cur.n}`;
}

/* ---------- 每帧 ---------- */
function update(dt,t){
  if(!enabled){ if(say){ say.t+=dt; } return; }
  if(queue.length&&t>=nextAt){
    const q=queue.shift();
    if(q.mile){ center(`今日功德 ${cn(q.mile*MILE/unit)}`); JN.Audio&&JN.Audio.qing&&JN.Audio.qing(); nextAt=t+0.3; }
    else{
      strike();
      let n=1; if(pendingPlus>0&&volley===0){ n+=pendingPlus; pendingPlus=0; }
      bump(n); shown=Math.min(target,shown+0); // 计数靠下面缓动追上
      volley++;
      if(queue.length&&volley<VOLLEY) nextAt=t+0.14;
      else { volley=0; nextAt=t+(queue.length?0.6:0.2); }
    }
  }
  /* 木槌：0.06 秒落下，0.2 秒抬回 */
  strikeT+=dt;
  let ang=REST;
  if(strikeT<0.06){ const k=strikeT/0.06; ang=REST*(1-k*k); }
  else if(strikeT<0.26){ const k=(strikeT-0.06)/0.2; ang=REST*(1-Math.pow(1-k,2)); }
  mallet.setAttribute('transform',`rotate(${ang.toFixed(2)} ${PIVOT})`);
  /* 敲击时一圈暖金光，0.5 秒内收掉 */
  pulse.setAttribute('opacity',(strikeT<0.5?0.55*Math.pow(1-strikeT/0.5,1.6):0).toFixed(3));
  /* 木鱼压扁回弹 */
  let sq=0; if(strikeT>=0.05&&strikeT<0.45){ const k=(strikeT-0.05)/0.4; sq=0.04*Math.exp(-k*5)*Math.cos(k*9); }
  fish.setAttribute('transform',`translate(98 142) scale(${(1+sq*0.6).toFixed(4)} ${(1-sq).toFixed(4)}) translate(-98 -142)`);
  for(const r of rings){
    r.t+=dt; const k=Math.min(1,r.t/0.65);
    if(r.t<0.65&&strikeT<9){ r.c.setAttribute('r',(6+k*58).toFixed(1)); r.c.setAttribute('opacity',(0.9*(1-k)*(1-k)).toFixed(3)); r.c.setAttribute('stroke-width',(2.4*(1-k)+0.5).toFixed(2)); }
    else r.c.setAttribute('opacity','0');
  }
  for(const s of sparks){
    s.t+=dt; const k=Math.min(1,s.t/0.5);
    if(s.t<0.5){ s.c.setAttribute('cx',(137+s.dx*k).toFixed(1)); s.c.setAttribute('cy',(45+s.dy*k+12*k*k).toFixed(1)); s.c.setAttribute('opacity',(1-k).toFixed(3)); }
    else s.c.setAttribute('opacity','0');
  }
  /* 浮字 */
  if(cur){
    cur.t+=dt; const k=cur.t/1.2;
    if(k>=1){ cur=null; floatEl.style.opacity='0'; }
    else{
      const pop=cur.t<0.12?0.85+1.25*cur.t:1;
      floatEl.style.opacity=String(k<0.08?k/0.08:(k>0.6?(1-k)/0.4:1));
      floatEl.style.transform=`translate(-50%,${(-70*(1-Math.pow(1-k,2))).toFixed(1)}px) scale(${pop.toFixed(3)})`;
    }
  }
  /* 计数滚动 */
  if(shown<target){ shown=Math.min(target,shown+Math.max(dt*6,(target-shown)*dt*4)); }
  else if(shown>target) shown=target;
  renderDigits(shown);
  if(say){
    say.t+=dt;
    say.el.style.setProperty('--lb',(0.5+0.5*Math.sin(say.t*2.4)).toFixed(3)); // 莲花慢慢呼吸
    if(say.t>3.6&&say.el.classList.contains('lotus')){ say.el.classList.remove('lotus'); say=null; }
  }
}
function busy(){ return enabled&&(queue.length>0||strikeT<0.5||!!cur); }
return {onTokens,update,setEnabled,busy,get enabled(){ return enabled; },get count(){ return target; },strike,bump,cn};
})();

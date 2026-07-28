// ===== 設定 =====
const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbycvBSQsGtNMCPCHgf29ww6lbTpPbShfhVq_NAIlLr2yDOav7ZJQ-MuiSCW3OMTHw9L/exec';
const PW = 'ody-map';          // ← 変更可（このHTML内の平文簡易ゲート。実際の保護は上記の非公開URL）

// 配送区分ごとの色
const KUBUN_COLORS = {
  'デリバリー'   : '#16a34a', // 緑：配達員対応
  '宅急便'       : '#2563eb', // 青：宅配便
  '宅急便(冷凍)' : '#0891b2', // シアン：宅配便＋冷凍
  '冷凍(宅配)'   : '#7c3aed', // 紫：冷凍
  '未設定'       : '#f59e0b', // 橙
  '解約'         : '#94a3b8'  // グレー
};
const DAYS = ['月','火','水','木','金'];

// ===== パスワードゲート =====
// 自動解錠はスクリプト全体の初期化完了後に実行（MAP等の変数初期化前に走ると地図初期化が失敗するため）
setTimeout(function(){ if(localStorage.getItem('deliv_map_pw')===PW) unlock(); }, 0);
function checkPw(){
  const v=document.getElementById('pw-input').value;
  if(v===PW){ localStorage.setItem('deliv_map_pw',PW); unlock(); }
  else document.getElementById('pw-err').style.display='block';
}
window.checkPw=checkPw;

let MAP, CLUSTER, ALL=[], ICONS={};
let cxLoaded=false, cxLoading=false, cxCache=[];      // 解約は遅延読込
let DEPOTLAYER=null, DEPOTS=null, depotLoading=false; // デポ/PC等の拠点レイヤ
let SEARCHLAYER=null; // 最寄り検索の地点・線
let NEAR_MARKERS=[];  // 最寄り上位のマーカー（カードクリックで移動）
let SEARCH_ORIGIN=null; // 直近の検索地点[lat,lng]。設定中は全ピンのポップアップに距離を表示
let _lastBand=null;
function zoomBand(){ const z=MAP?MAP.getZoom():5; return z<=11?'s':(z<=14?'m':'l'); }
function radiusForZoom(){ const z=MAP?MAP.getZoom():5; return z<=11?4 : (z<=13?6 : (z<=15?8 : 10)); }
function focusNear(i){ const m=NEAR_MARKERS[i]; if(!m) return; MAP.setView(m.getLatLng(),16,{animate:true}); m.openPopup(); }
window.focusNear=focusNear;
const SIMPLE = !!window.SIMPLE; // 簡易版フラグ（simple.htmlで window.SIMPLE=true）
const state = { kubun:new Set(), plan:new Set(), day:new Set(['月','火','水','木','金','なし']), pref:'', kw:'', depotTypes:new Set(), colorMode:'kubun', depotFilter:'', pcFilter:'', simpleG:new Set(['デリバリー','宅急便']) };

// デポ色分け用パレット（見分けやすい24色を循環）
const PALETTE = ['#e6194B','#3cb44b','#4363d8','#f58231','#911eb4','#42d4f4','#f032e6','#bfef45','#fabed4','#469990','#dcbeff','#9A6324','#800000','#aaffc3','#808000','#ffd8b1','#000075','#a9a9a9','#e6beff','#ff4500','#1e90ff','#228B22','#b03060','#00ced1'];
let DEPOT_COLORS = {}, DEPOT_COUNTS = {};   // 担当デポ名 -> 色/件数
let PC_COLORS = {}, PC_COUNTS = {};         // PC名 -> 色/件数

// 併記(「/」)から実デポ/SDS名を1つ取り出す（宅急便/宅配/メーカー/冷凍を含む語は除外）
function primaryDepot(p){
  const toks=(p.depot||'').split(' / ').map(s=>s.trim()).filter(Boolean);
  const real=toks.find(t=>t.indexOf('宅急便')<0&&t.indexOf('宅配')<0&&t.indexOf('メーカー')<0&&t.indexOf('冷凍')<0);
  return real || toks[0] || '（デポ指定なし）';
}
// 発送元PC（ピッキングセンター）を1つ取り出す
function primaryPC(p){
  const toks=(p.pc||'').split(' / ').map(s=>s.trim()).filter(Boolean);
  return toks[0] || '（PC指定なし）';
}
function keyOf(p){ return state.colorMode==='pc' ? primaryPC(p) : primaryDepot(p); }

// 拠点レイヤ（デポ一覧）の見た目
const DEPOT_STYLE = {
  'デポ':   {c:'#111827', e:'🏠'},
  'SDS':    {c:'#4b5563', e:'🚚'},
  'PC':     {c:'#1d4ed8', e:'🏢'},
  'メーカー':{c:'#92400e', e:'🏭'},
  'サラスタ':{c:'#15803d', e:'🍜'}
};

function unlock(){
  document.getElementById('pw-overlay').style.display='none';
  initMap();
  loadData();
}

function initMap(){
  MAP = L.map('map',{ preferCanvas:true }).setView([37.5,137.0], 5);
  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',{
    maxZoom:18, attribution:'地理院タイル'
  }).addTo(MAP);
  CLUSTER = L.layerGroup().addTo(MAP); // クラスタ廃止＝全ズームで個別ピン（canvas描画で軽量）
  // ズーム帯が変わったらピンの大きさを再調整（引くと小さく＝細かく、寄ると大きく）
  MAP.on('zoomend', ()=>{ const b=zoomBand(); if(b!==_lastBand){ _lastBand=b; if(ALL.length) apply(); } });
  DEPOTLAYER = L.layerGroup().addTo(MAP); // 拠点は非クラスタで最前面に
  SEARCHLAYER = L.layerGroup().addTo(MAP); // 最寄り検索の地点・線
}

function iconForColor(c){
  c = c || '#f59e0b';
  if(ICONS[c]) return ICONS[c];
  const ic = L.divIcon({
    className:'', html:`<div class="marker-dot" style="width:14px;height:14px;background:${c};"></div>`,
    iconSize:[14,14], iconAnchor:[7,7], popupAnchor:[0,-7]
  });
  ICONS[c]=ic; return ic;
}
function colorOf(p){
  if(state.colorMode==='depot') return DEPOT_COLORS[primaryDepot(p)]||'#a9a9a9';
  if(state.colorMode==='pc')    return PC_COLORS[primaryPC(p)]||'#a9a9a9';
  return KUBUN_COLORS[p.kubun]||'#f59e0b';
}

// データはGitHub Pages上の暗号化静的ファイル（./data/*.enc）。パスワードで復号して読む。
async function decryptEnc(buf){
  const raw=new Uint8Array(buf);
  const salt=raw.slice(0,16), iv=raw.slice(16,28), ct=raw.slice(28);
  const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(PW),'PBKDF2',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['decrypt']);
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,ct);
  return JSON.parse(new TextDecoder().decode(pt));
}
// データは <script> タグで読み込む（社内プロキシがfetch/XHRや特殊拡張子を塞いでも通りやすい）
function loadScript(src){
  return new Promise((resolve,reject)=>{
    const s=document.createElement('script'); s.src=src; s.async=true;
    const to=setTimeout(()=>{ s.remove(); reject(new Error('タイムアウト')); },120000);
    s.onload=()=>{ clearTimeout(to); resolve(); };
    s.onerror=()=>{ clearTimeout(to); s.remove(); reject(new Error('読込失敗')); };
    document.head.appendChild(s);
  });
}
function setLoad(t){ const el=document.getElementById('loading'); if(el) el.innerHTML=t; }
function b64ToJson(b64){ const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0)); return decryptEnc(bytes.buffer); }
function decodeWrapped(txt){ return b64ToJson(txt.replace(/^[\s\S]*?="/,'').replace(/";?\s*$/,'')); }
// 方式1: fetch（受信量を表示・進捗が見える）
async function fetchViaFetch(name){
  const res=await fetch('./data/'+name+'.js?t='+Date.now(),{cache:'no-store'});
  if(!res.ok) throw new Error('HTTP '+res.status);
  const total=+(res.headers.get('content-length')||0);
  let txt;
  if(res.body && res.body.getReader){
    const reader=res.body.getReader(); let received=0; const chunks=[];
    for(;;){ const r=await reader.read(); if(r.done) break; chunks.push(r.value); received+=r.value.length;
      if(name==='active') setLoad('データ受信中… '+(received/1048576).toFixed(1)+'MB'+(total?(' / '+(total/1048576).toFixed(1)+'MB'):'')); }
    const dec=new TextDecoder(); txt=''; for(const c of chunks) txt+=dec.decode(c,{stream:true}); txt+=dec.decode();
  } else { txt=await res.text(); }
  setLoad('復号中…');
  return decodeWrapped(txt);
}
// 方式2: <script>タグ（fetchが塞がれている環境向けフォールバック）
async function fetchViaScript(name){
  await loadScript('./data/'+name+'.js?t='+Date.now());
  const b64=window['__D_'+name]; if(!b64) throw new Error('empty');
  try{ delete window['__D_'+name]; }catch(e){}
  setLoad('復号中…'); return b64ToJson(b64);
}
async function fetchData(name){
  try{ return await fetchViaFetch(name); }
  catch(e){ setLoad('別方式で再取得中…（'+e.message+'）'); return await fetchViaScript(name); }
}
// 短縮キー(容量削減) → 通常キーへ展開
function expandPt(o){
  return {name:o.n,floor:o.f,addr:o.a,pref:o.r,lat:o.y,lng:o.x,kubun:o.k,status:o.s,
          depot:o.d,pc:o.p,plans:o.pl||[],days:o.dy||[],count:o.c,cid:o.i||'',contract:o.ct||''};
}

async function loadData(){
  let timer=null;
  setLoad('接続中…');
  try{
    const d=await fetchData('active');
    cxLoaded=false; cxCache=[]; // 解約は再取得
    ALL=(d.points||[]).map(expandPt).filter(p=>typeof p.lat==='number' && typeof p.lng==='number');
    document.getElementById('meta').textContent=
      `データ生成: ${d.generatedAt||'-'} ／ 稼働 ${ (d.stats&&d.stats.active_locations)||ALL.length } 拠点`;
    buildFilters();
    await apply();
    if(timer)clearInterval(timer);
    const l=document.getElementById('loading'); if(l) l.remove();
  }catch(e){
    if(timer)clearInterval(timer);
    const l=document.getElementById('loading');
    if(l) l.innerHTML='<b style="color:#f87171">読み込みに失敗しました</b><br><span style="font-size:12px">'+(e.name==='AbortError'?'時間切れ（通信が遅い/ブロックの可能性）':esc(e.message))+'</span><br><button onclick="loadData()" style="margin-top:10px;padding:7px 14px;border:none;border-radius:8px;background:#1d4ed8;color:#fff;font-weight:700;cursor:pointer;">再読み込み</button>';
  }
}
window.loadData=loadData;

function buildSimpleFilters(){
  // 配送区分＝デリバリー/宅急便 の2択（宅急便は冷凍も含む）
  chips('f-kubun', ['デリバリー','宅急便'], state.simpleG, {'デリバリー':KUBUN_COLORS['デリバリー'],'宅急便':KUBUN_COLORS['宅急便']});
  // プラン
  const plans=[...new Set(ALL.flatMap(p=>p.plans||[]))].sort();
  state.plan=new Set(plans); chips('f-plan', plans, state.plan, null);
  // 配達曜日（デリバリー用）
  state.day=new Set(['月','火','水','木','金']);
  chips('f-day', ['月','火','水','木','金'], state.day, null);
  const kwEl=document.getElementById('kw'); if(kwEl) kwEl.oninput=(e)=>{ state.kw=e.target.value.trim(); apply(); };
}
function buildFilters(){
  if(SIMPLE){ buildSimpleFilters(); return; }
  // 区分（稼働はデータから／「解約」は遅延読込チップとして常設・初期OFF）
  const kubuns=[...new Set(ALL.map(p=>p.kubun))].sort();
  state.kubun = new Set(kubuns);
  chips('f-kubun', [...kubuns, '解約'], state.kubun, KUBUN_COLORS);
  // 拠点レイヤ（デポ/PC等）
  chipsDepot();
  // プラン
  const plans=[...new Set(ALL.flatMap(p=>p.plans||[]))].sort();
  state.plan = new Set(plans);
  chips('f-plan', plans, state.plan, null);
  // 曜日
  chips('f-day', [...DAYS,'なし'], state.day, null);
  // 都道府県
  const prefs=[...new Set(ALL.map(p=>p.pref).filter(Boolean))].sort();
  const sel=document.getElementById('f-pref');
  if(sel){ sel.innerHTML='<option value="">すべて</option>';
    prefs.forEach(pf=>{ const o=document.createElement('option'); o.value=pf; o.textContent=pf; sel.appendChild(o); });
    sel.onchange=()=>{ state.pref=sel.value; apply(); }; }
  const kwEl=document.getElementById('kw');
  if(kwEl) kwEl.oninput=(e)=>{ state.kw=e.target.value.trim(); apply(); };
  buildColorUI();
}

function chips(containerId, items, set, colors){
  const box=document.getElementById(containerId); if(!box) return; box.innerHTML='';
  items.forEach(it=>{
    const el=document.createElement('span');
    el.className='chip'+(set.has(it)?' on':'');
    const dot = colors ? `<span class="dot" style="background:${colors[it]||'#94a3b8'}"></span>`:'';
    el.innerHTML = dot + `<span>${it}</span>`;
    el.onclick=()=>{ set.has(it)?set.delete(it):set.add(it); el.classList.toggle('on'); apply(); };
    box.appendChild(el);
  });
}

function matchSimple(p){
  // 配送区分＝デリバリー / 宅急便(冷凍含む)。未設定・解約は簡易版では非表示
  const g = p.kubun==='デリバリー' ? 'デリバリー'
          : ((p.kubun==='宅急便'||p.kubun==='宅急便(冷凍)') ? '宅急便' : null);
  if(!g || !state.simpleG.has(g)) return false;
  if((p.plans||[]).length && !p.plans.some(pl=>state.plan.has(pl))) return false;
  // 曜日はデリバリーのみに適用（宅急便は曜日不問）
  if(g==='デリバリー'){ const days=p.days||[]; if(days.length && !days.some(d=>state.day.has(d))) return false; }
  if(state.kw){ const s=(p.name+' '+p.addr).toLowerCase(); if(s.indexOf(state.kw.toLowerCase())<0) return false; }
  return true;
}
function match(p){
  if(SIMPLE) return matchSimple(p);
  if(!state.kubun.has(p.kubun)) return false;
  if(state.depotFilter && primaryDepot(p)!==state.depotFilter) return false;
  if(state.pcFilter && primaryPC(p)!==state.pcFilter) return false;
  if(state.pref && p.pref!==state.pref) return false;
  // プラン：点のプランのいずれかが選択されていればOK。プラン情報なしは常に表示。
  if((p.plans||[]).length){
    if(!p.plans.some(pl=>state.plan.has(pl))) return false;
  }
  // 曜日：デリバリーで曜日ありなら選択曜日と交差、曜日なしは「なし」がONなら表示
  const days=p.days||[];
  if(days.length){ if(!days.some(d=>state.day.has(d))) return false; }
  else{ if(!state.day.has('なし')) return false; }
  if(state.kw){
    const s=(p.name+' '+p.addr).toLowerCase();
    if(s.indexOf(state.kw.toLowerCase())<0) return false;
  }
  return true;
}

function updateDeliveryChip(){
  const box=document.getElementById('f-kubun'); if(!box) return;
  const onlyGohan = state.plan.has('ごはん') && !state.plan.has('やさい');
  box.querySelectorAll('.chip').forEach(el=>{
    if(el.textContent.indexOf('デリバリー')>=0){
      if(onlyGohan){ el.style.opacity='0.35'; el.style.pointerEvents='none'; el.classList.remove('on'); state.kubun.delete('デリバリー'); if(state.simpleG) state.simpleG.delete('デリバリー'); el.title='ごはんプランはデリバリー不可'; }
      else { el.style.opacity=''; el.style.pointerEvents=''; el.title=''; }
    }
  });
}
async function apply(){
  updateDeliveryChip();
  if(state.kubun.has('解約') && !cxLoaded){ await loadCx(); }
  const shown = ALL.filter(match);
  const r=radiusForZoom();
  const markers = shown.map(p=>{
    const m=L.circleMarker([p.lat,p.lng],{radius:r,weight:1.2,color:'#ffffff',fillColor:colorOf(p),fillOpacity:0.95});
    m.bindPopup(function(){return popupHtml(p);},{maxWidth:320}); // 開いた時に距離を計算
    return m;
  });
  if(CLUSTER) MAP.removeLayer(CLUSTER);
  CLUSTER = L.layerGroup(markers).addTo(MAP); // 一括生成→1回描画（canvas）
  document.getElementById('count').textContent = `表示中: ${shown.length.toLocaleString()} 拠点`;
}

// 解約データは初回ONで取得（軽量化）
async function loadCx(){
  if(cxLoaded || cxLoading) return;
  cxLoading=true;
  const cnt=document.getElementById('count'); if(cnt) cnt.textContent='解約データ取得中…';
  try{
    const d=await fetchData('cx');
    cxCache=(d.points||[]).map(expandPt).filter(p=>typeof p.lat==='number'&&typeof p.lng==='number');
    ALL=ALL.concat(cxCache); cxLoaded=true;
  }catch(e){}
  cxLoading=false;
}

// ===== 拠点レイヤ（デポ/PC等）=====
function chipsDepot(){
  const box=document.getElementById('f-depot'); if(!box) return; box.innerHTML='';
  Object.keys(DEPOT_STYLE).forEach(t=>{
    const el=document.createElement('span'); el.className='chip'+(state.depotTypes.has(t)?' on':'');
    el.innerHTML=`<span class="dot" style="background:${DEPOT_STYLE[t].c}"></span><span>${DEPOT_STYLE[t].e} ${t}</span>`;
    el.onclick=async()=>{ state.depotTypes.has(t)?state.depotTypes.delete(t):state.depotTypes.add(t); el.classList.toggle('on'); await ensureDepots(); renderDepots(); };
    box.appendChild(el);
  });
}
async function ensureDepots(){
  if(DEPOTS || depotLoading || !state.depotTypes.size) return;
  depotLoading=true;
  try{ const d=await fetchData('depot'); DEPOTS=d.points||[]; }
  catch(e){ DEPOTS=[]; }
  depotLoading=false;
}
function renderDepots(){
  DEPOTLAYER.clearLayers();
  if(!DEPOTS) return;
  DEPOTS.filter(p=>state.depotTypes.has(p.type)).forEach(p=>{
    const st=DEPOT_STYLE[p.type]||{c:'#000',e:'📍'};
    const ic=L.divIcon({className:'',html:`<div style="font-size:20px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))">${st.e}</div>`,iconSize:[24,24],iconAnchor:[12,12],popupAnchor:[0,-12]});
    L.marker([p.lat,p.lng],{icon:ic,zIndexOffset:1000})
      .bindPopup(`<div class="lp"><b>${esc(p.name)}</b><table><tr><td class="k">種別</td><td>${esc(p.type)}</td></tr><tr><td class="k">住所</td><td>${esc(p.addr)}</td></tr></table></div>`)
      .addTo(DEPOTLAYER);
  });
}

// ===== ピンの色分け（配送区分 / 担当デポ / PC）＋ デポ・PC絞り込み・凡例 =====
function tally(keyFn){
  const cnt={}; ALL.forEach(p=>{ if(p.kubun==='解約') return; const k=keyFn(p); cnt[k]=(cnt[k]||0)+1; });
  const keys=Object.keys(cnt).sort((a,b)=>cnt[b]-cnt[a]);
  const col={}; keys.forEach((k,i)=>col[k]=PALETTE[i%PALETTE.length]);
  return {cnt,keys,col};
}
function fillSelect(id,keys,cnt,cur,onch){
  const sel=document.getElementById(id); if(!sel) return;
  sel.innerHTML='<option value="">すべて表示</option>'+keys.map(k=>`<option value="${k.replace(/"/g,'')}">${k}（${cnt[k]}）</option>`).join('');
  sel.value=cur; sel.onchange=()=>onch(sel.value);
}
function buildColorUI(){
  // 色分けモード（簡易版など色分けUIが無い場合はスキップ）
  const cm=document.getElementById('f-colormode'); if(!cm) return; cm.innerHTML='';
  [['kubun','配送区分'],['depot','担当デポ/SDS'],['pc','発送元PC']].forEach(([v,label])=>{
    const el=document.createElement('span'); el.className='chip'+(state.colorMode===v?' on':'');
    el.textContent=label;
    el.onclick=()=>{ state.colorMode=v; buildColorUI(); apply(); };
    cm.appendChild(el);
  });
  // 集計・色割当（稼働のみ・件数降順）
  const dp=tally(primaryDepot); DEPOT_COUNTS=dp.cnt; DEPOT_COLORS=dp.col;
  const pc=tally(primaryPC);    PC_COUNTS=pc.cnt;    PC_COLORS=pc.col;
  // 絞り込みドロップダウン
  fillSelect('f-depotfilter', dp.keys, dp.cnt, state.depotFilter, v=>{ state.depotFilter=v; apply(); });
  fillSelect('f-pcfilter',    pc.keys, pc.cnt, state.pcFilter,    v=>{ state.pcFilter=v;    apply(); });
  // 凡例（色分けモードに応じてデポ or PC を表示、クリックで絞り込み）
  const lg=document.getElementById('color-legend');
  if(state.colorMode==='depot'||state.colorMode==='pc'){
    const t=(state.colorMode==='pc')?pc:dp, selId=(state.colorMode==='pc')?'f-pcfilter':'f-depotfilter';
    lg.innerHTML=t.keys.map(k=>`<div class="legrow" data-k="${k.replace(/"/g,'')}" style="display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;"><span style="width:12px;height:12px;border-radius:3px;background:${t.col[k]};flex:0 0 12px;"></span><span>${k}（${t.cnt[k]}）</span></div>`).join('');
    lg.querySelectorAll('.legrow').forEach(el=>el.onclick=()=>{ const k=el.getAttribute('data-k');
      if(state.colorMode==='pc'){ state.pcFilter=k; } else { state.depotFilter=k; }
      document.getElementById(selId).value=k; apply(); });
    lg.style.display='block';
  } else { lg.style.display='none'; }
}

function popupHtml(p){
  const row=(k,v)=> v?`<tr><td class="k">${k}</td><td>${esc(v)}</td></tr>`:'';
  let distRow='';
  if(SEARCH_ORIGIN){ const d=distKm(SEARCH_ORIGIN,[p.lat,p.lng]); distRow=`<tr><td class="k">検索地点からの距離</td><td><b>直線 ${d.toFixed(d<10?1:0)} km</b></td></tr>`; }
  return `<div class="lp"><b>${esc(p.name||'(名称なし)')}</b>${p.floor?' <span style="color:#64748b">'+esc(p.floor)+'</span>':''}
    <table>
      ${distRow}
      ${row('CID',p.cid)}
      ${row('契約ステータス',p.contract)}
      ${row('住所',p.addr)}
      ${row('配送区分',p.kubun)}
      ${row('デポ/委託先',p.depot)}
      ${row('PC',p.pc)}
      ${row('プラン',(p.plans||[]).join('・'))}
      ${row('配達曜日',(p.days||[]).join('・'))}
      ${row('個数',p.count)}
      ${row('稼働ステータス',p.status)}
    </table></div>`;
}
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ===== CMSデータで更新（アプリ内アップロード）=====
const HCOL = {company:'企業',floor:'フロア',pc:'ピッキングセンター',depot:'デポ',pref:'都道府県',address:'住所',plan:'プラン',count:'個数',status:'稼働ステータス',mon:'月',tue:'火',wed:'水',thu:'木',fri:'金',lat:'緯度',lng:'経度'};
function ingStatus(t){ document.getElementById('ingest-status').innerHTML=t; }
async function decodeCsv(file){
  const buf=await file.arrayBuffer();
  let text=new TextDecoder('shift_jis',{fatal:false}).decode(buf);
  if(!text || text.indexOf('企業')<0) text=new TextDecoder('utf-8').decode(buf);
  return text;
}
function isCancel(st){ return /解約|キャンセル|停止|休止|終了/.test(st||''); }
function normPlan(x){ if(!x)return''; if(x.indexOf('ごはん')>=0)return'ごはん'; if(x.indexOf('やさい')>=0)return'やさい'; return''; }
function marked(v){ v=(v==null?'':String(v)).trim(); return v!==''&&v!=='0'&&v!=='×'&&v!=='-'; }
function toNum(v){ v=(v==null?'':String(v)).trim(); if(v==='')return null; const n=Number(v); return isFinite(n)?n:null; }
function classifySets(deps,pcs){
  const dep=[...deps].filter(Boolean), pcl=[...pcs].filter(Boolean);
  const hasDel=dep.some(d=>d.indexOf('宅急便')<0&&d.indexOf('宅配')<0&&d.indexOf('メーカー')<0);
  const hasTak=dep.some(d=>d.indexOf('宅急便')>=0||d.indexOf('宅配')>=0);
  const hasFrz=dep.some(d=>d.indexOf('冷凍')>=0)||pcl.some(p=>p.indexOf('冷凍')>=0);
  if(hasDel)return'デリバリー';
  if(hasTak)return hasFrz?'宅急便(冷凍)':'宅急便';
  if(hasFrz)return'冷凍(宅配)';
  if(dep.length)return'デリバリー';
  return'未設定';
}
function transformRows(rows){
  const header=rows[0].map(h=>String(h).trim()), idx={};
  for(const k in HCOL) idx[k]=header.indexOf(HCOL[k]);
  for(const req of ['company','address','lat','lng']) if(idx[req]<0) throw new Error('必須列が見つかりません: '+HCOL[req]);
  const DAYS=[['月','mon'],['火','tue'],['水','wed'],['木','thu'],['金','fri']];
  const g=(row,k)=> idx[k]>=0 ? (row[idx[k]]==null?'':String(row[idx[k]]).trim()) : '';
  const byloc={}, stats={rawRows:rows.length-1,active:0,cancelled:0,dropped_noCoord:0};
  for(let r=1;r<rows.length;r++){
    const row=rows[r]; if(!row) continue;
    const company=g(row,'company'), address=g(row,'address');
    if(!company&&!address) continue;
    const status=g(row,'status'), cancel=isCancel(status);
    const depot=g(row,'depot'), pc=g(row,'pc'), plan=normPlan(g(row,'plan'));
    const days=DAYS.filter(d=>marked(g(row,d[1]))).map(d=>d[0]);
    let lat=toNum(g(row,'lat')), lng=toNum(g(row,'lng'));
    const key=company+'|'+g(row,'floor')+'|'+address+'|'+plan;  // プランごとに別ピン
    let L=byloc[key];
    if(!L){ L={name:company,floor:g(row,'floor'),addr:address,pref:g(row,'pref'),lat:null,lng:null,cancelled:true,status:status,act_dep:new Set(),act_pc:new Set(),any_dep:new Set(),any_pc:new Set(),plans:new Set(),days:new Set(),count:0}; byloc[key]=L; }
    if(lat!=null&&lng!=null&&L.lat==null){ L.lat=Math.round(lat*1e6)/1e6; L.lng=Math.round(lng*1e6)/1e6; }
    if(depot)L.any_dep.add(depot); if(pc)L.any_pc.add(pc);
    if(!cancel){ L.cancelled=false; L.status=status; if(depot)L.act_dep.add(depot); if(pc)L.act_pc.add(pc); if(plan)L.plans.add(plan); days.forEach(d=>L.days.add(d)); const c=toNum(g(row,'count')); if(c!=null)L.count+=Math.round(c); }
  }
  const active=[], cx=[], pending=[];
  for(const k in byloc){ const L=byloc[k];
    if(L.cancelled){ if(L.lat!=null) cx.push({name:L.name,floor:L.floor,addr:L.addr,pref:L.pref,lat:L.lat,lng:L.lng,kubun:'解約',status:'解約',depot:'',pc:'',plans:[],days:[],count:''}); continue; }
    const p={name:L.name,floor:L.floor,addr:L.addr,pref:L.pref,lat:L.lat,lng:L.lng,kubun:classifySets(L.act_dep,L.act_pc),status:L.status,depot:[...L.act_dep].sort().join(' / '),pc:[...L.act_pc].sort().join(' / '),plans:[...L.plans].sort(),days:['月','火','水','木','金'].filter(d=>L.days.has(d)),count:L.count};
    if(L.plans.has('ごはん')) p.kubun='宅急便(冷凍)';  // ごはんは冷凍=宅急便のみ（デリバリー不可）
    if(L.lat!=null) active.push(p); else pending.push(p);  // 稼働で座標なし → 後でGSI補完
  }
  const now=new Date(), p2=n=>String(n).padStart(2,'0');
  const gen=`${now.getFullYear()}/${p2(now.getMonth()+1)}/${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
  return {generatedAt:gen, active, cx, pending, stats};
}
// 住所を綺麗にして座標を導く（ブラウザ内・国土地理院API・CMSには触れない）
const GKEY='deliv_geocache';
let gcache={}; try{ gcache=JSON.parse(localStorage.getItem(GKEY)||'{}'); }catch(e){}
function normCandidates(addr){
  let a=addr.normalize('NFKC').replace(/〒?\s*\d{3}[-−]?\d{4}\s*/,'').replace(/センターコード\s*【[^】]*】/,'').replace(/【[^】]*】/g,'').replace(/　/g,' ').trim();
  const c=[a];
  const m=a.match(/(京都市.*?区).*?(?:下ル|上ル|東入ル|西入ル|東入|西入|下る|上る)(.+)/);
  if(m){ const town=m[2].replace(/\d.*$/,'').trim(); if(town) c.push('京都府'+m[1]+town); }
  if(a.indexOf(' ')>=0) c.push(a.split(' ')[0]);
  const t=a.replace(/([0-9０-９]+[-−ー－].*|[0-9０-９]+番.*|[0-9０-９]+$)/,'').trim();
  if(t&&t!==a) c.push(t);
  return [...new Set(c.filter(Boolean))];
}
async function gsiQuery(q){
  try{ const r=await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q='+encodeURIComponent(q));
    const a=await r.json();
    if(a&&a[0]&&a[0].geometry&&a[0].geometry.coordinates){ const c=a[0].geometry.coordinates; return [Math.round(c[1]*1e6)/1e6,Math.round(c[0]*1e6)/1e6]; }
  }catch(e){} return null;
}
async function geocodeOne(addr){
  if(addr in gcache) return gcache[addr];
  let res=null;
  for(const q of normCandidates(addr)){ res=await gsiQuery(q); if(res) break; }
  gcache[addr]=res; return res;
}
async function geocodePending(pending,onProg){
  const resolved=[], unresolved=[];
  for(let i=0;i<pending.length;i++){
    const p=pending[i]; const gcd=await geocodeOne(p.addr);
    if(gcd){ p.lat=gcd[0]; p.lng=gcd[1]; resolved.push(p); }
    else unresolved.push({name:p.name,addr:p.addr,pref:p.pref});
    if(onProg && i%10===0) onProg(i+1,pending.length);
  }
  try{ localStorage.setItem(GKEY, JSON.stringify(gcache)); }catch(e){}
  return {resolved, unresolved};
}

// 共有ジオコーディングキャッシュ（サーバ配信）で座標なしを「待たずに」即補完
let SHARED_GEO=null, RESIDUAL=[], LAST_ACTIVE=null, LAST_GEN='';
async function ensureGeocache(){
  if(SHARED_GEO) return;
  try{ SHARED_GEO=await fetchData('geocache')||{}; }
  catch(e){ SHARED_GEO={}; }
}
function postSet(gen,set,pts){
  return fetch(BACKEND_URL,{method:'POST',redirect:'follow',headers:{'Content-Type':'text/plain'},
    body:JSON.stringify({pw:PW,set:set,json:JSON.stringify({generatedAt:gen,points:pts,stats:{locations:pts.length}})})}).then(r=>r.json());
}

async function ingest(){
  const f=document.getElementById('csvfile').files[0];
  if(!f){ ingStatus('<span style="color:#f87171">CSVファイルを選んでください</span>'); return; }
  const btn=document.getElementById('ingestBtn'); btn.disabled=true;
  try{
    ingStatus('① 読み込み中…'); const text=await decodeCsv(f);
    ingStatus('② 解析中…'); const parsed=Papa.parse(text,{skipEmptyLines:true});
    ingStatus('③ 整形中…'); const result=transformRows(parsed.data);
    ingStatus('④ 座標を補完中…'); await ensureGeocache();
    const residual=[];
    result.pending.forEach(p=>{ const g=SHARED_GEO&&SHARED_GEO[p.addr]; if(g){ p.lat=g[0]; p.lng=g[1]; result.active.push(p); } else residual.push({name:p.name,addr:p.addr,pref:p.pref}); });
    // この端末で即表示（サーバ不要）
    cxLoaded=false; cxCache=[]; ALL=result.active.slice();
    document.getElementById('meta').textContent=`アップロード表示中 ／ 稼働 ${result.active.length.toLocaleString()} 拠点（生成 ${result.generatedAt}）`;
    RESIDUAL=residual; LAST_ACTIVE=result.active; LAST_GEN=result.generatedAt;
    SHARE={active:result.active,cx:result.cx,unresolved:residual,gen:result.generatedAt};
    UNRESOLVED=residual; loadUnresolvedBtn();
    buildFilters(); await apply();
    ingStatus(`✅ この端末に表示しました：稼働 ${result.active.length.toLocaleString()} ／ 解約 ${result.cx.length.toLocaleString()}${residual.length?` ／ 未解決 ${residual.length}`:''}<br><a href="#" onclick="downloadShare();return false" style="color:#93c5fd;font-weight:700;">▼ 全員へ反映するデータをダウンロード</a>（管理者へ渡すと全員に反映）`);
  }catch(e){ ingStatus('<span style="color:#f87171">エラー: '+e.message+'</span>'); }
  finally{ document.getElementById('ingestBtn').disabled=false; }
}
document.getElementById('ingestBtn').onclick=ingest;

let SHARE=null;
function downloadShare(){
  if(!SHARE) return;
  const blob=new Blob([JSON.stringify(SHARE)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='map_update_'+String(SHARE.gen||'').replace(/[^0-9]/g,'')+'.json';
  document.body.appendChild(a); a.click(); a.remove();
}
window.downloadShare=downloadShare;
function loadUnresolvedBtn(){ const b=document.getElementById('unresBtn'); if(b){ b.textContent=`⚠️ 座標未解決リスト（${UNRESOLVED.length}）`; b.style.display=UNRESOLVED.length?'block':'none'; } }

// 未解決（新規住所）を必要な時だけGSIで補完して反映（任意・時間がかかる）
async function fillUnresolvedViaGsi(){
  const btn=document.getElementById('unres-fill');
  if(!RESIDUAL.length){ if(btn) btn.textContent='補完対象は今回のアップロード分のみ'; return; }
  if(btn) btn.disabled=true;
  const gc=await geocodePending(RESIDUAL,(i,n)=>{ if(btn) btn.textContent=`GSIで補完中… ${i}/${n}`; });
  if(gc.resolved.length){
    ALL=ALL.concat(gc.resolved); RESIDUAL=gc.unresolved; UNRESOLVED=gc.unresolved;
    if(SHARE){ SHARE.active=(SHARE.active||[]).concat(gc.resolved); SHARE.unresolved=gc.unresolved; }
    loadUnresolvedBtn(); buildColorUI(); await apply(); showUnresolved();
  }
  if(btn){ btn.textContent=`GSIで座標を補完（${gc.resolved.length}件）`; btn.disabled=false; }
}
window.fillUnresolvedViaGsi=fillUnresolvedViaGsi;

// ===== 住所から最寄りの契約企業を検索 =====
function distKm(a,b){
  const R=6371, toR=x=>x*Math.PI/180;
  const dLat=toR(b[0]-a[0]), dLng=toR(b[1]-a[1]);
  const s=Math.sin(dLat/2)**2 + Math.cos(toR(a[0]))*Math.cos(toR(b[0]))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(s)));
}
function nearPopup(p,d){
  const days=(p.days||[]).length ? (p.days.join('・')+'曜') : '曜日指定なし';
  const detail=[p.depot,p.pc].filter(Boolean).join(' ／ ');
  const row=(k,v)=> v?`<tr><td class="k">${k}</td><td>${esc(v)}</td></tr>`:'';
  return `<div class="lp"><b>${esc(p.name)}</b> <span style="color:#64748b">${esc(p.floor||'')}</span>
    <table>${row('検索地点からの距離','<b>直線 '+d.toFixed(d<10?1:0)+' km</b>')}${row('CID',p.cid)}${row('契約ステータス',p.contract)}${row('配送区分',p.kubun)}${row('プラン',(p.plans||[]).join('・'))}${row('配達曜日',days)}${row('デポ/PC',detail)}</table></div>`;
}
async function findNearest(){
  const q=document.getElementById('nearAddr').value.trim();
  const box=document.getElementById('near-result');
  if(!q){ box.innerHTML=''; SEARCHLAYER.clearLayers(); SEARCH_ORIGIN=null; return; }
  box.innerHTML='検索中…';
  const g=await geocodeOne(q);
  if(!g){ box.innerHTML='<span style="color:#f87171">住所から位置を特定できませんでした。市区町村＋番地の形で入れてみてください。</span>'; return; }
  SEARCH_ORIGIN=g; // 以降、全ピンのポップアップに検索地点からの距離を表示
  const cands=ALL.filter(p=>p.kubun!=='解約');
  if(!cands.length){ box.innerHTML='データがまだ読み込まれていません。'; return; }
  const top=cands.map(p=>({p,d:distKm(g,[p.lat,p.lng])})).sort((a,b)=>a.d-b.d).slice(0,3);
  // 地図に検索地点＋最寄り企業を表示（番号なし・タップで距離入りポップアップ）
  SEARCHLAYER.clearLayers();
  const here=L.marker(g,{icon:L.divIcon({className:'',html:'<div style="font-size:26px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))">📍</div>',iconSize:[28,28],iconAnchor:[14,28],popupAnchor:[0,-26]}),zIndexOffset:3000}).bindPopup('<b>検索地点</b><br>'+esc(q));
  here.addTo(SEARCHLAYER);
  NEAR_MARKERS=[];
  const bounds=[g];
  top.forEach((s,i)=>{
    const p=s.p, c=KUBUN_COLORS[p.kubun]||'#f59e0b';
    L.polyline([g,[p.lat,p.lng]],{color:'#0d9488',weight:2,dashArray:'5,6',opacity:.6}).addTo(SEARCHLAYER);
    const ic=L.divIcon({className:'',html:`<div style="width:22px;height:22px;border-radius:50%;background:${c};border:3px solid #fff;box-shadow:0 0 0 3px rgba(13,148,136,.75),0 1px 5px rgba(0,0,0,.45);"></div>`,iconSize:[22,22],iconAnchor:[11,11],popupAnchor:[0,-11]});
    NEAR_MARKERS[i]=L.marker([p.lat,p.lng],{icon:ic,zIndexOffset:2500}).bindPopup(nearPopup(p,s.d)).addTo(SEARCHLAYER);
    bounds.push([p.lat,p.lng]);
  });
  MAP.fitBounds(bounds,{padding:[70,70],maxZoom:15});
  if(NEAR_MARKERS[0]) NEAR_MARKERS[0].openPopup(); // 最寄り1社の距離ポップアップを自動表示
  // 結果カード（近い順・番号なし）
  box.innerHTML=top.map((s,i)=>{
    const p=s.p, c=KUBUN_COLORS[p.kubun]||'#f59e0b';
    const days=(p.days||[]).length ? (p.days.join('・')+'曜') : '曜日指定なし';
    const detail=[p.depot,p.pc].filter(Boolean).join(' ／ ');
    return `<div onclick="focusNear(${i})" title="クリックで地図で表示" style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:8px 10px;margin-bottom:6px;cursor:pointer;">
      <div style="font-weight:700;">${esc(p.name)} <span style="color:#94a3b8;font-weight:400;">${esc(p.floor||'')}</span></div>
      <div style="color:#e2e8f0;margin-top:2px;">検索地点から <b>直線 ${s.d.toFixed(s.d<10?1:0)} km</b></div>
      <div style="margin-top:3px;"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${c};margin-right:6px;vertical-align:-1px;"></span>${esc(p.kubun)} ／ ${days}</div>
      ${detail?`<div style="color:#94a3b8;margin-top:2px;">${esc(detail)}</div>`:''}
      <div style="text-align:right;color:#5eead4;font-size:11px;margin-top:3px;">地図で表示 ›</div>
    </div>`;
  }).join('');
}
window.findNearest=findNearest;
document.getElementById('nearBtn').onclick=findNearest;

// ===== 座標未解決リスト（閲覧）=====
let UNRESOLVED=[];
async function loadUnresolved(){
  try{ const d=await fetchData('unresolved'); UNRESOLVED=d.points||[]; }
  catch(e){ UNRESOLVED=[]; }
  const b=document.getElementById('unresBtn');
  if(b){ b.textContent=`⚠️ 座標未解決リスト（${UNRESOLVED.length}）`; b.style.display=UNRESOLVED.length?'block':'none'; }
}
function showUnresolved(){
  const ov=document.getElementById('unres-modal');
  const rows=UNRESOLVED.map((p,i)=>`<tr><td>${i+1}</td><td>${esc(p.name)}</td><td>${esc(p.pref||'')}</td><td>${esc(p.addr)}</td></tr>`).join('');
  document.getElementById('unres-body').innerHTML=
    `<div style="margin-bottom:8px;font-size:12px;color:#475569">座標が取得できず地図に出せていない稼働拠点です（住所表記の見直しやCMSでの修正で解決できます）。</div>`+
    `<table class="ul"><thead><tr><th>#</th><th>企業名</th><th>都道府県</th><th>住所</th></tr></thead><tbody>${rows||'<tr><td colspan=4>なし</td></tr>'}</tbody></table>`;
  ov.style.display='flex';
}
function copyUnresolved(){
  const t=UNRESOLVED.map(p=>[p.name,p.pref||'',p.addr].join('\t')).join('\n');
  navigator.clipboard.writeText(t).then(()=>{ document.getElementById('unres-copy').textContent='✓ コピーしました'; });
}
window.showUnresolved=showUnresolved; window.copyUnresolved=copyUnresolved;
document.getElementById('unresBtn').onclick=showUnresolved;
document.getElementById('unres-close').onclick=()=>{ document.getElementById('unres-modal').style.display='none'; };
loadUnresolved();

document.getElementById('foot').innerHTML =
  'ピンをクリックで詳細。上部フィルタで区分・プラン・曜日・都道府県・キーワードを絞り込み。<br>「解約」はグレーピン（初期OFF）。データは社外秘。';

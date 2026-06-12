/* ════════════════════════════════════════════════════════════════
   0 · DOM handles & shared state
════════════════════════════════════════════════════════════════ */
const hudEl     = document.getElementById('hud');
const pageTitleEl = document.getElementById('pageTitle');
const stageEl   = document.getElementById('stage');
const closerEl  = document.getElementById('closer');
const scrollEl  = document.getElementById('scrollEl');
const titleEl   = document.getElementById('articleTitle');
const ticketEl  = document.getElementById('ticketLink');
const choicesEl = document.getElementById('choices');
const infoNavEl = document.getElementById('infoChoices');
const infoCardEl = document.getElementById('infoCard');
const lastModEl = document.getElementById('lastModLabel');
const cards     = [...document.querySelectorAll('#choices .choice')];
const statusEl  = document.getElementById('status');
const overlayEl = document.getElementById('overlay');

/* update-modal handles */
const updateStageEl = document.getElementById('updateStage');
const updateBoxEl   = document.getElementById('updateBox');
const updateCloserEl = document.getElementById('updateCloser');
const updateContentEl  = document.getElementById('updateContent');
const confirmContentEl = document.getElementById('confirmContent');
const confirmUrlEl    = document.getElementById('confirmUrl');
const mindBtnEl       = document.getElementById('mindBtn');
const noUpdBtnEl      = document.getElementById('noUpdBtn');
const confirmStatusEl = document.getElementById('confirmStatus');
const transferContentEl = document.getElementById('transferContent');
const transferMsgEl   = document.getElementById('transferMsg');
const pendingBoxEl    = document.getElementById('pendingBox');
const pendingWhoEl    = document.getElementById('pendingWho');
const withdrawBtnEl   = document.getElementById('withdrawBtn');
const uidInputEl      = document.getElementById('uidInput');
const searchBtnEl     = document.getElementById('searchBtn');
const foundNameEl     = document.getElementById('foundName');
const transferNoteEl  = document.getElementById('transferNote');
const confirmTransferBtnEl = document.getElementById('confirmTransferBtn');
const transferStatusEl = document.getElementById('transferStatus');
const updPendingContentEl = document.getElementById('updPendingContent');
const closeUpdPendBtnEl   = document.getElementById('closeUpdPendBtn');
const reviewSubmitBtnEl   = document.getElementById('reviewSubmitBtn');
const deleteContentEl = document.getElementById('deleteContent');
const deleteMsgEl     = document.getElementById('deleteMsg');
const deletePendingMsgEl = document.getElementById('deletePendingMsg');
const deleteUrlEl     = document.getElementById('deleteUrl');
const deleteBtnsEl    = document.getElementById('deleteBtns');
const cancelDelBtnEl  = document.getElementById('cancelDelBtn');
const delBtnEl        = document.getElementById('delBtn');
const recallBtnsEl    = document.getElementById('recallBtns');
const closeDelBtnEl   = document.getElementById('closeDelBtn');
const recallBtnEl     = document.getElementById('recallBtn');
const deleteStatusEl  = document.getElementById('deleteStatus');
const updUrlEl    = document.getElementById('updUrl');
const dropZoneEl  = document.getElementById('dropZone');
const fileInputEl = document.getElementById('fileInput');
const browseBtnEl = document.getElementById('browseBtn');
const fileListEl  = document.getElementById('fileList');
const sendBtnEl   = document.getElementById('sendBtn');
const updStatusEl = document.getElementById('updStatus');

/* base of the real SharePoint site — swap when known */
const SHAREPOINT_BASE = 'https://company.sharepoint.com';

/* SharePoint page URL for an entry: base + dashed article name + .aspx */
function articleUrl(entry){
  return SHAREPOINT_BASE + '/' +
    String(entry.article || '').trim().replace(/\s+/g, '-') + '.aspx';
}

const STORE_KEY = 'scrollArchive';
const STORE_VER = 6;   // bump whenever the entry schema changes (v6: +Update)
const state = { hover: -1, selected: -1 };
let archive   = [];      // entries from project.json (cached in sessionStorage)
let modalOpen = false;
let modalMode = 'review';   // 'review' (due:"Y") | 'info' (due:"N")
let updateOpen = false;     // the "I will update" message scroll
let currentEntry = null;    // entry shown in the open modal
let unfurlT = 0;            // message-scroll unfurl progress 0→1
const fileQueue = [];       // File objects awaiting "Send for Review"
let sending = false;
let modalT0   = 0;       // fx-view time when threads may begin revealing
let lastTime  = 0;

/* ════════════════════════════════════════════════════════════════
   1 · Paper.js — two scopes:
       bg  → #overlay : motes, sparkles, flourishes, gallery (blurrable)
       fx  → #fx      : modal threads & sparks (always sharp, on top)
════════════════════════════════════════════════════════════════ */
const bg = new paper.PaperScope();
bg.setup(overlayEl);
const fx = new paper.PaperScope();
fx.setup(document.getElementById('fx'));
const msg = new paper.PaperScope();   // the horizontal "message scroll"
msg.setup(document.getElementById('msg'));

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const GOLD = '#e3b964', ICE = '#8fb7ff', IVORY = '#ece9df';

bg.activate();
const bgLayer      = bg.project.activeLayer;
const galleryLayer = new paper.Layer();
bgLayer.activate();

/* ── ambient motes & sparkles ── */
const motes = [], sparkles = [];
function seedAmbient(){
  bg.activate(); bgLayer.activate();
  motes.forEach(m => m.item.remove()); sparkles.forEach(s => s.item.remove());
  motes.length = 0; sparkles.length = 0;
  const w = bg.view.size.width, h = bg.view.size.height;
  const tints = [IVORY, '#b9aaff', '#ffb9dd', ICE];
  for (let i = 0; i < 34; i++){
    motes.push({
      item: new paper.Path.Circle({
        center: [Math.random()*w, Math.random()*h],
        radius: 0.8 + Math.random()*1.5,
        fillColor: tints[i % tints.length] }),
      vy: 0.06 + Math.random()*0.18, ph: Math.random()*6.28
    });
  }
  for (let i = 0; i < 5; i++){
    const r = 5 + Math.random()*7;
    const c = new paper.Point(Math.random()*w, Math.random()*h);
    const star = new paper.Path({ fillColor: new paper.Color(1, 1, .95, .9), closed: true });
    [[0,-r],[r*.16,-r*.16],[r,0],[r*.16,r*.16],[0,r],[-r*.16,r*.16],[-r,0],[-r*.16,-r*.16]]
      .forEach(p => star.add(c.add(p)));
    sparkles.push({ item: star, ph: Math.random()*6.28, sp: .4 + Math.random()*.5 });
  }
}
seedAmbient();

/* ── corner flourishes on the frame ── */
bg.activate(); bgLayer.activate();
const flourishGroup = new paper.Group();
function drawFlourishes(){
  bg.activate();
  flourishGroup.removeChildren();
  const w = bg.view.size.width, h = bg.view.size.height, m = 16;
  const corners = [
    { c: [m, m],     sweep: [1, 1]  }, { c: [w-m, m],   sweep: [-1, 1] },
    { c: [m, h-m],   sweep: [1, -1] }, { c: [w-m, h-m], sweep: [-1, -1] }
  ];
  corners.forEach(({c, sweep}) => {
    [54, 84].forEach((r, k) => {
      const a = new paper.Path.Arc({
        from:    [c[0] + sweep[0]*r, c[1] + sweep[1]*8],
        through: [c[0] + sweep[0]*r*0.74, c[1] + sweep[1]*r*0.74],
        to:      [c[0] + sweep[0]*8, c[1] + sweep[1]*r],
        strokeColor: new paper.Color(.48, .53, 1, k ? .10 : .22), strokeWidth: 1
      });
      flourishGroup.addChild(a);
    });
  });
}
drawFlourishes();

/* ════════════════════════════════════════════════════════════════
   2 · The archive gallery — one semi-opened scroll per entry
════════════════════════════════════════════════════════════════ */
const scrollItems = [];   // { item: paper.Group, entry }
let hovered = null;

function drawMiniScroll(entry){
  const W = 270, rollH = 28, capW = 20, capH = rollH + 6;
  const parchTop = rollH - 8, parchH = 150;
  const g = new paper.Group();

  /* parchment — only a sliver is unrolled: emblem, title, rule.
     Same aged-parchment radial gradient as the horizontal scroll:
     warm cream centre deepening to tan at the edges */
  const pcx = W / 2, pcy = parchTop + parchH / 2;
  const parch = new paper.Path.Rectangle({ point: [14, parchTop], size: [W - 28, parchH] });
  parch.fillColor = {
    gradient: {
      stops: [['#f9efd8', 0], ['#f2dfb9', .5], ['#e3c08c', .82], ['#c2925b', 1]],
      radial: true
    },
    origin: [pcx, pcy], destination: [pcx, pcy - 150]
  };
  parch.strokeColor = '#6b4a2a'; parch.strokeWidth = 1.5;
  parch.shadowColor = new paper.Color(0, 0, 0, .5);
  parch.shadowBlur = 24; parch.shadowOffset = new paper.Point(0, 12);
  g.addChild(parch);

  /* curl shadow where the parchment disappears into the bottom roller */
  const shade = new paper.Path.Rectangle({ point: [14, parchTop + parchH - 18], size: [W - 28, 18] });
  shade.fillColor = {
    gradient: { stops: [[new paper.Color(.42, .29, .16, 0), 0], [new paper.Color(.42, .29, .16, .25), 1]] },
    origin: [0, parchTop + parchH - 18], destination: [0, parchTop + parchH]
  };
  g.addChild(shade);

  /* inner border */
  const inner = new paper.Path.Rectangle({ point: [22, parchTop + 8], size: [W - 44, parchH - 16] });
  inner.strokeColor = 'rgba(107,74,42,.35)'; inner.strokeWidth = 1;
  g.addChild(inner);

  /* tiny emblem — arc + teal eye, echoing the modal's emblem */
  const emY = parchTop + 22;
  const em = new paper.Path.Arc({
    from: [W/2 - 11, emY], through: [W/2, emY + 6], to: [W/2 + 11, emY],
    strokeColor: '#3a2f73', strokeWidth: 2, strokeCap: 'round'
  });
  const emDot = new paper.Path.Circle({ center: [W/2, emY + 1], radius: 2.4, fillColor: '#54e0d8' });
  g.addChildren([em, emDot]);

  /* title — from the json "article" value; wraps to two lines when
     long, then shrinks as a last resort */
  const maxTitleW = W - 64;
  const title = new paper.PointText({
    point: [W/2, 0],
    content: String(entry.article || 'Untitled').toUpperCase(),
    justification: 'center', fillColor: '#4a3d8f',
    fontFamily: '"Cinzel", Georgia, serif', fontWeight: 700, fontSize: 16
  });
  if (title.bounds.width > maxTitleW){
    const words = title.content.split(/\s+/);
    if (words.length > 1){
      let best = null;
      for (let k = 1; k < words.length; k++){
        const l1 = words.slice(0, k).join(' '), l2 = words.slice(k).join(' ');
        const len = Math.max(l1.length, l2.length);
        if (!best || len < best.len) best = { l1, l2, len };
      }
      title.content = best.l1 + '\n' + best.l2;
    }
    while (title.bounds.width > maxTitleW && title.fontSize > 9){ title.fontSize -= 1; }
  }
  title.position = new paper.Point(W/2, parchTop + 62);
  g.addChild(title);

  /* status flag beneath the title: red while due, amber while an
     action awaits the other party */
  let flag = null, flagColor = '#b3261e';
  if (String(entry.due || '').trim().toUpperCase() === 'Y'){
    flag = 'DUE FOR REVIEW';
  } else if (entry.Deletion && entry.Deletion.delete === true){
    flag = 'DELETION PENDING'; flagColor = '#9c6a1c';
  } else if (entry.ownership && String(entry.ownership.transferTo || '').trim()){
    flag = 'TRANSFER PENDING'; flagColor = '#9c6a1c';
  } else if (entry.Update && entry.Update.submitted === true){
    flag = 'UPDATE SUBMITTED'; flagColor = '#9c6a1c';
  }
  if (flag){
    const flagLabel = new paper.PointText({
      point: [W/2, title.bounds.bottom + 18],
      content: flag,
      justification: 'center', fillColor: flagColor,
      fontFamily: '"Cinzel", Georgia, serif', fontWeight: 600, fontSize: 10
    });
    g.addChild(flagLabel);
  }

  /* bronze rule near the foot of the parchment */
  const bronze = new paper.Color(184/255, 133/255, 74/255);
  const rule = new paper.Path.Rectangle({ point: [W/2 - 58, parchTop + parchH - 28], size: [116, 1.2] });
  rule.fillColor = {
    gradient: { stops: [
      [new paper.Color(bronze.red, bronze.green, bronze.blue, 0),  0],
      [new paper.Color(bronze.red, bronze.green, bronze.blue, .9), .5],
      [new paper.Color(bronze.red, bronze.green, bronze.blue, 0),  1] ] },
    origin: [W/2 - 58, 0], destination: [W/2 + 58, 0]
  };
  g.addChild(rule);

  /* wooden rollers, top & bottom */
  function makeRoller(y){
    const r = new paper.Group();
    const bar = new paper.Path.Rectangle({ point: [0, y], size: [W, rollH], radius: rollH/2 });
    bar.fillColor = {
      gradient: { stops: [['#d9ab66', 0], ['#b8854a', .38], ['#8a5f33', .7], ['#6e4a26', 1]] },
      origin: [0, y], destination: [0, y + rollH]
    };
    bar.shadowColor = new paper.Color(0, 0, 0, .35);
    bar.shadowBlur = 8; bar.shadowOffset = new paper.Point(0, 4);
    [-12, W - capW + 12].forEach(x => {
      const cap = new paper.Path.Rectangle({ point: [x, y - 3], size: [capW, capH], radius: capW/2 });
      cap.fillColor = {
        gradient: { stops: [['#eec27c', 0], ['#a06c38', .6], ['#6e4a26', 1]] },
        origin: [x, y - 3], destination: [x, y - 3 + capH]
      };
      r.addChild(cap);
    });
    const sheen = new paper.Path.Rectangle({ point: [16, y + 3], size: [W - 32, 4], radius: 2 });
    sheen.fillColor = new paper.Color(1, .94, .8, .35);
    r.addChildren([bar, sheen]);
    return r;
  }
  g.addChild(makeRoller(0));

  /* gem on the top roller */
  const gem = new paper.Path.Rectangle({ point: [W/2 - 5, rollH/2 - 5], size: [10, 10], radius: 2 });
  gem.fillColor = {
    gradient: { stops: [['#bcd8ff', 0], ['#3f6fd9', .6], ['#25439c', 1]] },
    origin: [W/2 - 5, rollH/2 - 5], destination: [W/2 + 5, rollH/2 + 5]
  };
  gem.rotate(45);
  gem.shadowColor = new paper.Color(.43, .63, 1, .8); gem.shadowBlur = 10;
  g.addChild(gem);

  const botY = parchTop + parchH - 6;
  g.addChild(makeRoller(botY));

  /* pendant under the bottom roller */
  const pend = new paper.Path.Rectangle({ point: [W/2 - 8, botY + rollH - 4], size: [16, 16], radius: 3 });
  pend.fillColor = {
    gradient: { stops: [['#eec27c', 0], ['#a06c38', .55], ['#6e4a26', 1]] },
    origin: [W/2 - 8, botY + rollH - 4], destination: [W/2 + 8, botY + rollH + 12]
  };
  pend.rotate(45);
  const pendCore = new paper.Path.Rectangle({ point: [W/2 - 3.5, botY + rollH + .5], size: [7, 7], radius: 1.5 });
  pendCore.fillColor = {
    gradient: { stops: [['#b9aaff', 0], ['#5a44c9', .65], ['#34267e', 1]] },
    origin: [W/2 - 3.5, botY + rollH + .5], destination: [W/2 + 3.5, botY + rollH + 7.5]
  };
  pendCore.rotate(45);
  pendCore.shadowColor = new paper.Color(.55, .43, 1, .8); pendCore.shadowBlur = 8;
  g.addChildren([pend, pendCore]);

  return g;
}

/* layout: 1 entry → upper-left corner; otherwise a grid of up to
   3 columns, spread evenly with ample space between scrolls */
function layoutGallery(){
  bg.activate(); galleryLayer.activate();
  galleryLayer.removeChildren();
  scrollItems.length = 0;
  hovered = null;
  bgLayer.activate();
  if (!archive.length) return;

  const vw = bg.view.size.width, vh = bg.view.size.height;
  const n = archive.length;
  const cols = Math.min(3, n);
  const rows = Math.ceil(n / cols);
  const mx = 80, myTop = 150, myBot = 60;   // top margin clears the page title

  galleryLayer.activate();
  archive.forEach((entry, i) => {
    const item = drawMiniScroll(entry);
    if (n === 1){
      item.position = new paper.Point(mx + item.bounds.width / 2,
                                      myTop + item.bounds.height / 2);
    } else {
      const col = i % cols, row = Math.floor(i / cols);
      const cellW = (vw - mx * 2) / cols;
      const cellH = (vh - myTop - myBot) / rows;
      const fit = Math.min(1, (cellW - 40) / item.bounds.width,
                              (cellH - 40) / item.bounds.height);
      if (fit < 1) item.scale(fit);
      item.position = new paper.Point(mx + cellW * col + cellW / 2,
                                      myTop + cellH * row + cellH / 2);
    }
    scrollItems.push({ item, entry });
  });
  bgLayer.activate();
}

/* gallery hover & click — the canvases are pointer-events:none, so we
   listen on the window and hit-test against each scroll's bounds */
window.addEventListener('mousemove', ev => {
  if (modalOpen) return;
  const p = new paper.Point(ev.clientX, ev.clientY);
  let hit = null;
  for (const s of scrollItems){ if (s.item.bounds.expand(8).contains(p)){ hit = s; break; } }
  if (hit !== hovered){
    if (hovered) hovered.item.scale(1 / 1.04);
    hovered = hit;
    if (hovered) hovered.item.scale(1.04);
  }
  document.body.style.cursor = hit ? 'pointer' : '';
});
window.addEventListener('click', ev => {
  if (modalOpen || ev.target.closest('button')) return;
  const p = new paper.Point(ev.clientX, ev.clientY);
  const hit = scrollItems.find(s => s.item.bounds.expand(8).contains(p));
  if (!hit) return;
  const e = hit.entry;
  const due = String(e.due || '').trim().toUpperCase();
  if (due === 'Y'){
    openModal(e, 'review');
  } else if (e.Deletion && e.Deletion.delete === true){
    openMsgModal(e, 'delete');      // straight to the recall panel
  } else if (e.ownership && String(e.ownership.transferTo || '').trim()){
    openMsgModal(e, 'transfer');    // straight to the withdraw panel
  } else if (e.Update && e.Update.submitted === true){
    openMsgModal(e, 'updpending');  // pending notice; more files via its button
  } else {
    openModal(e, 'info');
  }
});

/* ════════════════════════════════════════════════════════════════
   3 · Load the archive — sessionStorage first; on first load fetch
       project.json (the stand-in for the real API) and cache it
════════════════════════════════════════════════════════════════ */
function dueCount(){
  return archive.filter(a => String(a.due || '').trim().toUpperCase() === 'Y').length;
}
function hudSummary(){
  hudEl.innerHTML = `<b>${dueCount()}</b> of ${archive.length} Articles awaiting review`;
}

function bootArchive(data){
  archive = Array.isArray(data) ? data : [];
  hudSummary();
  layoutGallery();
}

function loadFromServer(){
  fetch('project.json')
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(data => {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({ v: STORE_VER, data }));
      bootArchive(data);
    })
    .catch(err => {
      hudEl.innerHTML = 'Articles · <b>Unreachable</b>';
      statusEl.hidden = false;
      statusEl.textContent = 'The articles could not be read — serve this folder over HTTP (e.g. "python app.py") and reload.';
      console.error('Failed to load project.json:', err);
    });
}

/* the cache is versioned — a stale or unversioned cache (e.g. stored
   before "lastmod" existed) is discarded and refetched */
const cached = sessionStorage.getItem(STORE_KEY);
let booted = false;
if (cached){
  try {
    const parsed = JSON.parse(cached);
    if (parsed && parsed.v === STORE_VER && Array.isArray(parsed.data)){
      bootArchive(parsed.data);
      booted = true;
    }
  } catch (e){ /* fall through to refetch */ }
}
if (!booted){
  sessionStorage.removeItem(STORE_KEY);
  loadFromServer();
}

/* redraw the gallery once the Cinzel webfont arrives, so titles render with it */
if (document.fonts && document.fonts.ready){
  document.fonts.ready.then(() => { if (archive.length) layoutGallery(); });
}

/* ════════════════════════════════════════════════════════════════
   4 · Arcane glyph text — regenerated each time a scroll is opened
════════════════════════════════════════════════════════════════ */
function renderGlyphs(){
  const svg = document.getElementById('glyphs');
  const W = 340, lineH = 21;
  let y = 10, paths = [];
  const strokes = [
    (x,y)=>`M${x} ${y} q4 -7 8 0`,                      // arch
    (x,y)=>`M${x} ${y} q3 6 6 0 q3 -6 6 0`,             // wave
    (x,y)=>`M${x} ${y-4} l7 7 M${x} ${y+3} l7 -7`,      // cross
    (x,y)=>`M${x} ${y} h8`,                             // dash
    (x,y)=>`M${x} ${y} q5 -8 10 0 t-4 5`,               // curl
    (x,y)=>`M${x+3} ${y-4} v8`,                         // tick
    (x,y)=>`M${x} ${y} a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0`  // ring
  ];
  for (let line = 0; line < 14; line++){
    if (line === 5 || line === 10){ y += lineH * 0.7; } // paragraph breaks
    const margin = 14 + Math.random() * 18;
    const end = W - 14 - Math.random() * (line % 4 === 3 ? 90 : 26);
    let x = margin, dd = '';
    while (x < end){
      dd += strokes[Math.floor(Math.random()*strokes.length)](x.toFixed(1), y) + ' ';
      x += 11 + Math.random() * 9;
    }
    paths.push(dd);
    y += lineH;
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${y}`);
  svg.innerHTML = paths.map((dd, i) =>
    `<path d="${dd}" fill="none" stroke="#caa45f" stroke-width="1.5"
       stroke-linecap="round" style="animation-delay:${(i*0.45).toFixed(2)}s"/>`).join('');
}

/* ════════════════════════════════════════════════════════════════
   5 · Modal threads — from the opened scroll to each choice card
════════════════════════════════════════════════════════════════ */
function anchors(i){
  const s = scrollEl.getBoundingClientRect();
  const target = modalMode === 'info' ? infoCardEl : cards[i];
  const c = target.getBoundingClientRect();
  const horizontal = window.innerWidth > 880;
  if (horizontal){
    const fr = modalMode === 'info' ? 0.42 : [0.16, 0.40, 0.60, 0.80][i];
    return {
      from: new paper.Point(s.right + 26, s.top + s.height * fr),
      to:   new paper.Point(c.left - 6,  c.top + c.height / 2),
      dir:  'h'
    };
  }
  const fr = modalMode === 'info' ? 0.5 : [0.18, 0.40, 0.62, 0.84][i];
  return {
    from: new paper.Point(s.left + s.width * fr, s.bottom + 18),
    to:   new paper.Point(c.left + c.width / 2, c.top - 6),
    dir:  'v'
  };
}

fx.activate();
const threads = cards.map((card, i) => {
  const path = new paper.Path({ strokeWidth: 1.5, strokeCap: 'round' });
  const startDot = new paper.Path.Circle({ center: [0,0], radius: 5, fillColor: GOLD,
    shadowColor: new paper.Color(1, .82, .45, .9), shadowBlur: 2 });
  const startRing = new paper.Path.Circle({ center: [0,0], radius: 5,
    strokeColor: new paper.Color(0.89, 0.73, 0.39, 0.5), strokeWidth: 1 });
  const endDot = new paper.Path.Circle({ center: [0,0], radius: 5.5, fillColor: ICE,
    shadowColor: new paper.Color(.56, .72, 1, .95), shadowBlur: 14 });
  const endCore = new paper.Path.Circle({ center: [0,0], radius: 2.2, fillColor: '#eaf2ff' });
  const spark = new paper.Path.Circle({ center: [0,0], radius: 2.6, fillColor: '#fff3d6',
    shadowColor: new paper.Color(1, .85, .5, 1), shadowBlur: 10, visible: false });
  const th = { path, startDot, startRing, endDot, endCore, spark,
    tension: 0, reveal: 0, delay: 0.35 + i * 0.22, sparkT: Math.random() };
  th.items = [path, startDot, startRing, endDot, endCore];
  th.items.forEach(o => o.visible = false);
  return th;
});
bg.activate();

/* geometry: rebuild each thread's curve every frame */
function shapeThread(th, i, time){
  const { from, to, dir } = anchors(i);
  const bob = reduceMotion ? 0 : Math.sin(time*0.9 + i*1.7) * 2.5 * (1 - th.tension*0.7);
  const sag = (reduceMotion ? 10 : 16 + Math.sin(time*0.7 + i*2.2) * 7) * (1 - th.tension*0.85);

  th.path.removeSegments();
  const p1 = from.add(dir === 'h' ? [0, bob] : [bob, 0]);
  const p2 = to;
  th.path.add(new paper.Segment(p1), new paper.Segment(p2));
  const d = p2.subtract(p1);
  if (dir === 'h'){
    th.path.segments[0].handleOut = new paper.Point(d.x * 0.45, sag);
    th.path.segments[1].handleIn  = new paper.Point(-d.x * 0.4, -sag * 0.4);
  } else {
    th.path.segments[0].handleOut = new paper.Point(sag, d.y * 0.45);
    th.path.segments[1].handleIn  = new paper.Point(-sag * 0.4, -d.y * 0.4);
  }

  th.startDot.position = p1; th.startRing.position = p1;
  th.endDot.position = p2;   th.endCore.position = p2;
  return { p1, p2 };
}

/* ════════════════════════════════════════════════════════════════
   6 · Per-frame animation
════════════════════════════════════════════════════════════════ */
fx.view.onFrame = (e) => {
  lastTime = e.time;
  if (!modalOpen) return;

  threads.forEach((th, i) => {
    if (modalMode === 'info' && i > 0) return;   // info mode draws one thread only
    const active = state.hover === i || state.selected === i;
    const goal = active ? 1 : 0;
    th.tension += (goal - th.tension) * (reduceMotion ? 1 : 0.12);

    const { p1, p2 } = shapeThread(th, i, e.time);
    const len = th.path.length;

    // staggered draw-on reveal, gated behind the unroll animation
    if (th.reveal < 1){
      const raw = reduceMotion ? 1 : Math.max(0, (e.time - modalT0 - th.delay) / 1.1);
      th.reveal = Math.min(1, raw);
      const ease = 1 - Math.pow(1 - th.reveal, 3);
      th.path.dashArray = [len * ease, len];
    } else {
      th.path.dashArray = null;
    }

    // colour: ice↔gold gradient, warming under tension
    const t = th.tension;
    const c1 = new paper.Color(0.89, 0.73 + t*0.06, 0.39);
    const c2 = new paper.Color(0.56 + t*0.33, 0.72 + t*0.04, 1 - t*0.55);
    th.path.strokeColor = {
      gradient: { stops: [[c1, 0], [c2, 1]] }, origin: p1, destination: p2
    };
    th.path.strokeWidth = 1.4 + t * 1.3;
    const dim = (state.selected !== -1 && state.selected !== i) ? 0.25 : 1;
    th.path.opacity = (0.65 + t * 0.35) * dim;
    [th.startDot, th.startRing, th.endDot, th.endCore].forEach(o => o.opacity = dim);
    th.startRing.scaling = 1 + Math.sin(e.time*2 + i)*0.08;

    // travelling spark when active
    if (active && th.reveal >= 1 && !reduceMotion){
      th.spark.visible = true;
      th.sparkT = (th.sparkT + e.delta * 0.45) % 1;
      th.spark.position = th.path.getPointAt(len * th.sparkT);
    } else {
      th.spark.visible = false;
    }
  });
};

bg.view.onFrame = (e) => {
  if (reduceMotion) return;
  const h = bg.view.size.height;
  motes.forEach(m => {
    m.item.position.y -= m.vy;
    if (m.item.position.y < -4) m.item.position.y = h + 4;
    m.item.opacity = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(e.time * 1.3 + m.ph));
  });
  sparkles.forEach(s => {
    const k = 0.55 + 0.45 * Math.sin(e.time * s.sp * 2 + s.ph);
    s.item.opacity = k * 0.85;
    s.item.rotate(0.15);
  });
};

/* ════════════════════════════════════════════════════════════════
   7 · Modal open / close — gallery blurs behind, parchment unrolls,
       choices fade in from the right, then the threads draw on
════════════════════════════════════════════════════════════════ */
const UNROLL = 1.0;   // seconds before the threads start revealing

function openModal(entry, mode = 'review'){
  modalOpen = true;
  modalMode = mode;
  currentEntry = entry;
  titleEl.textContent = entry.article;
  titleEl.href = articleUrl(entry);
  if (entry.ticket){
    ticketEl.textContent = entry.ticket;
    ticketEl.href = 'https://ticketdetails.com/t=' + encodeURIComponent(entry.ticket);
    ticketEl.hidden = false;
  } else {
    ticketEl.hidden = true;
  }
  renderGlyphs();

  state.hover = -1; state.selected = -1;
  cards.forEach(c => c.classList.remove('selected', 'dimmed'));
  statusEl.classList.remove('sealed');

  if (mode === 'info'){
    choicesEl.hidden = true;
    infoNavEl.hidden = false;
    lastModEl.textContent = 'Last Modified : ' + (entry.lastmod || '—');
    hudEl.innerHTML = `Articles · Ticket <b>${entry.ticket || '—'}</b> · Not Yet Due`;
    statusEl.textContent = 'This scroll rests until its appointed time…';
  } else {
    choicesEl.hidden = false;
    infoNavEl.hidden = true;
    hudEl.innerHTML = `Articles · Ticket <b>${entry.ticket || '—'}</b> · Awaiting Review`;
    statusEl.textContent = 'Choose the fate of this scroll…';
  }

  if (hovered){ hovered.item.scale(1 / 1.04); hovered = null; }
  document.body.style.cursor = '';

  overlayEl.classList.add('veiled');          // blur the gallery behind
  pageTitleEl.hidden = true;
  stageEl.hidden = false;
  stageEl.classList.add('opening');           // semi-open: title sliver only
  requestAnimationFrame(() => requestAnimationFrame(() => {
    stageEl.classList.remove('opening');
    stageEl.classList.add('open');            // unroll + choices fade in
  }));
  statusEl.hidden = false;

  modalT0 = lastTime + (reduceMotion ? 0 : UNROLL);
  threads.forEach((th, i) => {
    th.reveal = 0; th.tension = 0;
    th.path.dashArray = [0, 1];               // hidden until reveal begins
    const show = mode === 'review' || i === 0; // info mode: single thread
    th.items.forEach(o => o.visible = show);
  });
}

function closeModal(){
  modalOpen = false;
  stageEl.hidden = true;
  stageEl.classList.remove('open', 'opening');
  statusEl.hidden = true;
  threads.forEach(th => {
    th.items.forEach(o => o.visible = false);
    th.spark.visible = false;
  });
  overlayEl.classList.remove('veiled');       // gallery sharpens back
  pageTitleEl.hidden = false;
  hudSummary();
}

closerEl.addEventListener('click', closeModal);
window.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  if (updateOpen) closeUpdateModal();
  else if (modalOpen) closeModal();
});

/* ════════════════════════════════════════════════════════════════
   7b · The update scroll — a horizontal message scroll that unfurls
        sideways (msgscroll.jpg), carrying the SharePoint link and a
        drop zone for the user's offering of files
════════════════════════════════════════════════════════════════ */
function msgDims(){
  const vw = window.innerWidth, vh = window.innerHeight;
  return { W: Math.min(940, vw - 120), H: Math.min(600, vh - 170) };
}

function sizeUpdateBox(){
  const { W, H } = msgDims();
  updateBoxEl.style.width = W + 'px';
  updateBoxEl.style.height = H + 'px';
}

/* deterministic jitter so the torn parchment edge holds still per frame */
function jit(i){ const s = Math.sin(i * 127.1) * 43758.5453; return s - Math.floor(s); }

function drawMsgScroll(t){   // t = unfurl progress 0…1
  msg.activate();
  msg.project.activeLayer.removeChildren();
  if (!updateOpen) return;
  const vw = msg.view.size.width, vh = msg.view.size.height;
  const { W, H } = msgDims();
  const cx = vw / 2, cy = vh / 2;
  const half = 40 + (W / 2 - 40) * t;       // rolls spread outward from centre
  const left = cx - half, right = cx + half;
  const top = cy - H / 2 + 28, bot = cy + H / 2 - 28;

  /* aged parchment body — wavy torn edges that swell at the middle */
  const body = new paper.Path({ closed: true });
  const steps = 9;
  for (let i = 0; i <= steps; i++){
    const f = i / steps, x = left + (right - left) * f;
    body.add([x, top - 16 * Math.sin(Math.PI * f) + (jit(i) * 2 - 1) * 6]);
  }
  for (let i = 0; i <= steps; i++){
    const f = i / steps, x = right - (right - left) * f;
    body.add([x, bot + 16 * Math.sin(Math.PI * f) + (jit(i + 37) * 2 - 1) * 6]);
  }
  body.smooth({ type: 'catmull-rom', factor: 0.5 });
  body.fillColor = {
    gradient: {
      stops: [['#f9efd8', 0], ['#f2dfb9', .5], ['#e3c08c', .82], ['#c2925b', 1]],
      radial: true
    },
    origin: [cx, cy], destination: [cx, cy - H * 0.78]
  };
  body.strokeColor = '#6b4a2a'; body.strokeWidth = 2.5;
  body.shadowColor = new paper.Color(0, 0, 0, .45);
  body.shadowBlur = 30; body.shadowOffset = new paper.Point(0, 14);

  /* rolled side edges with curls top & bottom */
  function roll(x, side){
    const rw = 44;
    const bar = new paper.Path.Rectangle({
      point: [x - rw / 2, top - 18], size: [rw, bot - top + 36], radius: rw / 2 });
    bar.fillColor = {
      gradient: { stops: [['#6e4a26', 0], ['#c89a5e', .3], ['#a9743f', .6], ['#5d3d1e', 1]] },
      origin: [x - rw / 2, 0], destination: [x + rw / 2, 0]
    };
    bar.strokeColor = '#4a3015'; bar.strokeWidth = 1.5;
    bar.shadowColor = new paper.Color(0, 0, 0, .45);
    bar.shadowBlur = 12; bar.shadowOffset = new paper.Point(side * 4, 6);
  }
  roll(left - 12, -1);
  roll(right + 12, 1);
}

/* sideways unfurl, eased; the DOM content fades in once fully open */
msg.view.onFrame = (e) => {
  if (!updateOpen || unfurlT >= 1) return;
  unfurlT = Math.min(1, unfurlT + e.delta / 0.9);
  drawMsgScroll(1 - Math.pow(1 - unfurlT, 3));
  if (unfurlT >= 1) updateBoxEl.classList.add('shown');
};

/* the message scroll carries one of five content sets:
   'update'     → SharePoint link + file offering
   'updpending' → an update was already submitted (Vault Team reviewing)
   'confirm'    → "are you sure no update is needed?"
   'transfer'   → "pass this article to another" (uid search)
   'delete'     → "this article is not needed"                */
function openMsgModal(entry, kind){
  const wasOpen = updateOpen;   // already unfurled → just swap the content
  updateOpen = true;
  modalOpen = true;                          // keeps gallery clicks blocked
  currentEntry = entry;
  const url = articleUrl(entry);

  if (kind === 'confirm'){
    hudEl.innerHTML = `Articles · Ticket <b>${entry.ticket || '—'}</b> · Confirm No Update`;
    confirmUrlEl.textContent = url;
    confirmUrlEl.href = url;
    setConfirmStatus('');
    mindBtnEl.disabled = false;
    noUpdBtnEl.disabled = false;
  } else if (kind === 'transfer'){
    hudEl.innerHTML = `Articles · Ticket <b>${entry.ticket || '—'}</b> · Transfer Ownership`;
    resetTransferPanel(entry);
  } else if (kind === 'delete'){
    hudEl.innerHTML = `Articles · Ticket <b>${entry.ticket || '—'}</b> · Confirm Deletion`;
    deleteUrlEl.textContent = url;
    deleteUrlEl.href = url;
    resetDeletePanel(entry);
  } else if (kind === 'updpending'){
    hudEl.innerHTML = `Articles · Ticket <b>${entry.ticket || '—'}</b> · Update Submitted`;
  } else {
    hudEl.innerHTML = `Articles · Ticket <b>${entry.ticket || '—'}</b> · Submit Updates`;
    updUrlEl.textContent = url;
    updUrlEl.href = url;
    fileQueue.length = 0;
    sending = false;
    renderFileList();
    setUpdStatus('');
  }
  updateContentEl.hidden     = kind !== 'update';
  updPendingContentEl.hidden = kind !== 'updpending';
  confirmContentEl.hidden    = kind !== 'confirm';
  transferContentEl.hidden   = kind !== 'transfer';
  deleteContentEl.hidden     = kind !== 'delete';

  if (hovered){ hovered.item.scale(1 / 1.04); hovered = null; }
  document.body.style.cursor = '';

  overlayEl.classList.add('veiled');
  pageTitleEl.hidden = true;
  updateStageEl.hidden = false;
  sizeUpdateBox();
  if (wasOpen) return;
  updateBoxEl.classList.remove('shown');
  if (reduceMotion){
    unfurlT = 1; drawMsgScroll(1); updateBoxEl.classList.add('shown');
  } else {
    unfurlT = 0; drawMsgScroll(0);
  }
}

function closeUpdateModal(){
  updateOpen = false;
  modalOpen = false;
  updateStageEl.hidden = true;
  updateBoxEl.classList.remove('shown');
  msg.activate();
  msg.project.activeLayer.removeChildren();
  overlayEl.classList.remove('veiled');
  pageTitleEl.hidden = false;
  hudSummary();
}

/* review modal → message scroll: swap stages, keep the veil up */
function switchToMsg(entry, kind){
  stageEl.hidden = true;
  stageEl.classList.remove('open', 'opening');
  statusEl.hidden = true;
  threads.forEach(th => {
    th.items.forEach(o => o.visible = false);
    th.spark.visible = false;
  });
  openMsgModal(entry, kind);
}

updateCloserEl.addEventListener('click', closeUpdateModal);

/* ── confirm content: "No update needed" ── */
function setConfirmStatus(text, cls){
  confirmStatusEl.textContent = text;
  confirmStatusEl.classList.remove('sealed', 'error');
  if (cls) confirmStatusEl.classList.add(cls);
}

/* the decision is mirrored locally so the gallery reflects it at once */
function markNoUpdate(entry){
  entry.due = 'N';
  sessionStorage.setItem(STORE_KEY, JSON.stringify({ v: STORE_VER, data: archive }));
  layoutGallery();
}

mindBtnEl.addEventListener('click', () => {
  openMsgModal(currentEntry, 'update');     // scroll stays open, content swaps
});

/* ── pending-update content: documents already with the Vault Team ── */
closeUpdPendBtnEl.addEventListener('click', closeUpdateModal);
reviewSubmitBtnEl.addEventListener('click', () => {
  openMsgModal(currentEntry, 'update');     // scroll stays open, content swaps
});

/* ── transfer content: "I will pass this to another" ── */
const UID_RE = /^[A-Za-z]{2}\d{4}$/;
let foundPerson = null;   // { uid, name } returned by the last search

function setTransferStatus(text, cls){
  transferStatusEl.textContent = text;
  transferStatusEl.classList.remove('sealed', 'error');
  if (cls) transferStatusEl.classList.add(cls);
}

/* fresh panel each time the scroll opens; a pending transfer (recorded
   in entry.ownership) swaps the heading for the "already pending" block */
function resetTransferPanel(entry){
  uidInputEl.value = '';
  searchBtnEl.disabled = true;
  foundPerson = null;
  foundNameEl.hidden = true;
  transferNoteEl.hidden = true;
  confirmTransferBtnEl.hidden = true;
  confirmTransferBtnEl.disabled = false;
  withdrawBtnEl.disabled = false;
  setTransferStatus('');
  const own = entry.ownership;
  const pending = own && String(own.transferTo || '').trim() !== '';
  transferMsgEl.hidden = pending;
  pendingBoxEl.hidden = !pending;
  if (pending) pendingWhoEl.textContent = `${own.transferTo} — ${own.name || 'Unknown'}`;
}

/* persist locally; the server writes the same change into project.json.
   A pending transfer counts as due diligence done — withdrawing it
   makes the article due again. */
function markOwnership(entry, uid, name){
  entry.ownership = { transferTo: uid, name: name };
  entry.due = uid ? 'N' : 'Y';
  sessionStorage.setItem(STORE_KEY, JSON.stringify({ v: STORE_VER, data: archive }));
  layoutGallery();
}

uidInputEl.addEventListener('input', () => {
  searchBtnEl.disabled = !UID_RE.test(uidInputEl.value.trim());
});
uidInputEl.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && !searchBtnEl.disabled) searchBtnEl.click();
});

searchBtnEl.addEventListener('click', () => {
  const uid = uidInputEl.value.trim().toLowerCase();
  if (!UID_RE.test(uid) || sending) return;
  sending = true;
  searchBtnEl.disabled = true;
  foundNameEl.hidden = true;
  transferNoteEl.hidden = true;
  confirmTransferBtnEl.hidden = true;
  setTransferStatus('Consulting the registry…');
  fetch('/api/uidsearch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid })
  })
    .then(r => r.json().then(j => ({ ok: r.ok, j })).catch(() => ({ ok: r.ok, j: {} })))
    .then(({ ok, j }) => {
      if (!ok || !j.name) throw new Error(j.error || 'No one answers to that uid.');
      foundPerson = { uid, name: j.name };
      foundNameEl.textContent = `${uid} — ${j.name}`;
      foundNameEl.hidden = false;
      transferNoteEl.hidden = false;
      confirmTransferBtnEl.hidden = false;
      setTransferStatus('');
    })
    .catch(err => setTransferStatus(String(err.message || err), 'error'))
    .finally(() => {
      sending = false;
      searchBtnEl.disabled = !UID_RE.test(uidInputEl.value.trim());
    });
});

confirmTransferBtnEl.addEventListener('click', () => {
  if (!foundPerson || sending) return;
  sending = true;
  confirmTransferBtnEl.disabled = true;
  setTransferStatus('Sending the request…');
  fetch('/api/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: currentEntry.id,
      article: currentEntry.article,
      ticket: currentEntry.ticket,
      transferTo: foundPerson.uid,
      name: foundPerson.name
    })
  })
    .then(r => r.json().then(j => ({ ok: r.ok, j })).catch(() => ({ ok: r.ok, j: {} })))
    .then(({ ok, j }) => {
      if (!ok) throw new Error(j.error || 'The Vault could not record the transfer.');
      markOwnership(currentEntry, foundPerson.uid, foundPerson.name);
      setTransferStatus(`✦ The request has been sent — awaiting acceptance from ${foundPerson.name}.`, 'sealed');
      setTimeout(() => { if (updateOpen) closeUpdateModal(); }, 1500);
    })
    .catch(err => {
      setTransferStatus(String(err.message || err), 'error');
      confirmTransferBtnEl.disabled = false;
    })
    .finally(() => { sending = false; });
});

withdrawBtnEl.addEventListener('click', () => {
  if (sending) return;
  sending = true;
  withdrawBtnEl.disabled = true;
  setTransferStatus('Withdrawing the request…');
  fetch('/api/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: currentEntry.id,
      article: currentEntry.article,
      ticket: currentEntry.ticket,
      transferTo: '',
      name: ''
    })
  })
    .then(r => r.json().then(j => ({ ok: r.ok, j })).catch(() => ({ ok: r.ok, j: {} })))
    .then(({ ok, j }) => {
      if (!ok) throw new Error(j.error || 'The Vault could not withdraw the request.');
      markOwnership(currentEntry, '', '');
      resetTransferPanel(currentEntry);
      setTransferStatus('✦ The transfer request has been withdrawn.', 'sealed');
    })
    .catch(err => {
      setTransferStatus(String(err.message || err), 'error');
      withdrawBtnEl.disabled = false;
    })
    .finally(() => { sending = false; });
});

noUpdBtnEl.addEventListener('click', () => {
  if (sending) return;
  sending = true;
  mindBtnEl.disabled = true;
  noUpdBtnEl.disabled = true;
  setConfirmStatus('Sealing your decision…');
  fetch('/api/noupdate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: currentEntry.id,
      article: currentEntry.article,
      ticket: currentEntry.ticket
    })
  })
    .then(r => r.json().then(j => ({ ok: r.ok, j })).catch(() => ({ ok: r.ok, j: {} })))
    .then(({ ok, j }) => {
      if (!ok) throw new Error(j.error || 'The Vault could not record the decision.');
      markNoUpdate(currentEntry);
      setConfirmStatus('✦ The scroll is sealed — no update needed.', 'sealed');
      setTimeout(() => { if (updateOpen) closeUpdateModal(); }, 1200);
    })
    .catch(err => {
      setConfirmStatus(String(err.message || err), 'error');
      mindBtnEl.disabled = false;
      noUpdBtnEl.disabled = false;
    })
    .finally(() => { sending = false; });
});

/* ── delete content: "This article is not needed" ── */
function setDeleteStatus(text, cls){
  deleteStatusEl.textContent = text;
  deleteStatusEl.classList.remove('sealed', 'error');
  if (cls) deleteStatusEl.classList.add(cls);
}

/* a pending deletion (entry.Deletion.delete === true) swaps the
   question for the "already submitted" message and Close/Recall */
function resetDeletePanel(entry){
  const pending = !!(entry.Deletion && entry.Deletion.delete === true);
  deleteMsgEl.hidden = pending;
  deletePendingMsgEl.hidden = !pending;
  deleteBtnsEl.hidden = pending;
  recallBtnsEl.hidden = !pending;
  cancelDelBtnEl.disabled = false;
  delBtnEl.disabled = false;
  closeDelBtnEl.disabled = false;
  recallBtnEl.disabled = false;
  setDeleteStatus('');
}

/* persist locally; the server writes the same change into project.json.
   A pending deletion counts as due diligence done — recalling it
   makes the article due again. */
function markDeletion(entry, del){
  entry.Deletion = { ticket: entry.ticket || '', delete: del };
  entry.due = del ? 'N' : 'Y';
  sessionStorage.setItem(STORE_KEY, JSON.stringify({ v: STORE_VER, data: archive }));
  layoutGallery();
}

function postDeletion(del, busyText, sealText, buttons){
  if (sending) return;
  sending = true;
  buttons.forEach(b => b.disabled = true);
  setDeleteStatus(busyText);
  fetch('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: currentEntry.id,
      articlename: currentEntry.article,
      ticket: currentEntry.ticket,
      delete: del
    })
  })
    .then(r => r.json().then(j => ({ ok: r.ok, j })).catch(() => ({ ok: r.ok, j: {} })))
    .then(({ ok, j }) => {
      if (!ok) throw new Error(j.error || 'The Vault could not record the request.');
      markDeletion(currentEntry, del);
      setDeleteStatus(sealText, 'sealed');
      setTimeout(() => { if (updateOpen) closeUpdateModal(); }, 1200);
    })
    .catch(err => {
      setDeleteStatus(String(err.message || err), 'error');
      buttons.forEach(b => b.disabled = false);
    })
    .finally(() => { sending = false; });
}

cancelDelBtnEl.addEventListener('click', closeUpdateModal);
closeDelBtnEl.addEventListener('click', closeUpdateModal);

delBtnEl.addEventListener('click', () =>
  postDeletion(true,
    'Submitting the scroll for deletion…',
    '✦ The scroll has been submitted for deletion — the Vault will review it.',
    [cancelDelBtnEl, delBtnEl]));

recallBtnEl.addEventListener('click', () =>
  postDeletion(false,
    'Recalling the deletion request…',
    '✦ The deletion request has been recalled.',
    [closeDelBtnEl, recallBtnEl]));

/* persist locally; the server writes the same change into project.json.
   A submitted update counts as due diligence done. */
function markUpdateSubmitted(entry){
  entry.Update = { ticket: entry.ticket || '', submitted: true };
  entry.due = 'N';
  sessionStorage.setItem(STORE_KEY, JSON.stringify({ v: STORE_VER, data: archive }));
  layoutGallery();
}

/* ── file queue: validate, list, remove, send ── */
const OK_FILE = /\.(docx|xlsx|pdf|jpe?g|bmp|png)$/i;

function fmtSize(b){
  return b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB'
                     : (b / 1048576).toFixed(1) + ' MB';
}

function setUpdStatus(text, cls){
  updStatusEl.textContent = text;
  updStatusEl.classList.remove('sealed', 'error');
  if (cls) updStatusEl.classList.add(cls);
}

function renderFileList(){
  fileListEl.innerHTML = '';
  fileQueue.forEach((f, idx) => {
    const li = document.createElement('li');
    const nm = document.createElement('span');
    nm.className = 'fname'; nm.textContent = f.name; nm.title = f.name;
    const sz = document.createElement('span');
    sz.className = 'fsize'; sz.textContent = fmtSize(f.size);
    const rm = document.createElement('button');
    rm.className = 'frm'; rm.type = 'button'; rm.textContent = '✕'; rm.title = 'Remove';
    rm.addEventListener('click', () => { fileQueue.splice(idx, 1); renderFileList(); });
    li.append(nm, sz, rm);
    fileListEl.appendChild(li);
  });
  sendBtnEl.disabled = !fileQueue.length || sending;
}

function addFiles(list){
  const rejected = [];
  [...list].forEach(f => {
    if (!OK_FILE.test(f.name)){ rejected.push(f.name); return; }
    if (fileQueue.some(q => q.name === f.name && q.size === f.size)) return;
    fileQueue.push(f);
  });
  renderFileList();
  if (rejected.length){
    setUpdStatus('Not accepted: ' + rejected.join(', ') +
      ' — only .docx, .xlsx, .pdf, .jpg, .bmp or .png.', 'error');
  } else {
    setUpdStatus('');
  }
}

browseBtnEl.addEventListener('click', () => fileInputEl.click());
fileInputEl.addEventListener('change', () => {
  addFiles(fileInputEl.files);
  fileInputEl.value = '';
});

['dragenter', 'dragover'].forEach(evName =>
  dropZoneEl.addEventListener(evName, ev => {
    ev.preventDefault();
    dropZoneEl.classList.add('drag');
  }));
dropZoneEl.addEventListener('dragleave', () => dropZoneEl.classList.remove('drag'));
dropZoneEl.addEventListener('drop', ev => {
  ev.preventDefault();
  dropZoneEl.classList.remove('drag');
  if (ev.dataTransfer && ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
});
/* a stray drop outside the zone must not navigate away from the page */
window.addEventListener('dragover', ev => { if (updateOpen) ev.preventDefault(); });
window.addEventListener('drop',     ev => { if (updateOpen) ev.preventDefault(); });

sendBtnEl.addEventListener('click', () => {
  if (!fileQueue.length || sending) return;
  sending = true;
  sendBtnEl.disabled = true;
  setUpdStatus('Sending your offering to the Vault…');
  const fd = new FormData();
  fd.append('ticket', (currentEntry && currentEntry.ticket) || 'unknown');
  fd.append('id', (currentEntry && currentEntry.id) || '');
  fileQueue.forEach(f => fd.append('files', f, f.name));
  fetch('/api/upload', { method: 'POST', body: fd })
    .then(r => r.json().then(j => ({ ok: r.ok, j })).catch(() => ({ ok: r.ok, j: {} })))
    .then(({ ok, j }) => {
      if (!ok) throw new Error(j.error || 'The Vault rejected the offering.');
      fileQueue.length = 0;
      renderFileList();
      markUpdateSubmitted(currentEntry);
      setUpdStatus('✦ Your offering has been received. A Vault representative will review your changes.', 'sealed');
    })
    .catch(err => {
      setUpdStatus(String(err.message || err), 'error');
      sendBtnEl.disabled = !fileQueue.length;
    })
    .finally(() => { sending = false; });
});

/* ════════════════════════════════════════════════════════════════
   8 · Choice interaction wiring — each choice leads to its own
       content set on the message scroll
════════════════════════════════════════════════════════════════ */
const CHOICE_KIND = ['update', 'confirm', 'transfer', 'delete'];
cards.forEach((card, i) => {
  card.addEventListener('mouseenter', () => state.hover = i);
  card.addEventListener('mouseleave', () => state.hover = -1);
  card.addEventListener('focus',      () => state.hover = i);
  card.addEventListener('blur',       () => state.hover = -1);
  card.addEventListener('click', () => switchToMsg(currentEntry, CHOICE_KIND[i]));
});

/* ════════════════════════════════════════════════════════════════
   9 · Resize
════════════════════════════════════════════════════════════════ */
function onResize(){
  bg.view.viewSize = new paper.Size(window.innerWidth, window.innerHeight);
  fx.view.viewSize = new paper.Size(window.innerWidth, window.innerHeight);
  msg.view.viewSize = new paper.Size(window.innerWidth, window.innerHeight);
  drawFlourishes();
  seedAmbient();
  layoutGallery();
  if (updateOpen){
    sizeUpdateBox();
    drawMsgScroll(unfurlT >= 1 ? 1 : 1 - Math.pow(1 - unfurlT, 3));
  }
}
window.addEventListener('resize', onResize);
onResize();

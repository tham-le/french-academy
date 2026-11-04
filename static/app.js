/* French Academy B1 to C1: single page client. No build step. */
'use strict';

// ---------- utils
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SKILL_VI = { listening: 'Compréhension orale', reading: 'Compréhension écrite', speaking: 'Expression orale', writing: 'Expression écrite' };
const SKILL_COLOR = { listening: 'var(--s1)', reading: 'var(--s2)', speaking: 'var(--s3)', writing: 'var(--s4)' };
const ACTIVITY_VI = { grammar: 'Grammaire', vocab: 'Vocabulaire', listening: 'Compréhension orale', reading: 'Compréhension écrite', speaking: 'Expression orale', writing: 'Expression écrite', review: 'Révision' };
const CAT_VI = { subjonctif: 'Subjonctif', accord_participe_passe: 'Accord du participe passé', pronoms_relatifs: 'Pronoms relatifs', conditionnel: 'Conditionnel', passe_compose_imparfait: 'Passé composé / imparfait', futur: 'Futur', articles: 'Articles', prepositions: 'Prépositions', pronoms_cod_coi: 'Pronoms COD / COI', negation: 'Négation', genre_nombre: 'Genre et nombre', concordance_temps: 'Concordance des temps', connecteurs: 'Connecteurs', lexique: 'Lexique', orthographe: 'Orthographe', syntaxe: 'Syntaxe', registre: 'Registre', autre: 'Autre' };
const CONF_VI = { none: 'chưa có dữ liệu', low: 'thấp', medium: 'trung bình', high: 'cao' };
const catName = c => CAT_VI[c] || c;

function md(text) {
  const lines = esc(text || '').split('\n');
  let html = '', list = null, para = [];
  const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3}) (.*)/);
    const ul = line.match(/^[-*] (.*)/);
    const ol = line.match(/^\d+[.)] (.*)/);
    if (h) { flushPara(); closeList(); html += `<h3>${inline(h[2])}</h3>`; }
    else if (ul || ol) { flushPara(); const tag = ul ? 'ul' : 'ol'; if (list !== tag) { closeList(); html += `<${tag}>`; list = tag; } html += `<li>${inline((ul || ol)[1])}</li>`; }
    else if (!line.trim()) { flushPara(); closeList(); }
    else { if (list) closeList(); para.push(line); }
  }
  flushPara(); closeList();
  return `<div class="md">${html}</div>`;
  function inline(s) {
    return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/`(.+?)`/g, '<code>$1</code>');
  }
}

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

async function api(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  let data = {};
  try { data = await r.json(); } catch (e) { data = { error: 'Phản hồi không hợp lệ' }; }
  if (r.status === 401 && path !== '/api/me' && path !== '/api/login') { me = null; location.hash = '#/login'; }
  if (!r.ok) throw new Error(data.error || `Lỗi ${r.status}`);
  return data;
}
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
const fmtDT = iso => iso ? new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const fmtH = m => m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} phút`;
const pct = v => v == null ? '–' : `${Math.round(v)}`;
const trendTxt = t => t == null ? '' : t > 0 ? `▲ ${t}` : t < 0 ? `▼ ${Math.abs(t)}` : '＝';
function levelBadge(l) { return l ? `<span class="badge level">${esc(l)}</span>` : '<span class="badge">chưa đủ dữ liệu</span>'; }
function confBadge(c) { const cls = c === 'high' ? 'ok' : c === 'medium' ? 'warn' : 'bad'; return `<span class="badge ${cls}">tin cậy ${CONF_VI[c] || c}</span>`; }

// ---------- state and timer
let me = null;
const Timer = {
  activity: null, skill: null, lessonId: null, acc: 0, last: null, lastInput: Date.now(),
  set(activity, skill = null, lessonId = null) {
    if (this.activity !== activity || this.lessonId !== lessonId) this.flush();
    this.activity = activity; this.skill = skill; this.lessonId = lessonId; this.last = Date.now();
  },
  stop() { this.flush(); this.activity = null; },
  tick() {
    if (!this.activity || !this.last) return;
    const now = Date.now();
    if (document.visibilityState === 'visible' && now - this.lastInput < 5 * 60e3) this.acc += (now - this.last) / 1000;
    this.last = now;
    if (this.acc >= 60) this.flush();
  },
  flush(beacon = false) {
    this.tick0();
    const secs = Math.round(this.acc);
    if (!me || !this.activity || secs < 5) { this.acc = 0; return; }
    const body = { activity: this.activity, skill: this.skill, lesson_id: this.lessonId, seconds: Math.min(3600, secs) };
    this.acc = 0;
    if (beacon) navigator.sendBeacon('/api/study', new Blob([JSON.stringify(body)], { type: 'application/json' }));
    else api('POST', '/api/study', body).catch(() => {});
  },
  tick0() { if (this.activity && this.last) { const now = Date.now(); if (document.visibilityState === 'visible' && now - this.lastInput < 5 * 60e3) this.acc += (now - this.last) / 1000; this.last = now; } },
};
setInterval(() => Timer.tick(), 15000);
['keydown', 'pointerdown', 'scroll'].forEach(ev => document.addEventListener(ev, () => { Timer.lastInput = Date.now(); }, { passive: true }));
window.addEventListener('beforeunload', () => Timer.flush(true));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') Timer.flush(true); else Timer.last = Date.now(); });

// ---------- speech
let frVoice = null;
function pickVoice() { const vs = speechSynthesis.getVoices(); frVoice = vs.find(v => v.lang === 'fr-FR') || vs.find(v => v.lang.startsWith('fr')) || null; }
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text, rate = 0.95) {
  if (!('speechSynthesis' in window)) { toast('Trình duyệt không hỗ trợ đọc văn bản'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.lang = 'fr-FR'; u.rate = rate; if (frVoice) u.voice = frVoice;
  speechSynthesis.speak(u);
}
const stopSpeak = () => { if ('speechSynthesis' in window) speechSynthesis.cancel(); };
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function makeRecorder(el, { maxSeconds = 600, onStop } = {}) {
  el.innerHTML = `<div class="rec">
    <button class="primary" data-act="start">● Bắt đầu nói</button>
    <button data-act="stop" disabled>■ Dừng</button>
    <span class="time">00:00</span><span class="state muted"></span></div>
    <p class="muted small">${SR ? 'Nhận dạng giọng nói fr-FR của trình duyệt (Chrome, Edge). Bạn có thể sửa transcript trước khi nộp.' : 'Trình duyệt này không có nhận dạng giọng nói: hãy ghi âm rồi gõ lại lời bạn nói vào ô dưới.'}</p>
    <textarea class="transcript" placeholder="Transcript sẽ hiện ở đây..."></textarea>`;
  const startBtn = $('[data-act=start]', el), stopBtn = $('[data-act=stop]', el), timeEl = $('.time', el), stateEl = $('.state', el), ta = $('.transcript', el);
  let rec = null, chunks = [], sr = null, running = false, t0 = 0, tick = null, finalText = '', blob = null, seconds = 0;
  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  async function start() {
    finalText = ta.value ? ta.value + ' ' : ''; blob = null; chunks = []; running = true; t0 = Date.now();
    startBtn.disabled = true; stopBtn.disabled = false; stateEl.innerHTML = '<span class="rec-dot"></span> đang ghi';
    tick = setInterval(() => { seconds = Math.round((Date.now() - t0) / 1000); timeEl.textContent = fmt(seconds); if (seconds >= maxSeconds) stop(); }, 500);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rec = new MediaRecorder(stream); rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = () => { blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }); stream.getTracks().forEach(t => t.stop()); };
      rec.start(1000);
    } catch (e) { stateEl.textContent = 'không có micro, chỉ ghi transcript'; }
    if (SR) {
      sr = new SR(); sr.lang = 'fr-FR'; sr.continuous = true; sr.interimResults = true;
      sr.onresult = ev => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const t = ev.results[i][0].transcript;
          if (ev.results[i].isFinal) finalText += t.trim() + ' '; else interim += t;
        }
        ta.value = finalText + interim;
      };
      sr.onend = () => { if (running) { try { sr.start(); } catch (e) { /* restart race */ } } };
      sr.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') stateEl.textContent = 'nhận dạng lỗi: ' + e.error; };
      try { sr.start(); } catch (e) { /* already started */ }
    }
  }
  function stop() {
    if (!running) return; running = false; clearInterval(tick);
    seconds = Math.max(1, Math.round((Date.now() - t0) / 1000)); timeEl.textContent = fmt(seconds);
    startBtn.disabled = false; stopBtn.disabled = true; stateEl.textContent = 'đã dừng';
    if (sr) { try { sr.stop(); } catch (e) { /* ignore */ } }
    if (rec && rec.state !== 'inactive') rec.stop();
    if (onStop) setTimeout(onStop, 300);
  }
  startBtn.onclick = start; stopBtn.onclick = stop;
  return {
    transcript: () => ta.value.trim(), stop, running: () => running,
    // typed transcript without a recording: estimate the length at 2.2 words per second
    seconds: () => seconds || Math.max(5, Math.round(ta.value.trim().split(/\s+/).filter(Boolean).length / 2.2)),
    reset() { ta.value = ''; finalText = ''; blob = null; seconds = 0; timeEl.textContent = '00:00'; },
    audioB64: () => new Promise(res => {
      if (!blob || blob.size === 0 || blob.size > 10 * 1024 * 1024) return res(null);
      const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob);
    }),
  };
}

// ---------- charts (inline SVG, validated palette, hover tooltip)
const tip = $('#tooltip');
function showTip(ev, text) { tip.textContent = text; tip.hidden = false; moveTip(ev); }
function moveTip(ev) { tip.style.left = (ev.clientX + 12) + 'px'; tip.style.top = (ev.clientY - 28) + 'px'; }
function hideTip() { tip.hidden = true; }

function barChart(el, data, { height = 170, color = 'var(--s1)', unit = '', labelEvery = null } = {}) {
  const W = 640, H = height, padL = 34, padB = 22, padT = 8;
  const max = Math.max(10, ...data.map(d => d.value || 0));
  const n = data.length || 1, slot = (W - padL) / n, bw = Math.min(24, slot * 0.6), r = 4;
  const y = v => padT + (H - padT - padB) * (1 - v / max);
  const every = labelEvery || Math.ceil(n / 8);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img"><g class="grid">`;
  for (let i = 0; i <= 3; i++) { const v = max * i / 3, yy = y(v); s += `<line x1="${padL}" x2="${W}" y1="${yy}" y2="${yy}"/><text x="${padL - 4}" y="${yy + 4}" text-anchor="end">${Math.round(v)}</text>`; }
  s += '</g>';
  data.forEach((d, i) => {
    const x = padL + slot * i + (slot - bw) / 2, v = d.value || 0, top = y(v), base = y(0), h = Math.max(0, base - top);
    const rr = Math.min(r, h);
    const path = h > 0 ? `M${x},${base} V${top + rr} a${rr},${rr} 0 0 1 ${rr},-${rr} h${bw - 2 * rr} a${rr},${rr} 0 0 1 ${rr},${rr} V${base} Z` : '';
    s += `<rect x="${padL + slot * i}" y="${padT}" width="${slot}" height="${H - padT - padB}" fill="transparent" data-i="${i}"/>`;
    if (path) s += `<path d="${path}" fill="${color}" data-i="${i}" pointer-events="none"/>`;
    if (i % every === 0) s += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  s += '</svg>';
  el.classList.add('chart'); el.innerHTML = s;
  $$('rect[data-i]', el).forEach(rect => {
    const d = data[+rect.dataset.i];
    rect.addEventListener('mouseenter', ev => showTip(ev, `${d.full || d.label}: ${d.value}${unit}`));
    rect.addEventListener('mousemove', moveTip); rect.addEventListener('mouseleave', hideTip);
  });
}

function lineChart(el, series, { height = 220, yMax = 100 } = {}) {
  const W = 640, H = height, padL = 34, padR = 110, padB = 22, padT = 10;
  const xs = Array.from(new Set(series.flatMap(sr => sr.points.map(p => p.x)))).sort();
  if (!xs.length) { el.innerHTML = '<p class="muted">Chưa có dữ liệu.</p>'; return; }
  const xi = Object.fromEntries(xs.map((x, i) => [x, i]));
  const X = x => padL + (xs.length === 1 ? (W - padL - padR) / 2 : (W - padL - padR) * xi[x] / (xs.length - 1));
  const Y = v => padT + (H - padT - padB) * (1 - v / yMax);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img"><g class="grid">`;
  for (let i = 0; i <= 4; i++) { const v = yMax * i / 4, yy = Y(v); s += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/><text x="${padL - 4}" y="${yy + 4}" text-anchor="end">${v}</text>`; }
  s += '</g>';
  const every = Math.ceil(xs.length / 6);
  xs.forEach((x, i) => { if (i % every === 0 || i === xs.length - 1) s += `<text x="${X(x)}" y="${H - 6}" text-anchor="middle">${esc(x.slice(5))}</text>`; });
  const labels = [];
  series.forEach(sr => {
    if (!sr.points.length) return;
    const pts = sr.points.map(p => `${X(p.x)},${Y(p.y)}`).join(' ');
    s += `<polyline points="${pts}" fill="none" stroke="${sr.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    sr.points.forEach(p => { s += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="4" fill="${sr.color}" stroke="var(--surface)" stroke-width="2" data-t="${esc(sr.name)} ${p.x}: ${p.y}"/>`; });
    const last = sr.points[sr.points.length - 1];
    labels.push({ y: Y(last.y), text: `${sr.name} ${last.y}`, color: sr.color });
  });
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
  labels.forEach(l => { s += `<text x="${W - padR + 8}" y="${l.y + 4}" style="fill:var(--ink-2)">${esc(l.text)}</text>`; });
  s += '</svg>';
  el.classList.add('chart'); el.innerHTML = s + `<div class="legend">${series.map(sr => `<span><i style="background:${sr.color}"></i>${esc(sr.name)}</span>`).join('')}</div>`;
  $$('circle[data-t]', el).forEach(c => { c.addEventListener('mouseenter', ev => showTip(ev, c.dataset.t)); c.addEventListener('mousemove', moveTip); c.addEventListener('mouseleave', hideTip); });
}

function dataTable(rows, cols) {
  return `<details class="small"><summary class="muted">Xem dạng bảng</summary><table><tr>${cols.map(c => `<th>${esc(c[1])}</th>`).join('')}</tr>${rows.map(r => `<tr>${cols.map(c => `<td>${esc(r[c[0]] ?? '')}</td>`).join('')}</tr>`).join('')}</table></details>`;
}

// ---------- questions
function renderQuestions(questions, prefix = 'q') {
  return questions.map((q, i) => {
    const name = `${prefix}-${q.id}`;
    let body = '';
    if (q.type === 'mcq') body = q.options.map((o, j) => `<label class="opt"><input type="radio" name="${name}" value="${j}">${esc(o)}</label>`).join('');
    else if (q.type === 'gap') body = `<input class="gap" type="text" name="${name}" autocomplete="off" placeholder="…">`;
    else if (q.type === 'truefalse') body = `<label class="opt"><input type="radio" name="${name}" value="true">Vrai</label><label class="opt"><input type="radio" name="${name}" value="false">Faux</label>`;
    return `<div class="q" data-qid="${esc(q.id)}"><div class="stem"><b>${i + 1}.</b> ${esc(q.q).replace(/___/g, '<u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u>')}</div>${body}<div class="feedback"></div></div>`;
  }).join('');
}
function collectAnswers(container, questions, prefix = 'q') {
  const out = {};
  for (const q of questions) {
    const name = `${prefix}-${q.id}`;
    if (q.type === 'gap') { const v = $(`input[name="${name}"]`, container); if (v && v.value.trim()) out[q.id] = v.value.trim(); }
    else { const v = $(`input[name="${name}"]:checked`, container); if (v) out[q.id] = q.type === 'mcq' ? +v.value : v.value === 'true'; }
  }
  return out;
}
function showResults(container, questions, results) {
  for (const r of results) {
    const q = questions.find(x => x.id === r.id), box = $(`.q[data-qid="${CSS.escape(r.id)}"]`, container);
    if (!box) continue;
    box.classList.add(r.ok ? 'ok' : 'bad');
    let ans = r.answer;
    if (q.type === 'mcq') ans = q.options[r.answer]; else if (q.type === 'gap') ans = r.answer.join(' / '); else if (q.type === 'truefalse') ans = r.answer ? 'Vrai' : 'Faux';
    $('.feedback', box).innerHTML = `<div class="explain">${r.ok ? '<b>Đúng.</b>' : `<b>Sai.</b> Đáp án: <b>${esc(ans)}</b>.`} ${esc(r.explain)}</div>`;
    $$('input', box).forEach(i => { i.disabled = true; });
  }
}

// ---------- router
const routes = {};
function route(name, fn) { routes[name] = fn; }
async function render() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const name = parts[0] || '';
  $('#sidebar').classList.remove('open');
  stopSpeak();
  if (!me && !['', 'login', 'register'].includes(name)) { location.hash = '#/login'; return; }
  if (me && ['', 'login', 'register'].includes(name)) { location.hash = me.profile.onboarded ? '#/dashboard' : '#/onboarding'; return; }
  $$('.sidebar a[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
  const fn = routes[name] || routes.notfound;
  Timer.set(null);
  view.innerHTML = '<p class="muted">Đang tải…</p>';
  try { await fn(parts.slice(1)); window.scrollTo(0, 0); }
  catch (e) { view.innerHTML = `<div class="card"><b>Lỗi:</b> ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', render);
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
$('#logoutLink').onclick = async e => { e.preventDefault(); Timer.flush(); await api('POST', '/api/logout', {}); me = null; location.hash = '#/'; render(); };

async function loadMe() {
  try { me = await api('GET', '/api/me'); } catch (e) { me = null; }
  const b = $('#aiBadge');
  if (me) { b.textContent = me.ai.mock ? 'AI: mô phỏng' : `AI: ${me.ai.model}`; b.classList.toggle('mock', me.ai.mock); b.hidden = false; } else b.hidden = true;
  document.body.classList.toggle('logged-in', !!me);
}

route('notfound', async () => { view.innerHTML = '<div class="card">Không có trang này.</div>'; });

// ---------- auth pages
route('', async () => {
  view.innerHTML = `<div class="landing">
    <h1>French Academy</h1>
    <p>Lộ trình 12 tháng từ B1 lên C1: bài học theo module, AI tutor luyện nói và viết, theo dõi năng lực từng kỹ năng theo CEFR. Học liệu miễn phí, dữ liệu học lưu trên máy bạn.</p>
    <p class="row" style="justify-content:center"><a class="btn primary" href="#/register">Tạo tài khoản</a><a class="btn" href="#/login">Đăng nhập</a></p>
    <div class="grid c3" style="text-align:left;margin-top:40px">
      <div class="tile"><b>Lộ trình cá nhân</b><p class="muted small">Bài kiểm tra đầu vào, kỹ năng yếu được ưu tiên, bài ôn tự đề xuất khi một lỗi lặp lại.</p></div>
      <div class="tile"><b>Speaking Lab</b><p class="muted small">Ghi âm, transcript, phản hồi AI theo tiêu chí: trôi chảy, ngữ pháp, từ vựng, lập luận.</p></div>
      <div class="tile"><b>Tiến độ khác năng lực</b><p class="muted small">Hoàn thành bài không đồng nghĩa đạt B2. Trình độ chỉ ước tính từ các bài đánh giá thật, kèm độ tin cậy.</p></div>
    </div></div>`;
});
function authForm(kind) {
  const isReg = kind === 'register';
  view.innerHTML = `<div class="card" style="max-width:420px;margin:40px auto"><h1>${isReg ? 'Tạo tài khoản' : 'Đăng nhập'}</h1>
    <form id="authForm"><label>Tên đăng nhập</label><input name="username" required autocomplete="username" pattern="[A-Za-z0-9_]{3,32}">
    <label>Mật khẩu${isReg ? ' (ít nhất 8 ký tự)' : ''}</label><input name="password" type="password" required minlength="8" autocomplete="${isReg ? 'new-password' : 'current-password'}">
    ${isReg ? '<label>Mã mời (nếu server yêu cầu)</label><input name="invite" autocomplete="off">' : ''}
    <p><button class="primary" type="submit">${isReg ? 'Tạo tài khoản' : 'Đăng nhập'}</button></p>
    <p class="muted small">${isReg ? 'Đã có tài khoản? <a href="#/login">Đăng nhập</a>' : 'Chưa có tài khoản? <a href="#/register">Tạo tài khoản</a>'}</p></form></div>`;
  $('#authForm').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', `/api/${kind}`, { username: f.get('username'), password: f.get('password'), invite: f.get('invite') || undefined });
      await loadMe(); location.hash = isReg ? '#/onboarding' : '#/dashboard';
    } catch (err) { toast(err.message); }
  };
}
route('login', async () => authForm('login'));
route('register', async () => authForm('register'));

route('onboarding', async () => {
  const p = me.profile;
  view.innerHTML = `<div class="card" style="max-width:560px"><h1>Bắt đầu</h1>
    <p class="muted">Vài thông tin để tạo lộ trình. Bạn có thể đổi trong Cài đặt.</p>
    <form id="obForm">
      <label>Tên hiển thị</label><input name="display_name" value="${esc(p.display_name)}" maxlength="80">
      <label>Trình độ mục tiêu</label><select name="target_level">${['B2', 'C1', 'C2'].map(l => `<option ${p.target_level === l ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label>Thời gian học mỗi ngày (phút)</label><input name="daily_minutes" type="number" min="30" max="600" value="${p.daily_minutes}">
      <label>Ngôn ngữ giải thích của AI tutor</label><select name="explain_lang"><option value="vi" ${p.explain_lang === 'vi' ? 'selected' : ''}>Tiếng Việt</option><option value="fr" ${p.explain_lang === 'fr' ? 'selected' : ''}>Français</option></select>
      <label>Mục tiêu của bạn (tự do)</label><textarea name="goals" style="min-height:80px">${esc(p.goals)}</textarea>
      <p><button class="primary">Lưu và làm bài kiểm tra đầu vào</button> <a class="btn" href="#/dashboard" id="skipDiag">Để sau</a></p></form></div>`;
  $('#obForm').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    await api('PUT', '/api/profile', { display_name: f.get('display_name'), target_level: f.get('target_level'), daily_minutes: +f.get('daily_minutes'), explain_lang: f.get('explain_lang'), goals: f.get('goals') });
    await loadMe(); location.hash = '#/diagnostic';
  };
  $('#skipDiag').onclick = async () => { await api('PUT', '/api/profile', {}); await loadMe(); };
});

// ---------- diagnostic
route('diagnostic', async () => {
  const d = await api('GET', '/api/diagnostic');
  const steps = [...d.sections.map(s => ({ kind: 'section', s })), { kind: 'writing' }, { kind: 'speaking' }];
  if (d.ai.mock) steps.push({ kind: 'self' });
  const answers = {}; let writing = '', transcript = '', selfRating = {}, idx = -1, recorder = null;
  Timer.set('review');
  function show() {
    if (idx < 0) {
      view.innerHTML = `<div class="card"><h1>Bài kiểm tra đầu vào B1</h1><p>${esc(d.intro)}</p>
        <p class="muted small">${d.ai.mock ? 'AI chưa cấu hình: phần nói và viết sẽ được lưu, và bạn tự đánh giá tạm thời.' : 'Phần nói và viết sẽ do AI chấm.'}</p>
        <p><button class="primary" id="go">Bắt đầu</button></p></div>`;
      $('#go').onclick = () => { idx = 0; show(); }; return;
    }
    const st = steps[idx], nav = `<p class="row" style="margin-top:16px"><button id="next" class="primary">${idx === steps.length - 1 ? 'Nộp bài' : 'Tiếp'}</button><span class="muted small">Bước ${idx + 1}/${steps.length}</span></p>`;
    if (st.kind === 'section') {
      const s = st.s;
      const listen = s.type === 'listening';
      view.innerHTML = `<div class="card"><h2>${esc(s.title)}</h2><p class="muted">${esc(s.instructions || '')}</p>
        ${listen ? `<p><button id="play">▶ Nghe</button> <span class="muted small" id="plays">còn 2 lần</span></p>` : s.text ? `<div class="fr card">${esc(s.text)}</div>` : ''}
        <div id="qs">${renderQuestions(s.questions, 'd')}</div>${nav}</div>`;
      if (listen) { let left = 2; $('#play').onclick = () => { if (left <= 0) return; left--; $('#plays').textContent = `còn ${left} lần`; speak(s.text); }; }
      $('#next').onclick = () => { Object.assign(answers, collectAnswers($('#qs'), s.questions, 'd')); stopSpeak(); idx++; show(); };
    } else if (st.kind === 'writing') {
      view.innerHTML = `<div class="card"><h2>Production écrite</h2><p class="fr">${esc(d.writing.prompt)}</p><textarea id="w" placeholder="Écrivez ici…">${esc(writing)}</textarea><p class="muted small" id="wc">0 mots</p>${nav}</div>`;
      const ta = $('#w'); const wc = () => { $('#wc').textContent = `${ta.value.trim().split(/\s+/).filter(Boolean).length} mots`; }; ta.oninput = wc; wc();
      $('#next').onclick = () => { writing = ta.value; idx++; show(); };
    } else if (st.kind === 'speaking') {
      view.innerHTML = `<div class="card"><h2>Production orale</h2><p class="fr">${esc(d.speaking.prompt)}</p><div id="rec"></div>${nav}</div>`;
      recorder = makeRecorder($('#rec'), { maxSeconds: 120 });
      $('#next').onclick = () => { recorder.stop(); transcript = recorder.transcript(); idx++; show(); };
    } else {
      view.innerHTML = `<div class="card"><h2>Tự đánh giá</h2><p class="muted">${esc(d.self_rating.intro)}</p>
        ${['speaking', 'writing'].map(k => `<label>${SKILL_VI[k]}: <b id="v-${k}">50</b>/100</label><input type="range" min="0" max="100" value="50" id="r-${k}">`).join('')}${nav}</div>`;
      ['speaking', 'writing'].forEach(k => { $(`#r-${k}`).oninput = e => { $(`#v-${k}`).textContent = e.target.value; }; });
      $('#next').onclick = () => { ['speaking', 'writing'].forEach(k => { selfRating[k] = +$(`#r-${k}`).value; }); submit(); };
    }
    if (idx === steps.length - 1 && st.kind !== 'self') $('#next').onclick = () => { if (st.kind === 'writing') writing = $('#w').value; if (st.kind === 'speaking') { recorder.stop(); transcript = recorder.transcript(); } submit(); };
  }
  async function submit() {
    view.innerHTML = '<p class="muted">Đang chấm… (phần AI có thể mất 30 giây)</p>';
    const r = await api('POST', '/api/diagnostic', { answers, writing, speaking_transcript: transcript, self_rating: selfRating });
    await loadMe();
    const rows = Object.entries(r.skill_scores).map(([k, v]) => `<div class="skill-row"><div><div class="name">${SKILL_VI[k]}</div><div class="bar"><i style="width:${v}%;background:${SKILL_COLOR[k]}"></i></div></div><div class="val">${v}</div></div>`).join('');
    view.innerHTML = `<div class="card"><h1>Kết quả</h1>
      <p>Trình độ ghi nhận: ${levelBadge(r.level)} <span class="muted small">Ngữ pháp ${r.scores.grammar}/100, từ vựng ${r.scores.vocab}/100.</span></p>${rows}
      <p><b>Kỹ năng ưu tiên:</b> ${r.weak_skills.map(k => SKILL_VI[k]).join(', ') || 'chưa xác định'}</p>
      <p class="muted small">${esc(r.note)}</p>
      ${['writing', 'speaking'].map(k => r.feedback[k] && r.feedback[k].summary ? `<div class="card"><b>${SKILL_VI[k]}</b> ${r.feedback[k].mock ? '' : levelBadge(r.feedback[k].level_estimate)}<p>${esc(r.feedback[k].summary)}</p></div>` : '').join('')}
      <details><summary>Xem lại từng câu</summary><table>${r.results.map(x => `<tr><td>${esc(x.id)}</td><td>${x.ok ? '<span class="badge ok">đúng</span>' : '<span class="badge bad">sai</span>'}</td><td class="small">${esc(x.explain)}</td></tr>`).join('')}</table></details>
      <p><a class="btn primary" href="#/path">Xem lộ trình</a> <a class="btn" href="#/dashboard">Tổng quan</a></p></div>`;
  }
  show();
});

// ---------- dashboard
route('dashboard', async () => {
  const d = await api('GET', '/api/dashboard');
  const p = me.profile;
  const skills = Object.entries(d.skills).map(([k, v]) => `<div class="skill-row"><div><div class="name">${v.name} <span class="muted small">${trendTxt(v.trend)}</span></div><div class="bar"><i style="width:${v.last_score || 0}%;background:${SKILL_COLOR[k]}"></i></div></div><div class="val">${pct(v.last_score)}</div></div>`).join('');
  const plan = d.plan.items.map(i => `<li class="${i.done ? 'done' : ''}"><span style="min-width:170px">${esc(i.label)}</span><span class="muted small">${i.done_minutes}/${i.minutes} phút</span><a class="small" href="#/${esc(i.target.page)}">${esc(i.target.label)}</a></li>`).join('');
  view.innerHTML = `<h1>Bonjour${p.display_name ? ', ' + esc(p.display_name) : ''}</h1>
    ${!d.diagnostic_done ? '<div class="card"><b>Chưa có bài kiểm tra đầu vào.</b> Lộ trình chỉ cá nhân hoá sau khi có kết quả. <a href="#/diagnostic">Làm ngay</a></div>' : ''}
    <div class="grid c4">
      <div class="tile"><div class="label">Trình độ hiện tại</div><div class="hero-num">${esc(d.current_level)}</div><div class="sub">Mục tiêu ${esc(d.target_level)} · ước tính ${d.cefr.overall || 'chưa đủ dữ liệu'}</div></div>
      <div class="tile"><div class="label">Thời gian học</div><div class="hero-num">${d.hours} h</div><div class="sub">${d.streak} ngày liên tục</div></div>
      <div class="tile"><div class="label">Bài học</div><div class="hero-num">${d.lessons_completed}</div><div class="sub">trên ${d.lessons_total} bài đã có · ${d.completion_pct}%</div></div>
      <div class="tile"><div class="label">Từ vựng</div><div class="hero-num">${d.vocab.learning + d.vocab.known}</div><div class="sub">${d.vocab.known} đã ghi nhớ · ${d.vocab.due} đến hạn ôn</div></div>
    </div>
    <div class="grid c2" style="margin-top:14px">
      <div class="card"><h3 style="margin-top:0">Năng lực từng kỹ năng <span class="muted small">(điểm đánh giá gần nhất)</span></h3>${skills}
        <p class="muted small">Ước tính CEFR: ${d.cefr.overall ? levelBadge(d.cefr.overall) : 'chưa đủ dữ liệu'} ${confBadge(d.cefr.confidence)}<br>${esc(d.cefr.disclaimer)}</p>
        ${d.last_quiz ? `<p class="small">Bài kiểm tra gần nhất: ${d.last_quiz.score}/${d.last_quiz.max_score} (${fmtDate(d.last_quiz.created_at)})</p>` : ''}</div>
      <div class="card"><h3 style="margin-top:0">Hôm nay · ${d.plan.date}</h3>
        ${d.plan.note ? `<p class="small" style="color:var(--gold)">${esc(d.plan.note)}</p>` : ''}
        <ul class="plan">${plan}</ul>
        <p class="muted small">${d.plan.done_total}/${d.plan.total} phút${d.plan.missing_yesterday.length ? ' · hôm qua còn thiếu: ' + esc(d.plan.missing_yesterday.join(', ')) : ''}</p></div>
    </div>
    <div class="card"><h3 style="margin-top:0">Bài học tiếp theo</h3>${d.next ? `<p><a class="btn primary" href="#/lesson/${esc(d.next.id)}">${esc(d.next.title)}</a> <span class="muted small">${esc(d.next.module)} · ${d.next.duration_min} phút · ${esc(d.next.level)}</span></p>` : '<p class="muted">Bạn đã hoàn thành mọi bài học hiện có.</p>'}</div>
    <div class="grid c2"><div class="card"><h3 style="margin-top:0">Phút học 14 ngày</h3><div id="c14"></div></div><div class="card"><h3 style="margin-top:0">Phút học theo tuần</h3><div id="cw"></div></div></div>`;
  barChart($('#c14'), d.days14.map(x => ({ label: x.day.slice(8), full: x.day, value: x.minutes })), { unit: ' phút' });
  barChart($('#cw'), d.weeks.length ? d.weeks.map(x => ({ label: x.week.slice(5), full: x.week, value: x.minutes })) : [{ label: '', value: 0 }], { unit: ' phút' });
});

// ---------- path and catalog
const statusBadge = s => ({ completed: '<span class="badge ok">hoàn thành</span>', review: '<span class="badge warn">cần ôn lại</span>', in_progress: '<span class="badge">đang học</span>' }[s] || '<span class="badge">chưa học</span>');
route('path', async () => {
  const d = await api('GET', '/api/path');
  view.innerHTML = `<h1>Lộ trình học</h1>
    <div class="card"><p><b>Kỹ năng ưu tiên:</b> ${d.weak_skills.length ? d.weak_skills.map(k => SKILL_VI[k]).join(', ') : 'chưa có bài kiểm tra đầu vào'}${d.hot_errors.length ? ` · <b>Lỗi lặp lại:</b> ${d.hot_errors.map(catName).join(', ')}` : ''}</p>
    ${d.remediation.length ? `<p><b>Bài ôn đề xuất:</b> ${d.remediation.map(r => r.lesson_id ? `<a href="#/lesson/${esc(r.lesson_id)}">${esc(r.title)}</a> (${catName(r.category)} ×${r.count})` : `${catName(r.category)} ×${r.count} (dùng Grammar Practice)`).join(' · ')}</p>` : ''}
    <p class="muted small">Trong tuần hiện tại, bài thuộc kỹ năng yếu và bài cần ôn được xếp lên đầu. Thứ tự các tuần khác giữ nguyên.</p></div>
    ${d.weeks.map(w => `<div class="card week"><h3 style="margin-top:0">Phase ${w.phase} · Tuần ${w.week} ${w.current ? '<span class="badge level">tuần này</span>' : w.done ? '<span class="badge ok">xong</span>' : ''}</h3>
      <div class="lessons">${w.lessons.map(l => `<a href="#/lesson/${esc(l.id)}">${statusBadge(l.status)}<span>${esc(l.title)}</span><span class="muted small">${esc(l.module)} · ${l.duration_min} phút${l.best_score != null ? ' · ' + l.best_score + '%' : ''}${l.priority ? ' · ưu tiên' : ''}</span></a>`).join('')}</div></div>`).join('')}`;
});
route('catalog', async () => {
  const c = await api('GET', '/api/curriculum');
  view.innerHTML = `<h1>Khoá học</h1><p class="muted">${esc(c.note)}</p>` + c.phases.map(ph => `<div class="card"><h2 style="margin-top:0">Phase ${ph.phase} · ${esc(ph.name)} <span class="badge">${esc(ph.level)}</span> <span class="muted small">${esc(ph.months)}</span></h2>
    <ul class="small">${ph.goals.map(g => `<li>${esc(g)}</li>`).join('')}</ul>
    <div class="grid c2">${ph.modules.map((m, i) => `<div class="tile">${m.lessons.length ? `<a href="#/module/${ph.phase}/${encodeURIComponent(m.name)}"><b>${i + 1}. ${esc(m.name)}</b></a><div class="muted small">${m.completed}/${m.lessons.length} bài hoàn thành</div>` : `<b>${i + 1}. ${esc(m.name)}</b><div class="muted small">chưa có bài học</div>`}</div>`).join('')}</div></div>`).join('');
});
route('module', async ([phase, name]) => {
  const c = await api('GET', '/api/curriculum');
  const ph = c.phases.find(p => String(p.phase) === phase); const m = ph && ph.modules.find(x => x.name === decodeURIComponent(name));
  if (!m) throw new Error('Không có module này');
  view.innerHTML = `<p><a href="#/catalog">← Khoá học</a></p><h1>${esc(m.name)}</h1><p class="muted">Phase ${ph.phase} · ${esc(ph.name)}</p>
    <div class="card week"><div class="lessons">${m.lessons.map(l => `<a href="#/lesson/${esc(l.id)}">${statusBadge(l.status || 'not_started')}<span>${esc(l.title)}</span><span class="muted small">Tuần ${l.week} · ${l.duration_min} phút</span></a>`).join('')}</div></div>`;
});

// ---------- lesson player
const SECTION_VI = { text: 'Giới thiệu', vocab: 'Từ vựng', grammar: 'Ngữ pháp', exercise: 'Bài tập', listening: 'Nghe', reading: 'Đọc', speaking: 'Nói', writing: 'Viết', quiz: 'Quiz', summary: 'Tóm tắt', homework: 'Bài về nhà', resources: 'Tài nguyên' };
function sectionActivity(lesson, sec) {
  if (['listening', 'reading', 'speaking', 'writing'].includes(sec.type)) return sec.type;
  if (sec.type === 'vocab') return 'vocab';
  if (['grammar', 'vocab'].includes(lesson.skill)) return lesson.skill;
  if (lesson.skill === 'culture') return 'reading';
  return lesson.skill;
}
route('lesson', async ([id]) => {
  const L = await api('GET', `/api/lessons/${id}`);
  let idx = Math.min(L.progress.section_idx || 0, L.sections.length - 1);
  const done = new Set(L.attempts.map(a => a.kind));
  function shell() {
    view.innerHTML = `<p class="small"><a href="#/path">← Lộ trình</a> · ${esc(L.module)} · Tuần ${L.week}</p>
      <h1>${esc(L.title)} <span class="badge">${esc(L.level)}</span> ${L.progress.status === 'completed' ? '<span class="badge ok">hoàn thành</span>' : L.progress.status === 'review' ? '<span class="badge warn">cần ôn lại</span>' : ''}</h1>
      <div class="lesson"><div class="steps" id="steps"></div><div id="sec"></div></div>`;
    $('#steps').innerHTML = L.sections.map((s, i) => `<a href="#" data-i="${i}" class="${i === idx ? 'cur' : ''}">${i + 1}. ${SECTION_VI[s.type]}${s.title && s.type !== 'text' ? '' : ''}</a>`).join('') +
      `<div style="padding:10px"><button class="sm" id="markDone">Đánh dấu hoàn thành</button></div>`;
    $$('#steps a').forEach(a => { a.onclick = e => { e.preventDefault(); go(+a.dataset.i); }; });
    $('#markDone').onclick = async () => {
      if ((L.progress.best_score || 0) < 60) return toast('Cần làm Quiz đạt 60% trở lên trước khi hoàn thành.');
      await api('POST', `/api/lessons/${id}/progress`, { status: 'completed' }); L.progress.status = 'completed'; toast('Đã đánh dấu hoàn thành'); shell(); showSection();
    };
    showSection();
  }
  async function go(i) { idx = i; await api('POST', `/api/lessons/${id}/progress`, { section_idx: i }); $$('#steps a').forEach(a => a.classList.toggle('cur', +a.dataset.i === i)); showSection(); }
  function showSection() {
    const s = L.sections[idx], el = $('#sec');
    Timer.set(sectionActivity(L, s), ['listening', 'reading', 'speaking', 'writing'].includes(sectionActivity(L, s)) ? sectionActivity(L, s) : null, id);
    stopSpeak();
    let html = `<div class="card"><h2 style="margin-top:0">${esc(s.title || SECTION_VI[s.type])}</h2>`;
    if (idx === 0) html += `<p>${esc(L.intro)}</p><h3>Mục tiêu</h3><ul>${L.objectives.map(o => `<li>${esc(o)}</li>`).join('')}</ul><p class="muted small">Thời lượng dự kiến ${L.duration_min} phút${L.prerequisites.length ? ' · cần trước: ' + L.prerequisites.map(p => `<a href="#/lesson/${esc(p)}">${esc(p)}</a>`).join(', ') : ''}</p>`;
    if (s.type === 'text' || s.type === 'summary' || s.type === 'homework') html += md(s.body);
    if (s.type === 'grammar') html += md(s.body) + (s.examples ? `<h3>Ví dụ</h3><table>${s.examples.map(e => `<tr><td class="fr">${esc(e.fr)} <button class="sm ghost" data-say="${esc(e.fr)}">🔊</button></td><td class="small">${esc(e.vi)}</td></tr>`).join('')}</table>` : '');
    if (s.type === 'vocab') html += `<p><button class="sm" id="saveAll">Lưu tất cả vào Vocabulary Trainer</button></p><table>${s.items.map((it, i) => `<tr><td class="fr">${esc(it.fr)} <button class="sm ghost" data-say="${esc(it.fr)}">🔊</button></td><td>${esc(it.vi)}</td><td class="small muted">${esc(it.example || '')}</td><td><button class="sm" data-save="${i}">+</button></td></tr>`).join('')}</table>`;
    if (['exercise', 'quiz', 'listening', 'reading'].includes(s.type)) {
      html += `<p class="muted">${esc(s.instructions || '')}</p>`;
      if (s.type === 'listening' && s.source) {
        const a = s.source, credit = [a.audio ? a.name : '', a.author, a.license, a.date].filter(Boolean).map(esc).join(', ');
        html += `${a.audio ? `<p><audio id="aud" controls preload="none" src="${esc(a.audio)}" style="width:100%"></audio></p>` : ''}<p><button id="open" class="${a.audio ? 'sm ghost' : ''}">${a.audio ? 'Trang nguồn' : '▶ Écouter sur ' + esc(a.name)}</button> <span class="muted small">${credit}</span></p><div id="ltext" hidden class="fr card" style="white-space:pre-line"></div>`;
      }
      else if (s.type === 'listening') html += `<p><button id="play">▶ Nghe</button> <button class="sm ghost" id="playSlow">chậm</button> <span class="muted small" id="plays">còn 2 lần</span></p><div id="ltext" hidden class="fr card"></div>`;
      if (s.type === 'reading') html += `<div class="fr card">${esc(s.text)}</div>`;
      html += `<div id="qs">${renderQuestions(s.questions)}</div><p class="row"><button class="primary" id="submit">Nộp</button><span class="muted small" id="res"></span></p>`;
      const hist = L.attempts.filter(a => a.kind === s.type);
      if (hist.length) html += `<p class="muted small">Lịch sử: ${hist.slice(0, 5).map(a => `${a.score}/${a.max_score} (${fmtDT(a.created_at)})`).join(' · ')}</p>`;
    }
    if (s.type === 'speaking') html += `<p class="fr">${esc(s.prompt)}</p><p class="muted small">${s.minutes || 3} phút${s.hints ? '' : ''}</p>${s.hints ? `<ul class="small">${s.hints.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}<div id="rec"></div><p><button class="primary" id="sendSpeak">Gửi để AI nhận xét</button></p><div id="fb"></div>`;
    if (s.type === 'writing') html += `<p class="fr">${esc(s.prompt)}</p><p class="muted small">Khoảng ${s.words} từ.</p>${s.criteria ? `<ul class="small">${s.criteria.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}<textarea id="wtext" placeholder="Écrivez ici…"></textarea><p class="row"><span class="muted small" id="wc">0 mots</span><button class="primary" id="sendWrite">Gửi để AI sửa</button></p><div id="fb"></div>`;
    if (s.type === 'resources') html += `<ul>${s.items.map(r => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a> <span class="muted small">${esc(r.note || '')}</span></li>`).join('')}</ul>`;
    html += `<p class="row" style="margin-top:18px">${idx > 0 ? '<button id="prev">← Trước</button>' : ''}${idx < L.sections.length - 1 ? '<button id="next" class="primary">Tiếp →</button>' : '<a class="btn primary" href="#/path">Về lộ trình</a>'}</p></div>
      <div class="card"><h3 style="margin-top:0">Ghi chú của bạn</h3><textarea id="note" style="min-height:90px" placeholder="Ghi chú cá nhân cho bài này (tự lưu)">${esc(L.note)}</textarea><span class="muted small" id="noteState"></span></div>`;
    el.innerHTML = html;
    if ($('#prev')) $('#prev').onclick = () => go(idx - 1);
    if ($('#next')) $('#next').onclick = () => go(idx + 1);
    $$('[data-say]', el).forEach(b => { b.onclick = () => speak(b.dataset.say); });
    let noteT; $('#note').oninput = e => { clearTimeout(noteT); $('#noteState').textContent = 'đang lưu…'; noteT = setTimeout(async () => { L.note = e.target.value; await api('PUT', '/api/notes', { lesson_id: id, body: e.target.value }); $('#noteState').textContent = 'đã lưu'; }, 800); };
    if (s.type === 'vocab') {
      const save = async it => api('POST', '/api/vocab', { word: it.fr, translation: it.vi, example: it.example || '', lesson_id: id });
      $$('[data-save]', el).forEach(b => { b.onclick = async () => { await save(s.items[+b.dataset.save]); b.textContent = '✓'; b.disabled = true; }; });
      $('#saveAll').onclick = async () => { for (const it of s.items) await save(it); toast(`Đã lưu ${s.items.length} từ`); $$('[data-save]', el).forEach(b => { b.textContent = '✓'; b.disabled = true; }); };
    }
    if (s.type === 'listening' && s.source) { $('#open').onclick = () => window.open(s.source.url, '_blank', 'noopener'); if ($('#aud')) $('#aud').onerror = () => toast('Không tải được audio, dùng nút Trang nguồn.'); }
    else if (s.type === 'listening') { let left = 2; const play = rate => { if (left <= 0) return toast('Hết lượt nghe. Nộp bài để xem văn bản.'); left--; $('#plays').textContent = `còn ${left} lần`; speak(s.text, rate); }; $('#play').onclick = () => play(0.95); $('#playSlow').onclick = () => play(0.75); }
    if ($('#submit')) $('#submit').onclick = async () => {
      const answers = collectAnswers($('#qs'), s.questions);
      if (Object.keys(answers).length < s.questions.length && !confirm('Còn câu chưa trả lời. Nộp luôn?')) return;
      const r = await api('POST', '/api/attempts', { lesson_id: id, section_idx: idx, answers });
      showResults($('#qs'), s.questions, r.results); $('#submit').disabled = true;
      $('#res').textContent = `${r.score}/${r.max} (${r.pct}%)`;
      L.attempts.unshift({ kind: s.type, score: r.score, max_score: r.max, created_at: new Date().toISOString() }); done.add(s.type);
      if (s.type === 'listening') { $('#ltext').hidden = false; if (s.source) $('#ltext').innerHTML = `${esc(s.text || '')} Transcription : <a href="${esc(s.source.url)}" target="_blank" rel="noopener">${esc(s.source.name)}</a>`; else $('#ltext').textContent = s.text; }
      if (s.type === 'quiz') { L.progress.best_score = Math.max(L.progress.best_score || 0, r.pct); L.progress.status = r.completed ? 'completed' : 'review'; toast(r.completed ? 'Đạt. Bài học được đánh dấu hoàn thành.' : 'Dưới 60%: bài được đánh dấu cần ôn lại. Xem lại giải thích rồi làm lại.'); }
    };
    if (s.type === 'speaking') {
      const rec = makeRecorder($('#rec'), { maxSeconds: (s.minutes || 3) * 60 + 30 });
      $('#sendSpeak').onclick = async () => {
        rec.stop(); const t = rec.transcript(); if (!t) return toast('Chưa có transcript.');
        $('#fb').innerHTML = '<p class="muted">Đang gửi… AI chấm trong khoảng 20 đến 40 giây.</p>'; $('#sendSpeak').disabled = true;
        try { const r = await api('POST', '/api/speaking', { topic: `${L.title} : ${s.title}`, lesson_id: id, duration_s: rec.seconds(), transcript: t, audio_b64: await rec.audioB64() }); $('#fb').innerHTML = speakingFeedback(r.feedback); }
        catch (e) { $('#fb').innerHTML = `<p class="badge bad">${esc(e.message)}</p>`; } finally { $('#sendSpeak').disabled = false; }
      };
    }
    if (s.type === 'writing') {
      const ta = $('#wtext'); ta.oninput = () => { $('#wc').textContent = `${ta.value.trim().split(/\s+/).filter(Boolean).length} mots`; };
      $('#sendWrite').onclick = async () => {
        if (ta.value.trim().length < 20) return toast('Bài quá ngắn.');
        $('#fb').innerHTML = '<p class="muted">Đang gửi… AI sửa trong khoảng 20 đến 40 giây.</p>'; $('#sendWrite').disabled = true;
        try { const r = await api('POST', '/api/writing', { topic: `${L.title} : ${s.title}`, lesson_id: id, body: ta.value, criteria: s.criteria || [] }); $('#fb').innerHTML = writingFeedback(r.feedback, ta.value); }
        catch (e) { $('#fb').innerHTML = `<p class="badge bad">${esc(e.message)}</p>`; } finally { $('#sendWrite').disabled = false; }
      };
    }
  }
  shell();
});

// ---------- feedback rendering
function errorsTable(errs) {
  if (!errs || !errs.length) return '<p class="muted small">Không ghi nhận lỗi nào.</p>';
  return `<table class="err-table"><tr><th>Loại</th><th>Gốc</th><th>Sửa</th><th>Giải thích</th></tr>${errs.map(e => `<tr><td>${esc(catName(e.category))}</td><td class="fr small">${esc(e.original)}</td><td class="fr small">${esc(e.correction)}</td><td class="small">${esc(e.explanation)}</td></tr>`).join('')}</table>`;
}
function scoreBars(scores, names) {
  return Object.entries(scores).filter(([k]) => k !== 'overall').map(([k, v]) => `<div class="skill-row"><div><div class="name">${esc(names[k] || k)}</div><div class="bar"><i style="width:${v}%"></i></div></div><div class="val">${v}</div></div>`).join('');
}
function aiNotice(fb) {
  if (fb.error) return `<p class="badge bad">AI lỗi: ${esc(fb.error)}. Bài đã được lưu, chưa có điểm.</p>`;
  if (fb.mock) return `<p class="badge warn">Mô phỏng</p><p class="small">${esc(fb.summary || '')}</p>`;
  return '';
}
function speakingFeedback(fb) {
  const n = aiNotice(fb); if (n && !fb.scores) return `<div class="card">${n}</div>`;
  const names = { fluency: 'Trôi chảy', grammar: 'Ngữ pháp', vocabulary: 'Từ vựng', argumentation: 'Lập luận' };
  return `<div class="card"><h3 style="margin-top:0">Nhận xét ${levelBadge(fb.level_estimate)} <span class="badge">${fb.scores.overall}/100</span></h3>
    <p>${esc(fb.summary)}</p>${scoreBars(fb.scores, names)}
    <p class="muted small">Phát âm: không đánh giá (AI chỉ đọc transcript, không nghe audio). Lỗi được ghi vào lịch sử ngữ pháp.</p>
    ${fb.strengths.length ? `<p><b>Điểm mạnh:</b> ${fb.strengths.map(esc).join(' · ')}</p>` : ''}${fb.weak_points.length ? `<p><b>Cần cải thiện:</b> ${fb.weak_points.map(esc).join(' · ')}</p>` : ''}
    <h3>Lỗi</h3>${errorsTable(fb.errors)}
    ${fb.better_phrasings.length ? `<h3>Diễn đạt tự nhiên hơn</h3><table>${fb.better_phrasings.map(b => `<tr><td class="fr small">${esc(b.original)}</td><td class="fr small">${esc(b.improved)}</td><td class="small muted">${esc(b.why)}</td></tr>`).join('')}</table>` : ''}
    ${fb.followup_question ? `<p><b>Câu hỏi tiếp:</b> <span class="fr">${esc(fb.followup_question)}</span> <button class="sm ghost" onclick="speak(this.previousElementSibling.textContent)">🔊</button></p>` : ''}</div>`;
}
function writingFeedback(fb, original) {
  const n = aiNotice(fb); if (n && !fb.scores) return `<div class="card">${n}</div>`;
  const names = { grammar: 'Ngữ pháp', lexis: 'Từ vựng', coherence: 'Mạch lạc', cohesion: 'Liên kết', argumentation: 'Lập luận', style: 'Văn phong' };
  return `<div class="card"><h3 style="margin-top:0">Nhận xét ${levelBadge(fb.level_estimate)} <span class="badge">${fb.scores.overall}/100</span></h3><p>${esc(fb.summary)}</p>${scoreBars(fb.scores, names)}
    <h3>Bảng lỗi</h3>${errorsTable(fb.errors)}
    <div class="grid c2"><div><h3>Bản gốc</h3><div class="fr small">${esc(original)}</div></div><div><h3>Bản sửa</h3><div class="fr small">${esc(fb.corrected_text)}</div></div></div>
    <h3>Bản nâng cấp</h3><div class="fr small">${esc(fb.upgraded_text)}</div>
    ${fb.exercises.length ? `<h3>Bài tập bổ sung</h3><ol>${fb.exercises.map(e => `<li>${esc(e.instruction)} <details class="small"><summary>Đáp án</summary>${esc(e.answer)}</details></li>`).join('')}</ol>` : ''}</div>`;
}

// ---------- tutor chat
async function renderChat(el, mode, { voice = false, seed = null } = {}) {
  const h = await api('GET', `/api/tutor?mode=${mode}`);
  el.innerHTML = `<div class="chat" id="chat-${mode}"></div>
    <form class="row" id="cf-${mode}" style="margin-top:10px"><input name="m" placeholder="${mode === 'speaking' || mode === 'examiner' ? 'Parlez ou écrivez en français…' : 'Hỏi tutor (tiếng Việt hoặc tiếng Pháp)…'}" style="flex:1" autocomplete="off">
    ${voice && SR ? `<button type="button" id="mic-${mode}">🎤</button>` : ''}<button class="primary">Gửi</button><button type="button" class="ghost sm" id="clr-${mode}">Xoá</button></form>
    ${h.ai.mock ? '<p class="muted small">AI đang ở chế độ mô phỏng: câu trả lời không phải phản hồi thật. Xem Cài đặt.</p>' : ''}`;
  const box = $(`#chat-${mode}`, el);
  const add = (role, content) => { const d = document.createElement('div'); d.className = `msg ${role}`; d.innerHTML = role === 'assistant' ? md(content) : esc(content); box.appendChild(d); box.scrollTop = box.scrollHeight; };
  h.messages.forEach(m => add(m.role, m.content));
  const form = $(`#cf-${mode}`, el), input = form.m;
  async function send(text) {
    if (!text.trim()) return; add('user', text); input.value = ''; form.querySelector('button.primary').disabled = true;
    const wait = document.createElement('div'); wait.className = 'msg assistant muted'; wait.textContent = '…'; box.appendChild(wait);
    try { const r = await api('POST', '/api/tutor', { mode, message: text }); wait.remove(); add('assistant', r.reply); if (voice && !r.mock) speak(r.reply.replace(/\*\*/g, '')); if (r.vocab && r.vocab.length) toast(`Đã thêm ${r.vocab.length} từ vào Vocabulary Trainer`); }
    catch (e) { wait.remove(); add('assistant', 'Lỗi: ' + e.message); }
    finally { form.querySelector('button.primary').disabled = false; }
  }
  form.onsubmit = e => { e.preventDefault(); send(input.value); };
  $(`#clr-${mode}`, el).onclick = async () => { if (confirm('Xoá lịch sử chế độ này?')) { await api('DELETE', `/api/tutor?mode=${mode}`); box.innerHTML = ''; } };
  const mic = $(`#mic-${mode}`, el);
  if (mic) mic.onclick = () => { stopSpeak(); const sr = new SR(); sr.lang = 'fr-FR'; sr.interimResults = true; mic.textContent = '●'; sr.onresult = ev => { input.value = Array.from(ev.results).map(r => r[0].transcript).join(' '); }; sr.onend = () => { mic.textContent = '🎤'; if (input.value.trim()) send(input.value); }; sr.onerror = () => { mic.textContent = '🎤'; }; sr.start(); };
  if (seed) send(seed);
  return { send };
}
route('tutor', async ([mode = 'grammar']) => {
  const modes = { grammar: 'Grammar', vocab: 'Vocabulary', speaking: 'Speaking', writing: 'Writing', examiner: 'Examinateur DALF C1' };
  if (!modes[mode]) throw new Error('Chế độ không tồn tại');
  Timer.set({ grammar: 'grammar', vocab: 'vocab', speaking: 'speaking', writing: 'writing', examiner: 'speaking' }[mode], mode === 'speaking' || mode === 'examiner' ? 'speaking' : mode === 'writing' ? 'writing' : null);
  view.innerHTML = `<h1>AI Tutor</h1><div class="tabs">${Object.entries(modes).map(([k, v]) => `<a href="#/tutor/${k}" class="${k === mode ? 'active' : ''}">${v}</a>`).join('')}</div>
    <p class="muted small">${{ grammar: 'Giải thích ngữ pháp bằng tiếng Việt, ví dụ tiếng Pháp, bài tập theo trình độ, phân tích lỗi.', vocab: 'Từ theo chủ đề, nghĩa, ngữ cảnh, đồng nghĩa, collocations. Từ mới được thêm tự động vào Vocabulary Trainer.', speaking: 'Hội thoại tiếng Pháp. Dùng micro để nói; câu trả lời được đọc to. Lỗi được ghi vào lịch sử.', writing: 'Lập dàn ý, sửa đoạn, phong cách học thuật. Để chấm điểm đầy đủ, dùng Writing Lab.', examiner: 'Giám khảo DALF C1: đề bài, exposé, débat, đánh giá theo grille chính thức khi bạn yêu cầu.' }[mode]}</p>
    <div class="card" id="chat"></div>`;
  await renderChat($('#chat'), mode, { voice: mode === 'speaking' || mode === 'examiner' });
});

// ---------- grammar practice
route('grammar', async () => {
  Timer.set('grammar');
  const a = await api('GET', '/api/analytics');
  const cats = a.grammar;
  view.innerHTML = `<h1>Grammar Practice</h1>
    <div class="grid c2"><div class="card"><h3 style="margin-top:0">Lỗi 90 ngày</h3>${cats.length ? `<table><tr><th>Lỗi</th><th>Số lần</th><th>Gần nhất</th></tr>${cats.map(c => `<tr><td>${esc(catName(c.category))}</td><td>${c.c}</td><td class="small muted">${fmtDate(c.last)}</td></tr>`).join('')}</table>` : '<p class="muted">Chưa có lỗi nào được ghi. Lỗi đến từ bài tập, quiz, bài nói và bài viết.</p>'}
      ${a.remediation.length ? `<p class="small"><b>Bài ôn đề xuất:</b> ${a.remediation.map(r => r.lesson_id ? `<a href="#/lesson/${esc(r.lesson_id)}">${esc(r.title)}</a> (${catName(r.category)})` : catName(r.category)).join(' · ')}</p>` : ''}</div>
    <div class="card"><h3 style="margin-top:0">Luyện theo lỗi</h3><p class="row"><select id="cat"><option value="">3 lỗi nhiều nhất</option>${Object.keys(CAT_VI).map(k => `<option value="${k}">${CAT_VI[k]}</option>`).join('')}</select><button id="load" class="primary">Lấy bài</button></p><div id="drill"></div></div></div>
    <div class="card"><h3 style="margin-top:0">Hỏi Grammar Tutor</h3><div id="chat"></div></div>`;
  $('#load').onclick = async () => {
    const d = await api('GET', `/api/drill?category=${$('#cat').value}`);
    if (!d.questions.length) { $('#drill').innerHTML = '<p class="muted">Không có câu hỏi cho loại lỗi này trong các bài hiện có.</p>'; return; }
    const qs = d.questions.slice(0, 10);
    $('#drill').innerHTML = `<p class="muted small">${qs.length} câu · ${d.categories.map(catName).join(', ')}</p><div id="dq">${renderQuestions(qs, 'dr')}</div><p><button class="primary" id="dsub">Nộp</button> <span id="dres"></span></p>`;
    $('#dsub').onclick = async () => {
      const answers = collectAnswers($('#dq'), qs, 'dr');
      const groups = {}; qs.forEach(q => { const k = `${q.lesson_id}|${q.section_idx}`; (groups[k] = groups[k] || []).push(q); });
      let score = 0, max = 0, results = [];
      for (const [k, group] of Object.entries(groups)) {
        const [lesson_id, section_idx] = k.split('|');
        const sub = {}; group.forEach(q => { if (answers[q.id] !== undefined) sub[q.id] = answers[q.id]; });
        const r = await api('POST', '/api/attempts', { lesson_id, section_idx: +section_idx, answers: sub, question_ids: group.map(q => q.id) });
        score += r.score; max += r.max; results = results.concat(r.results);
      }
      showResults($('#dq'), qs, results); $('#dres').textContent = `${score}/${max}`; $('#dsub').disabled = true;
    };
  };
  await renderChat($('#chat'), 'grammar');
});

// ---------- vocabulary trainer
route('vocab', async () => {
  Timer.set('vocab');
  let filter = 'due';
  async function draw() {
    const d = await api('GET', `/api/vocab?filter=${filter}`), st = d.stats;
    view.innerHTML = `<h1>Vocabulary Trainer</h1>
      <div class="grid c4"><div class="tile"><div class="label">Tổng</div><div class="hero-num">${st.total}</div><div class="sub">${st.new} mới · ${st.learning} đang học</div></div>
        <div class="tile"><div class="label">Đã ghi nhớ</div><div class="hero-num">${st.known}</div><div class="sub">ôn đúng 3 lần, khoảng cách ≥ 7 ngày</div></div>
        <div class="tile"><div class="label">Đến hạn ôn</div><div class="hero-num">${st.due}</div><div class="sub">hôm nay</div></div>
        <div class="tile"><div class="label">Dùng chủ động</div><div class="hero-num">${st.active}</div><div class="sub">${st.used_speaking} trong bài nói · ${st.used_writing} trong bài viết</div></div></div>
      <div class="card" style="margin-top:14px"><div class="row"><button class="primary" id="review">Ôn tập (${st.due + st.new} từ)</button><span class="muted small">Nhận biết từ khác với dùng được từ: cột « dùng chủ động » chỉ tăng khi từ xuất hiện trong bài nói hoặc bài viết của bạn.</span></div><div id="flash"></div></div>
      <div class="card"><h3 style="margin-top:0">Thêm từ</h3><form class="inline-form" id="addf"><div><label>Từ (fr)</label><input name="word" required maxlength="100"></div><div><label>Nghĩa (vi)</label><input name="translation" maxlength="300"></div><div><label>Ví dụ</label><input name="example" maxlength="500"></div><button class="primary">Thêm</button></form></div>
      <div class="card"><div class="tabs">${[['due', 'Đến hạn'], ['new', 'Mới'], ['learning', 'Đang học'], ['known', 'Đã nhớ'], ['active', 'Dùng chủ động'], ['all', 'Tất cả']].map(([k, v]) => `<button data-f="${k}" class="${k === filter ? 'active' : ''}">${v}</button>`).join('')}</div>
        <table><tr><th>Từ</th><th>Nghĩa</th><th>Trạng thái</th><th>Ôn tiếp</th><th></th></tr>${d.items.map(it => `<tr><td class="fr">${esc(it.word)} <button class="sm ghost" data-say="${esc(it.word)}">🔊</button></td><td class="small">${esc(it.translation)}<div class="muted">${esc(it.example)}</div></td><td><span class="badge">${it.status}</span>${it.used_speaking ? ' <span class="badge ok">nói</span>' : ''}${it.used_writing ? ' <span class="badge ok">viết</span>' : ''}</td><td class="small muted">${fmtDate(it.due_at)}</td><td><button class="sm ghost" data-del="${it.id}">✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Trống.</td></tr>'}</table></div>`;
    $$('[data-f]').forEach(b => { b.onclick = () => { filter = b.dataset.f; draw(); }; });
    $$('[data-say]').forEach(b => { b.onclick = () => speak(b.dataset.say); });
    $$('[data-del]').forEach(b => { b.onclick = async () => { await api('DELETE', `/api/vocab/${b.dataset.del}`); draw(); }; });
    $('#addf').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); await api('POST', '/api/vocab', { word: f.get('word'), translation: f.get('translation'), example: f.get('example') }); toast('Đã thêm'); filter = 'new'; draw(); };
    $('#review').onclick = startReview;
  }
  async function startReview() {
    const due = (await api('GET', '/api/vocab?filter=due')).items, fresh = (await api('GET', '/api/vocab?filter=new')).items;
    const queue = due.concat(fresh).slice(0, 40); let i = 0, ok = 0;
    const box = $('#flash');
    function card() {
      if (i >= queue.length) { box.innerHTML = `<p>Xong: ${ok}/${queue.length} nhớ được.</p>`; setTimeout(draw, 1200); return; }
      const w = queue[i];
      box.innerHTML = `<div class="flash">${esc(w.word)} <button class="sm ghost" data-say="${esc(w.word)}">🔊</button><div class="tr" id="tr" hidden>${esc(w.translation)}<br><span class="fr small">${esc(w.example)}</span></div></div>
        <p class="row" style="justify-content:center" id="btns"><button class="primary" id="reveal">Hiện nghĩa</button></p><p class="muted small" style="text-align:center">${i + 1}/${queue.length}</p>`;
      $('[data-say]', box).onclick = () => speak(w.word);
      $('#reveal').onclick = () => { $('#tr').hidden = false; $('#btns').innerHTML = [['0', 'Quên', ''], ['1', 'Khó', ''], ['2', 'Tốt', 'primary'], ['3', 'Dễ', '']].map(([g, t, c]) => `<button class="${c}" data-g="${g}">${t}</button>`).join(''); $$('[data-g]', box).forEach(b => { b.onclick = async () => { await api('POST', `/api/vocab/${w.id}/review`, { grade: +b.dataset.g }); if (+b.dataset.g >= 2) ok++; i++; card(); }; }); };
    }
    if (!queue.length) { box.innerHTML = '<p class="muted">Không có từ nào đến hạn.</p>'; return; }
    card();
  }
  await draw();
});

// ---------- speaking lab
route('speaking', async ([tab = 'task']) => {
  Timer.set('speaking', 'speaking');
  const [prompts, hist] = await Promise.all([api('GET', '/api/prompts'), api('GET', '/api/speaking')]);
  view.innerHTML = `<h1>Speaking Lab</h1><div class="tabs">${[['task', 'Bài nói'], ['chat', 'Hội thoại với AI'], ['history', 'Lịch sử']].map(([k, v]) => `<a href="#/speaking/${k}" class="${k === tab ? 'active' : ''}">${v}</a>`).join('')}</div><div id="body"></div>`;
  const body = $('#body');
  if (tab === 'task') {
    body.innerHTML = `<div class="card"><label>Chủ đề</label><select id="topic"><option value="">Chủ đề tự do…</option>${prompts.speaking.map((p, i) => `<option value="${i}">${esc(p.lesson_title)} : ${esc(p.title)} (${p.minutes} phút)</option>`).join('')}</select>
      <input id="custom" placeholder="Hoặc gõ chủ đề của bạn (tiếng Pháp)" style="margin-top:8px"><div id="pinfo" class="small"></div>
      <div id="rec" style="margin-top:10px"></div><p><button class="primary" id="send">Gửi để AI nhận xét</button></p><div id="fb"></div></div>`;
    const rec = makeRecorder($('#rec'));
    const info = () => { const p = prompts.speaking[$('#topic').value]; $('#pinfo').innerHTML = p ? `<p class="fr">${esc(p.prompt)}</p>${p.hints.length ? `<ul class="muted">${p.hints.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}` : ''; };
    $('#topic').onchange = info;
    $('#send').onclick = async () => {
      rec.stop(); const t = rec.transcript(); if (!t) return toast('Chưa có transcript.');
      const p = prompts.speaking[$('#topic').value]; const topic = $('#custom').value.trim() || (p ? `${p.lesson_title} : ${p.title}` : 'Sujet libre');
      $('#fb').innerHTML = '<p class="muted">Đang gửi…</p>'; $('#send').disabled = true;
      try { const r = await api('POST', '/api/speaking', { topic, lesson_id: p ? p.lesson_id : null, duration_s: rec.seconds(), transcript: t, audio_b64: await rec.audioB64() }); $('#fb').innerHTML = speakingFeedback(r.feedback); }
      catch (e) { $('#fb').innerHTML = `<p class="badge bad">${esc(e.message)}</p>`; } finally { $('#send').disabled = false; }
    };
  } else if (tab === 'chat') {
    body.innerHTML = '<div class="card"><p class="muted small">Nói bằng micro hoặc gõ. AI hỏi theo trình độ, sửa lỗi quan trọng rồi hỏi tiếp. Trả lời được đọc to.</p><div id="chat"></div></div>';
    await renderChat($('#chat'), 'speaking', { voice: true });
  } else {
    const pts = hist.timeline.filter(t => t.scores).map(t => ({ x: t.at.slice(0, 10), y: t.scores.overall }));
    body.innerHTML = `<div class="card"><h3 style="margin-top:0">Điểm tổng theo thời gian</h3><div id="tl"></div>${dataTable(hist.timeline.map(t => ({ at: fmtDT(t.at), topic: t.topic, dur: t.duration_s + ' s', overall: t.scores ? t.scores.overall : 'chưa chấm', level: t.level || '' })), [['at', 'Ngày'], ['topic', 'Chủ đề'], ['dur', 'Thời lượng'], ['overall', 'Điểm'], ['level', 'Mức']])}</div>
      ${hist.items.map(it => `<div class="card"><b>${esc(it.topic)}</b> <span class="muted small">${fmtDT(it.created_at)} · ${it.duration_s} s</span> ${it.feedback && it.feedback.scores ? `<span class="badge">${it.feedback.scores.overall}/100</span> ${levelBadge(it.feedback.level_estimate)}` : '<span class="badge warn">chưa chấm</span>'}
        ${it.has_audio ? `<p><audio controls src="/api/audio/${it.id}" preload="none"></audio></p>` : ''}<details><summary class="small">Transcript và nhận xét</summary><div class="fr small">${esc(it.transcript)}</div>${it.feedback ? speakingFeedback(it.feedback) : ''}</details></div>`).join('') || '<p class="muted">Chưa có bài nói nào.</p>'}`;
    lineChart($('#tl'), [{ name: 'Tổng', color: 'var(--s3)', points: pts }]);
  }
});

// ---------- writing lab
route('writing', async ([tab = 'task']) => {
  Timer.set('writing', 'writing');
  const [prompts, hist] = await Promise.all([api('GET', '/api/prompts'), api('GET', '/api/writing')]);
  view.innerHTML = `<h1>Writing Lab</h1><div class="tabs">${[['task', 'Bài viết'], ['chat', 'Trợ giúp viết'], ['history', 'Lịch sử']].map(([k, v]) => `<a href="#/writing/${k}" class="${k === tab ? 'active' : ''}">${v}</a>`).join('')}</div><div id="body"></div>`;
  const body = $('#body');
  if (tab === 'task') {
    body.innerHTML = `<div class="card"><label>Đề bài</label><select id="topic"><option value="">Đề tự do…</option>${prompts.writing.map((p, i) => `<option value="${i}">${esc(p.lesson_title)} : ${esc(p.title)} (${p.words} từ)</option>`).join('')}</select>
      <input id="custom" placeholder="Hoặc gõ đề bài của bạn" style="margin-top:8px"><div id="pinfo" class="small"></div>
      <textarea id="text" placeholder="Écrivez ici…" style="min-height:260px"></textarea><p class="row"><span class="muted small" id="wc">0 mots</span><button class="primary" id="send">Gửi để AI sửa và chấm</button></p><div id="fb"></div></div>`;
    const ta = $('#text'); ta.oninput = () => { $('#wc').textContent = `${ta.value.trim().split(/\s+/).filter(Boolean).length} mots`; };
    $('#topic').onchange = () => { const p = prompts.writing[$('#topic').value]; $('#pinfo').innerHTML = p ? `<p class="fr">${esc(p.prompt)}</p><ul class="muted">${p.criteria.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''; };
    $('#send').onclick = async () => {
      if (ta.value.trim().length < 20) return toast('Bài quá ngắn.');
      const p = prompts.writing[$('#topic').value]; const topic = $('#custom').value.trim() || (p ? `${p.lesson_title} : ${p.title}` : 'Sujet libre');
      $('#fb').innerHTML = '<p class="muted">Đang gửi…</p>'; $('#send').disabled = true;
      try { const r = await api('POST', '/api/writing', { topic, lesson_id: p ? p.lesson_id : null, body: ta.value, criteria: p ? p.criteria : [] }); $('#fb').innerHTML = writingFeedback(r.feedback, ta.value); }
      catch (e) { $('#fb').innerHTML = `<p class="badge bad">${esc(e.message)}</p>`; } finally { $('#send').disabled = false; }
    };
  } else if (tab === 'chat') {
    body.innerHTML = '<div class="card"><div id="chat"></div></div>'; await renderChat($('#chat'), 'writing');
  } else {
    body.innerHTML = hist.items.map(it => `<div class="card"><b>${esc(it.topic)}</b> <span class="muted small">${fmtDT(it.created_at)}</span> ${it.feedback && it.feedback.scores ? `<span class="badge">${it.feedback.scores.overall}/100</span> ${levelBadge(it.feedback.level_estimate)}` : '<span class="badge warn">chưa chấm</span>'}<details><summary class="small">Bài và nhận xét</summary>${it.feedback ? writingFeedback(it.feedback, it.body) : `<div class="fr small">${esc(it.body)}</div>`}</details></div>`).join('') || '<p class="muted">Chưa có bài viết nào.</p>';
  }
});

// ---------- DALF C1 mock exam
route('exam', async ([tab = 'oral']) => {
  Timer.set(tab === 'written' ? 'writing' : 'speaking', tab === 'written' ? 'writing' : 'speaking');
  const [ex, sp, wr, an] = await Promise.all([api('GET', '/api/exam'), api('GET', '/api/speaking'), api('GET', '/api/writing'), api('GET', '/api/analytics')]);
  const dalf = sp.items.filter(i => i.topic.startsWith('DALF') && i.feedback && i.feedback.scores).map(i => i.feedback.scores.overall).concat(wr.items.filter(i => i.topic.startsWith('DALF') && i.feedback && i.feedback.scores).map(i => i.feedback.scores.overall));
  const avg = dalf.length ? Math.round(dalf.reduce((a, b) => a + b, 0) / dalf.length) : null;
  const ready = dalf.length >= 3 && avg >= 60 && an.cefr.overall === 'C1';
  view.innerHTML = `<h1>DALF C1 : thi thử</h1><p class="muted small">${esc(ex.disclaimer)}</p>
    <div class="card"><h3 style="margin-top:0">Mức sẵn sàng</h3><p>${ready ? '<span class="badge ok">có thể đăng ký thi thử chính thức</span>' : '<span class="badge warn">chưa sẵn sàng</span>'} · ${dalf.length} bài thi thử đã chấm${avg != null ? `, trung bình ${avg}/100` : ''} · ước tính CEFR ${an.cefr.overall || 'chưa đủ dữ liệu'} ${confBadge(an.cefr.confidence)}</p>
      <p class="muted small">Điều kiện: ít nhất 3 bài thi thử (nói hoặc viết) được AI chấm với trung bình 60/100 trở lên, và ước tính CEFR chung ở C1. Đây là quy tắc của nền tảng, không phải cam kết về kết quả thi.</p></div>
    <div class="tabs">${[['oral', 'Production orale'], ['written', 'Production écrite'], ['structure', 'Cấu trúc kỳ thi']].map(([k, v]) => `<a href="#/exam/${k}" class="${k === tab ? 'active' : ''}">${v}</a>`).join('')}</div><div id="body"></div>`;
  const body = $('#body');
  if (tab === 'structure') body.innerHTML = `<div class="card"><table><tr><th>Épreuve</th><th>Thời gian</th><th>Điểm</th><th>Ghi chú</th></tr>${ex.structure.map(s => `<tr><td>${esc(s.epreuve)}</td><td>${esc(s.duree)}</td><td>${s.points}</td><td class="small">${esc(s.note)}</td></tr>`).join('')}</table><p class="small muted">Tổng 100 điểm, cần 50 để đỗ và tối thiểu 5/25 ở mỗi phần.</p></div>`;
  if (tab === 'oral') {
    body.innerHTML = ex.oral_tasks.map(t => `<div class="card"><h3 style="margin-top:0">${esc(t.title)}</h3><p class="fr small">${esc(t.consigne)}</p>
      <details><summary>Dossier (${t.documents.length} tài liệu)</summary>${t.documents.map(d => `<h4>${esc(d.title)}</h4><div class="fr small">${esc(d.text)}</div>`).join('')}</details>
      <p class="row"><label style="margin:0">Chuẩn bị (phút)</label><input type="number" value="${t.prep_min}" min="5" max="60" style="width:80px" id="prep-${t.id}"><button id="startprep-${t.id}">Bắt đầu chuẩn bị</button><span id="pt-${t.id}" class="time"></span></p>
      <div id="rec-${t.id}"></div><p class="row"><button class="primary" id="send-${t.id}">Nộp exposé (${t.expose_min} phút)</button><a class="btn" href="#/tutor/examiner">Débat với giám khảo</a></p><div id="fb-${t.id}"></div></div>`).join('');
    ex.oral_tasks.forEach(t => {
      const rec = makeRecorder($(`#rec-${t.id}`), { maxSeconds: t.expose_min * 60 + 60 });
      let timer; $(`#startprep-${t.id}`).onclick = () => { clearInterval(timer); let left = +$(`#prep-${t.id}`).value * 60; const el = $(`#pt-${t.id}`); timer = setInterval(() => { left--; el.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`; if (left <= 0) { clearInterval(timer); toast('Hết giờ chuẩn bị. Bắt đầu exposé.'); } }, 1000); };
      $(`#send-${t.id}`).onclick = async () => {
        rec.stop(); const tr = rec.transcript(); if (!tr) return toast('Chưa có transcript.');
        $(`#fb-${t.id}`).innerHTML = '<p class="muted">Đang chấm theo grille DALF C1…</p>';
        try { const r = await api('POST', '/api/speaking', { topic: `DALF C1 : ${t.title}`, duration_s: rec.seconds(), transcript: tr, audio_b64: await rec.audioB64(), rubric: 'dalf_c1' }); $(`#fb-${t.id}`).innerHTML = speakingFeedback(r.feedback); }
        catch (e) { $(`#fb-${t.id}`).innerHTML = `<p class="badge bad">${esc(e.message)}</p>`; }
      };
    });
  }
  if (tab === 'written') {
    body.innerHTML = ex.written_tasks.map(t => `<div class="card"><h3 style="margin-top:0">${esc(t.title)} <span class="badge">${esc(t.words)} · ${t.minutes} phút</span></h3><p class="fr small">${esc(t.consigne)}</p>
      ${t.documents.length ? `<details><summary>Documents</summary>${t.documents.map(d => `<h4>${esc(d.title)}</h4><div class="fr small">${esc(d.text)}</div>`).join('')}</details>` : ''}
      <p class="row"><button id="t-${t.id}">Bắt đầu đếm giờ</button><span class="time" id="tt-${t.id}"></span></p><textarea id="w-${t.id}" style="min-height:260px"></textarea><p class="row"><span class="muted small" id="wc-${t.id}">0 mots</span><button class="primary" id="send-${t.id}">Nộp</button></p><div id="fb-${t.id}"></div></div>`).join('');
    ex.written_tasks.forEach(t => {
      const ta = $(`#w-${t.id}`); ta.oninput = () => { $(`#wc-${t.id}`).textContent = `${ta.value.trim().split(/\s+/).filter(Boolean).length} mots`; };
      let timer; $(`#t-${t.id}`).onclick = () => { clearInterval(timer); let left = t.minutes * 60; timer = setInterval(() => { left--; $(`#tt-${t.id}`).textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`; if (left <= 0) { clearInterval(timer); toast('Hết giờ.'); } }, 1000); };
      $(`#send-${t.id}`).onclick = async () => {
        if (ta.value.trim().length < 20) return toast('Bài quá ngắn.');
        $(`#fb-${t.id}`).innerHTML = '<p class="muted">Đang chấm…</p>';
        try { const r = await api('POST', '/api/writing', { topic: `DALF C1 : ${t.title}`, body: ta.value, criteria: t.criteria }); $(`#fb-${t.id}`).innerHTML = writingFeedback(r.feedback, ta.value); }
        catch (e) { $(`#fb-${t.id}`).innerHTML = `<p class="badge bad">${esc(e.message)}</p>`; }
      };
    });
  }
});

// ---------- analytics
route('analytics', async () => {
  const a = await api('GET', '/api/analytics');
  const cards = Object.entries(a.skills).map(([k, s]) => `<div class="card"><h3 style="margin-top:0"><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${SKILL_COLOR[k]};margin-right:6px"></i>${s.name} ${levelBadge(a.cefr.skills[k].level)} ${confBadge(a.cefr.skills[k].confidence)}</h3>
    <div class="grid c3"><div><div class="label muted small">Gần nhất</div><div class="hero-num">${pct(s.last_score)}</div><div class="muted small">${fmtDate(s.last_at)}</div></div><div><div class="label muted small">TB 30 ngày</div><div class="hero-num">${pct(s.avg30)}</div><div class="muted small">${trendTxt(s.trend)} so với 30 ngày trước</div></div><div><div class="label muted small">Luyện tập</div><div class="hero-num">${s.hours} h</div><div class="muted small">${s.exercises} bài tập · ${s.submissions} bài nộp</div></div></div>
    ${s.errors.length ? `<p class="small"><b>Lỗi thường gặp:</b> ${s.errors.map(e => `${catName(e.category)} ×${e.count}`).join(', ')}</p>` : ''}${s.weak_points.length ? `<p class="small"><b>Thành phần còn yếu:</b> ${s.weak_points.map(esc).join(' · ')}</p>` : ''}<p class="muted small">${esc(a.cefr.skills[k].note)}</p></div>`).join('');
  view.innerHTML = `<h1>Phân tích năng lực</h1>
    <div class="card"><h3 style="margin-top:0">Ước tính CEFR: ${levelBadge(a.cefr.overall)} ${confBadge(a.cefr.confidence)}</h3><p class="muted small">${esc(a.cefr.disclaimer)}</p></div>
    <div class="grid c2">${cards}</div>
    <div class="card"><h3 style="margin-top:0">Điểm đánh giá theo thời gian</h3><div id="lc"></div></div>
    <div class="grid c2"><div class="card"><h3 style="margin-top:0">Lỗi ngữ pháp 90 ngày</h3>${a.grammar.length ? `<table><tr><th>Lỗi</th><th>Số lần</th></tr>${a.grammar.map(g => `<tr><td>${esc(catName(g.category))}</td><td>${g.c}</td></tr>`).join('')}</table>` : '<p class="muted">Chưa có.</p>'}${a.remediation.length ? `<p class="small"><b>Đề xuất ôn:</b> ${a.remediation.map(r => r.lesson_id ? `<a href="#/lesson/${esc(r.lesson_id)}">${esc(r.title)}</a>` : catName(r.category)).join(' · ')}</p>` : ''}</div>
      <div class="card"><h3 style="margin-top:0">Lỗi gần đây</h3>${a.recent_errors.length ? `<table>${a.recent_errors.slice(0, 15).map(e => `<tr><td class="small">${esc(catName(e.category))}</td><td class="fr small">${esc(e.original)} → ${esc(e.correction)}</td><td class="muted small">${esc(e.source)}</td></tr>`).join('')}</table>` : '<p class="muted">Chưa có.</p>'}</div></div>
    <div class="grid c2"><div class="card"><h3 style="margin-top:0">Từ vựng</h3><table>${Object.entries({ 'Tổng': a.vocab.total, 'Mới': a.vocab.new, 'Đang học': a.vocab.learning, 'Đã ghi nhớ': a.vocab.known, 'Đến hạn ôn': a.vocab.due, 'Dùng chủ động': a.vocab.active, 'Trong bài nói': a.vocab.used_speaking, 'Trong bài viết': a.vocab.used_writing }).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table></div>
      <div class="card"><h3 style="margin-top:0">Bài nói theo thời gian</h3><div id="sp"></div></div></div>
    <div class="grid c2"><div class="card"><h3 style="margin-top:0">Phút học 30 ngày</h3><div id="d30"></div></div><div class="card"><h3 style="margin-top:0">Theo tuần</h3><div id="wk"></div></div></div>`;
  lineChart($('#lc'), Object.entries(a.skills).map(([k, s]) => ({ name: s.name, color: SKILL_COLOR[k], points: s.history.map(h => ({ x: h.at.slice(0, 10), y: Math.round(h.score) })) })));
  lineChart($('#sp'), [{ name: 'Điểm tổng', color: 'var(--s3)', points: a.speaking.filter(t => t.scores).map(t => ({ x: t.at.slice(0, 10), y: t.scores.overall })) }]);
  barChart($('#d30'), a.days30.map(x => ({ label: x.day.slice(8), full: x.day, value: x.minutes })), { unit: ' phút' });
  barChart($('#wk'), a.weeks.length ? a.weeks.map(x => ({ label: x.week.slice(5), full: x.week, value: x.minutes })) : [{ label: '', value: 0 }], { unit: ' phút' });
});

// ---------- reports
function isoWeek(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y = t.getUTCFullYear(); const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7); return `${y}-W${String(w).padStart(2, '0')}`; }
function shiftWeek(w, n) { const [y, wk] = w.split('-W').map(Number); const d = new Date(Date.UTC(y, 0, 4)); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1) + (wk - 1 + n) * 7); return isoWeek(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function shiftMonth(m, n) { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
route('report', async ([kind = 'weekly', key]) => {
  if (kind === 'weekly') {
    const week = key || isoWeek(new Date()); const r = await api('GET', `/api/report/weekly?week=${week}`);
    view.innerHTML = `<h1>Báo cáo tuần</h1><div class="tabs"><a href="#/report/weekly" class="active">Tuần</a><a href="#/report/monthly">Tháng</a></div>
      <p class="row"><a class="btn sm" href="#/report/weekly/${shiftWeek(week, -1)}">← tuần trước</a><b>${week}</b> <span class="muted small">${r.start} đến ${r.end}</span><a class="btn sm" href="#/report/weekly/${shiftWeek(week, 1)}">tuần sau →</a></p>
      <div class="grid c4"><div class="tile"><div class="label">Thời gian học</div><div class="hero-num">${fmtH(r.minutes)}</div><div class="sub">${r.plan_pct}% kế hoạch (${fmtH(r.plan_minutes)})</div></div><div class="tile"><div class="label">Bài hoàn thành</div><div class="hero-num">${r.lessons_completed}</div></div><div class="tile"><div class="label">Tiến bộ nhất</div><div class="hero-num" style="font-size:1.2rem">${r.best_skill || '–'}</div></div><div class="tile"><div class="label">Cần cải thiện</div><div class="hero-num" style="font-size:1.2rem">${r.worst_skill || '–'}</div></div></div>
      <div class="grid c2" style="margin-top:14px"><div class="card"><h3 style="margin-top:0">Phút học mỗi ngày</h3><div id="days"></div></div>
        <div class="card"><h3 style="margin-top:0">Kỹ năng (trung bình tuần, so với tuần trước)</h3><table>${Object.values(r.per_skill).map(s => `<tr><td>${s.name}</td><td>${pct(s.avg)}</td><td class="muted small">${s.delta != null ? trendTxt(s.delta) : 'tuần trước không có dữ liệu'}</td></tr>`).join('')}</table></div></div>
      <div class="grid c2"><div class="card"><h3 style="margin-top:0">5 lỗi phổ biến</h3>${r.top_errors.length ? `<table>${r.top_errors.map(e => `<tr><td>${esc(catName(e.category))}</td><td>${e.c}</td></tr>`).join('')}</table>` : '<p class="muted">Không có.</p>'}<p class="small">Từ mới: ${r.vocab_new} · lượt ôn đúng: ${r.vocab_reviews_ok}</p></div>
        <div class="card"><h3 style="margin-top:0">Mục tiêu tuần tới</h3><ul>${r.goals.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div></div>`;
    barChart($('#days'), r.days.map(d => ({ label: d.day.slice(5), full: d.day, value: d.minutes })), { unit: ' phút', labelEvery: 1 });
  } else {
    const month = key || new Date().toISOString().slice(0, 7); const r = await api('GET', `/api/report/monthly?month=${month}`);
    view.innerHTML = `<h1>Báo cáo tháng</h1><div class="tabs"><a href="#/report/weekly">Tuần</a><a href="#/report/monthly" class="active">Tháng</a></div>
      <p class="row"><a class="btn sm" href="#/report/monthly/${shiftMonth(month, -1)}">← tháng trước</a><b>${month}</b><a class="btn sm" href="#/report/monthly/${shiftMonth(month, 1)}">tháng sau →</a></p>
      <div class="grid c4"><div class="tile"><div class="label">Giờ học</div><div class="hero-num">${r.hours} h</div></div><div class="tile"><div class="label">Bài hoàn thành</div><div class="hero-num">${r.lessons_completed}</div></div><div class="tile"><div class="label">Bài nói / viết</div><div class="hero-num">${r.speaking} / ${r.writing}</div></div><div class="tile"><div class="label">Ước tính CEFR</div><div class="hero-num">${r.cefr.overall || '–'}</div><div class="sub">${CONF_VI[r.cefr.confidence]}</div></div></div>
      <div class="card" style="margin-top:14px"><h3 style="margin-top:0">Năng lực theo kỹ năng</h3><table><tr><th>Kỹ năng</th><th>TB tháng</th><th>Số bài đánh giá</th><th>Mức đã thể hiện</th><th>Ước tính 60 ngày</th></tr>${Object.entries(r.per_skill).map(([k, s]) => `<tr><td>${s.name}</td><td>${pct(s.avg)}</td><td>${s.n}</td><td class="small">${Object.entries(s.levels).map(([l, n]) => `${l} ×${n}`).join(', ') || '–'}</td><td>${levelBadge(r.cefr.skills[k].level)} ${confBadge(r.cefr.skills[k].confidence)}</td></tr>`).join('')}</table><p class="muted small">${esc(r.disclaimer)}</p></div>
      <div class="grid c2"><div class="card"><h3 style="margin-top:0">Lỗi trong tháng</h3>${r.errors.length ? `<table>${r.errors.map(e => `<tr><td>${esc(catName(e.category))}</td><td>${e.c}</td></tr>`).join('')}</table>` : '<p class="muted">Không có.</p>'}</div><div class="card"><h3 style="margin-top:0">Từ vựng</h3><p>${r.vocab.total} từ · ${r.vocab.known} đã ghi nhớ · ${r.vocab.active} dùng chủ động</p></div></div>`;
  }
});

// ---------- notes, resources, settings
route('notes', async () => {
  const d = await api('GET', '/api/notes');
  view.innerHTML = `<h1>Ghi chú</h1><div class="card"><textarea id="newNote" placeholder="Ghi chú chung (không gắn bài học)"></textarea><p><button class="primary" id="saveNew">Lưu</button></p></div>
    ${d.notes.map(n => `<div class="card"><b>${esc(n.title || 'Ghi chú chung')}</b> <span class="muted small">${fmtDT(n.updated_at)}</span>${n.lesson_id ? ` · <a href="#/lesson/${esc(n.lesson_id)}" class="small">mở bài</a>` : ''}<textarea data-id="${n.id}" data-lesson="${esc(n.lesson_id || '')}" style="min-height:80px;margin-top:6px">${esc(n.body)}</textarea><p class="row"><button class="sm" data-save="${n.id}">Lưu</button><button class="sm ghost" data-del="${n.id}">Xoá</button></p></div>`).join('') || '<p class="muted">Chưa có ghi chú.</p>'}`;
  $('#saveNew').onclick = async () => { const b = $('#newNote').value.trim(); if (!b) return; await api('PUT', '/api/notes', { body: b }); render(); };
  $$('[data-save]').forEach(b => { b.onclick = async () => { const ta = $(`textarea[data-id="${b.dataset.save}"]`); await api('PUT', '/api/notes', { lesson_id: ta.dataset.lesson || null, body: ta.value }); toast('Đã lưu'); }; });
  $$('[data-del]').forEach(b => { b.onclick = async () => { if (confirm('Xoá ghi chú này?')) { await api('DELETE', `/api/notes/${b.dataset.del}`); render(); } }; });
});
route('resources', async () => {
  const r = await api('GET', '/api/resources');
  view.innerHTML = `<h1>Tài nguyên miễn phí</h1><p class="muted small">${esc(r.note)}</p><div class="grid c2">${r.items.map(i => `<div class="card"><h3 style="margin-top:0"><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.name)}</a> <span class="badge ${i.free_status === 'free' ? 'ok' : 'warn'}">${i.free_status === 'free' ? 'miễn phí' : 'miễn phí một phần'}</span></h3><p class="small">${esc(i.description)}</p><p class="muted small">${esc(i.level)} · ${i.skills.map(s => ACTIVITY_VI[s] || s).join(', ')} · ${esc(i.duration)} · kiểm tra truy cập: ${esc(i.checked)}</p></div>`).join('')}</div>`;
});
route('settings', async () => {
  const p = me.profile, ai = me.ai;
  view.innerHTML = `<h1>Cài đặt</h1><div class="grid c2"><div class="card"><h3 style="margin-top:0">Hồ sơ</h3><form id="pf">
      <label>Tên hiển thị</label><input name="display_name" value="${esc(p.display_name)}" maxlength="80">
      <label>Trình độ hiện tại (ghi nhận)</label><select name="current_level">${['A2', 'B1', 'B2', 'C1'].map(l => `<option ${p.current_level === l ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label>Mục tiêu</label><select name="target_level">${['B2', 'C1', 'C2'].map(l => `<option ${p.target_level === l ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label>Phút học mỗi ngày</label><input name="daily_minutes" type="number" min="30" max="600" value="${p.daily_minutes}">
      <label>Ngôn ngữ giải thích</label><select name="explain_lang"><option value="vi" ${p.explain_lang === 'vi' ? 'selected' : ''}>Tiếng Việt</option><option value="fr" ${p.explain_lang === 'fr' ? 'selected' : ''}>Français</option></select>
      <label>Mục tiêu</label><textarea name="goals" style="min-height:70px">${esc(p.goals)}</textarea>
      <p><button class="primary">Lưu</button></p></form>
      <p class="small">Bài kiểm tra đầu vào: ${p.diagnostic_at ? fmtDate(p.diagnostic_at) + ' · <a href="#/diagnostic">làm lại</a>' : '<a href="#/diagnostic">chưa làm</a>'}</p></div>
    <div class="card"><h3 style="margin-top:0">AI tutor</h3><p>Trạng thái: ${ai.mock ? '<span class="badge warn">mô phỏng</span>' : `<span class="badge ok">sẵn sàng</span> (${esc(ai.provider)} · ${esc(ai.model)})`}</p>
      <p class="small">Để bật AI thật, trên máy chạy server, với khoá Anthropic:</p><pre class="small" style="white-space:pre-wrap;background:var(--surface-2);padding:10px;border-radius:6px">pip install anthropic
export ANTHROPIC_API_KEY=sk-ant-...
python3 server.py</pre>
      <p class="small">Hoặc với khoá DeepSeek (endpoint tương thích Anthropic):</p><pre class="small" style="white-space:pre-wrap;background:var(--surface-2);padding:10px;border-radius:6px">pip install anthropic
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_API_KEY=sk-...
export FA_MODEL=deepseek-flash
python3 server.py</pre><p class="muted small">Ở chế độ mô phỏng, bài nói và bài viết vẫn được lưu nhưng không có điểm; hệ thống không giả lập điểm.</p>
      <h3>Giao diện</h3><p class="row"><button id="themeL">Sáng</button><button id="themeD">Tối</button><button id="themeA">Theo hệ thống</button></p>
      <h3>Dữ liệu</h3><p class="small muted">Mọi dữ liệu nằm trong data/academy.db (SQLite) và data/audio/. Sao lưu bằng cách chép thư mục data/.</p></div></div>`;
  $('#pf').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); await api('PUT', '/api/profile', { display_name: f.get('display_name'), current_level: f.get('current_level'), target_level: f.get('target_level'), daily_minutes: +f.get('daily_minutes'), explain_lang: f.get('explain_lang'), goals: f.get('goals') }); await loadMe(); toast('Đã lưu'); };
  const setTheme = t => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; try { t ? localStorage.setItem('theme', t) : localStorage.removeItem('theme'); } catch (e) { /* storage blocked */ } };
  $('#themeL').onclick = () => setTheme('light'); $('#themeD').onclick = () => setTheme('dark'); $('#themeA').onclick = () => setTheme(null);
});

// ---------- boot
(async () => {
  try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) { /* storage blocked */ }
  await loadMe();
  if (!location.hash) location.hash = me ? '#/dashboard' : '#/';
  render();
})();

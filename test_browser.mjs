// Drives the SPA in headless Chrome over the DevTools protocol and fails on any JS exception.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SHOT_DIR || mkdtempSync(join(tmpdir(), 'fa-shots-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const waitPort = async p => { for (let i = 0; i < 100; i++) { try { await new Promise((ok, no) => { const s = net.connect(p, '127.0.0.1'); s.on('connect', () => { s.end(); ok(); }); s.on('error', no); }); return; } catch { await sleep(100); } } throw new Error('port ' + p); };

const port = await freePort(), cdp = await freePort(), tmp = mkdtempSync(join(tmpdir(), 'fa-'));
const srv = spawn('python3', [join(ROOT, 'server.py')], { env: { ...process.env, FA_DB: join(tmp, 't.db'), FA_PORT: String(port), ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = ''; srv.stdout.on('data', d => { srvLog += d; }); srv.stderr.on('data', d => { srvLog += d; });
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${cdp}`, `--user-data-dir=${join(tmp, 'prof')}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
const errors = [];
try {
  await waitPort(port); await waitPort(cdp);
  let targets = [];
  for (let i = 0; i < 50 && !targets.length; i++) { try { targets = (await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json()).filter(t => t.type === 'page'); } catch { } if (!targets.length) await sleep(100); }
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(a => a.value || a.description).join(' ')); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) + ' in ' + expr.slice(0, 80)); return r.result.result.value; };
  const waitFor = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return; await sleep(120); } throw new Error('timeout waiting ' + expr + ' | view: ' + (await ev(`document.querySelector('#view').innerText.slice(0, 300)`))); };
  const go = async (hash, sel) => { await ev(`location.hash = ${JSON.stringify(hash)}`); await waitFor(`!!document.querySelector(${JSON.stringify(sel)})`); await sleep(150); };
  const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/#/register` });
  await waitFor(`!!document.querySelector('#authForm')`);
  await shot('01-register');
  await ev(`{ const f=document.querySelector('#authForm'); f.username.value='browser_user'; f.password.value='secret123'; f.requestSubmit(); }`);
  await waitFor(`location.hash === '#/onboarding' && !!document.querySelector('#obForm')`);
  await ev(`document.querySelector('#obForm').requestSubmit()`);
  await waitFor(`location.hash === '#/diagnostic' && !!document.querySelector('#go')`);
  await ev(`document.querySelector('#go').click()`);
  for (let i = 0; i < 12; i++) {
    await waitFor(`!!document.querySelector('#next') || document.querySelector('h1')?.textContent.includes('Kết quả')`, 30000);
    if (await ev(`document.querySelector('h1')?.textContent.includes('Kết quả')`)) break;
    await ev(`document.querySelectorAll('#qs .q').forEach(q => { const r = q.querySelector('input[type=radio]'); if (r) r.click(); const g = q.querySelector('input.gap'); if (g) g.value = 'test'; }); document.querySelector('#w') && (document.querySelector('#w').value = 'Le week-end dernier je suis allé au marché.'); document.querySelector('#next').click()`);
    await sleep(200);
  }
  await waitFor(`document.querySelector('h1')?.textContent.includes('Kết quả')`, 30000);
  await shot('02-diagnostic-result');
  await go('#/dashboard', '.hero-num'); await shot('03-dashboard');
  await go('#/path', '.week .lessons a');
  const first = await ev(`document.querySelector('.week .lessons a').getAttribute('href')`);
  await go(first, '#steps a');
  const n = await ev(`document.querySelectorAll('#steps a').length`);
  for (let i = 0; i < n; i++) {
    await ev(`document.querySelector('#steps a[data-i="${i}"]').click()`);
    await waitFor(`document.querySelector('#steps a[data-i="${i}"]').classList.contains('cur')`);
    await sleep(100);
    if (await ev(`!!document.querySelector('#submit')`)) {
      await ev(`document.querySelectorAll('#qs .q').forEach(q => { const r = q.querySelector('input[type=radio]'); if (r) r.click(); const g = q.querySelector('input.gap'); if (g) g.value = 'x'; }); window.confirm = () => true; document.querySelector('#submit').click()`);
      await waitFor(`document.querySelectorAll('#qs .q.ok, #qs .q.bad').length === document.querySelectorAll('#qs .q').length`);
      if (i === 3) await shot('04-lesson-exercise');
    }
    if (await ev(`!!document.querySelector('#saveAll')`)) { await ev(`document.querySelector('#saveAll').click()`); await sleep(500); }
    if (await ev(`!!document.querySelector('#note')`)) { await ev(`{ const t=document.querySelector('#note'); t.value='ma note'; t.dispatchEvent(new Event('input')); }`); }
  }
  await sleep(1200);
  await go('#/vocab', '#addf');
  await ev(`{ const f=document.querySelector('#addf'); f.word.value='la balade'; f.translation.value='cuộc dạo chơi'; f.requestSubmit(); }`);
  await waitFor(`[...document.querySelectorAll('td.fr')].some(td => td.textContent.includes('la balade'))`);
  await ev(`document.querySelector('#review').click()`); await waitFor(`!!document.querySelector('#reveal')`);
  await ev(`document.querySelector('#reveal').click()`); await waitFor(`!!document.querySelector('[data-g="2"]')`); await ev(`document.querySelector('[data-g="2"]').click()`); await sleep(400);
  await shot('05-vocab');
  await go('#/speaking', '#send');
  await ev(`document.querySelector('.transcript').value = 'Bonjour, je m\\'appelle Tham et j\\'habite à Paris depuis deux ans.'; document.querySelector('#send').click()`);
  await waitFor(`!!document.querySelector('#fb .card')`);
  await shot('06-speaking');
  await go('#/writing', '#send');
  await ev(`document.querySelector('#text').value = 'Hier, je suis allé au marché et j\\'ai acheté des pommes parce que je voulais faire une tarte.'; document.querySelector('#send').click()`);
  await waitFor(`!!document.querySelector('#fb .card')`);
  await go('#/tutor/grammar', '#cf-grammar');
  await ev(`{ const f=document.querySelector('#cf-grammar'); f.m.value='Quand utiliser le subjonctif ?'; f.requestSubmit(); }`);
  await waitFor(`document.querySelectorAll('#chat-grammar .msg.assistant').length >= 1 && !document.querySelector('#chat-grammar .msg.assistant').textContent.includes('…')`);
  await go('#/grammar', '#load'); await ev(`document.querySelector('#load').click()`); await waitFor(`!!document.querySelector('#dsub') || document.querySelector('#drill').textContent.length > 10`);
  if (await ev(`!!document.querySelector('#dsub')`)) { await ev(`document.querySelectorAll('#dq .q').forEach(q => { const r = q.querySelector('input[type=radio]'); if (r) r.click(); const g = q.querySelector('input.gap'); if (g) g.value='x'; }); document.querySelector('#dsub').click()`); await waitFor(`document.querySelector('#dres').textContent.includes('/')`); }
  await shot('07-grammar');
  for (const [h, sel, name] of [['#/analytics', '#lc svg', '08-analytics'], ['#/report', '#days svg', '09-report'], ['#/report/monthly', 'table', null], ['#/exam', '#rec-o1', '10-exam'], ['#/exam/written', '#w-w1', null], ['#/exam/structure', 'table', null], ['#/notes', '#newNote', null], ['#/resources', '.card', null], ['#/settings', '#pf', null], ['#/catalog', '.tile', '11-catalog'], ['#/speaking/history', '#tl', null], ['#/writing/history', '.card', null]]) {
    await go(h, sel); if (name) await shot(name);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await go('#/dashboard', '.hero-num'); await shot('12-mobile-dashboard');
  await go(first, '#steps a'); await shot('13-mobile-lesson');
  const overflow = await ev(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
  if (overflow) errors.push('horizontal overflow on mobile lesson page');
  await ev(`document.querySelector('#logoutLink').click()`); await waitFor(`location.hash === '#/'`);
  ws.close();
} catch (e) { errors.push('driver: ' + e.message); }
finally { chrome.kill(); srv.kill(); }
if (srvLog.includes('Traceback')) errors.push('server traceback:\n' + srvLog);
console.log('screenshots in', OUT);
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n---\n')); process.exit(1); }
console.log('BROWSER OK');

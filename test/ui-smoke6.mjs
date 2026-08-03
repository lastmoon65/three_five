// test/ui-smoke6.mjs — 前端冒烟：模式选择 → 6 人房 → 开局 → 牌桌 DOM 校验
import WebSocket from 'ws';

const CDP = 'http://127.0.0.1:9225';
const APP = 'http://127.0.0.1:8095/';
let seq = 0;
const pending = new Map();
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

async function cdp() {
  const list = await (await fetch(CDP + '/json/list')).json();
  let target = list.find((t) => t.type === 'page');
  if (!target) target = await (await fetch(CDP + '/json/new?' + encodeURIComponent(APP), { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
  return { send, ws };
}
async function evalJs(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result && r.result.value;
}

function wsc() {
  return new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:8095/ws');
    const inbox = [];
    ws.on('message', (d) => { try { inbox.push(JSON.parse(String(d))); } catch {} });
    ws.on('open', () => res({ ws, inbox, state: null }));
    ws.on('error', rej);
  });
}
function send(ws, o) { ws.send(JSON.stringify(o)); }
function waitMsg(inbox, type, ms = 8000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function tick() {
      const m = inbox.find((x) => x.type === type);
      if (m) return res(m);
      if (Date.now() - t0 > ms) return rej(new Error('timeout ' + type));
      setTimeout(tick, 25);
    })();
  });
}
async function wsLogin(name) {
  const c = await wsc();
  send(c.ws, { type: 'auth', data: { username: name, password: '123456' } });
  await waitMsg(c.inbox, 'auth_ok');
  send(c.ws, { type: 'leave_room' });
  await sleep(200);
  c.inbox.length = 0;
  c.ws.on('message', (d) => { try { const m = JSON.parse(String(d)); if (m.type === 'game_state') c.state = m.data; } catch {} });
  return c;
}

async function main() {
  log('===== 6 人前端冒烟 =====');
  const c = await cdp();
  await evalJs(c, `location.href = '${APP}'`);
  await sleep(1500);
  // 登录
  await evalJs(c, `document.getElementById('username').value='player1'; document.getElementById('password').value='123456'; document.getElementById('loginBtn').click(); true`);
  await sleep(1200);
  const modeVisible = await evalJs(c, `!document.getElementById('modeView').classList.contains('hidden')`);
  log('✔ 登录后进入模式选择:', modeVisible);
  // 选 6 人模式
  await evalJs(c, `document.getElementById('mode6Btn').click(); true`);
  await sleep(600);
  const hall = await evalJs(c, `({ visible: !document.getElementById('hallView').classList.contains('hidden'), label: document.getElementById('modeLabel').textContent, placeholder: document.getElementById('joinRoomInput').placeholder })`);
  log('✔ 6 人模式大厅:', JSON.stringify(hall));
  // 建房
  await evalJs(c, `document.getElementById('createRoomBtn').click(); true`);
  await sleep(800);
  const roomId = await evalJs(c, `document.getElementById('roomNum').textContent`);
  log('✔ 房号:', roomId, '长度', roomId.length);
  const roomMode = await evalJs(c, `document.getElementById('roomMode').textContent`);
  log('✔ 房间模式标识:', roomMode);
  // 6 人加入并准备
  const others = [];
  for (const n of ['player2', 'player3', 'player4', 'player5', 'player6']) {
    const u = await wsLogin(n);
    send(u.ws, { type: 'join_room', data: { roomId } });
    await waitMsg(u.inbox, 'room_updated');
    send(u.ws, { type: 'ready' });
    others.push(u);
  }
  await evalJs(c, `document.getElementById('readyBtn').click(); true`);
  await sleep(500);
  await evalJs(c, `document.getElementById('startGameBtn').click(); true`);
  await sleep(1500);
  const g = await evalJs(c, `(() => {
    const v = document.getElementById('gameView');
    return {
      phase: document.getElementById('gPhase').textContent,
      mode6: v.classList.contains('mode6'),
      oppCount: document.querySelectorAll('#table .seat.opponent:not(.hidden)').length,
      handCount: document.querySelectorAll('#handCards .card').length,
      top: document.getElementById('seatTop').textContent.trim().replace(/\\s+/g, ' '),
      topL: document.getElementById('seatTopL').textContent.trim().replace(/\\s+/g, ' '),
      topR: document.getElementById('seatTopR').textContent.trim().replace(/\\s+/g, ' '),
      left: document.getElementById('seatLeft').textContent.trim().replace(/\\s+/g, ' '),
      right: document.getElementById('seatRight').textContent.trim().replace(/\\s+/g, ' '),
      hint: document.getElementById('hint').textContent,
    };
  })()`);
  log('✔ 牌桌 DOM:', JSON.stringify(g));
  const ok = g.mode6 && g.oppCount === 5 && g.handCount === 17;
  log(ok ? '===== 冒烟通过 =====' : '===== 冒烟异常 =====');
  for (const o of others) o.ws.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });

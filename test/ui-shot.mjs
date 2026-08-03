// test/ui-shot.mjs — 无头 Chrome 截图：登录→大厅→房间→开局→亮牌→打牌
// 前置：无头 Chrome --remote-debugging-port=9225；net-server 8090
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9225';
const APP = 'http://127.0.0.1:8090/';
const OUT = 'C:\\Users\\zhy70\\.codex\\visualizations\\2026\\08\\03\\019fc558-7a67-7053-a990-0db9a362d400';
const OTHERS = ['player2', 'player3', 'player4'];

let seq = 0;
const pending = new Map();
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

async function cdpConnect() {
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
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result && r.result.value;
}

async function shot(c, name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  log('截图:', name);
}

function wsc() {
  return new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:8090/ws');
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
  await sleep(250);
  c.inbox.length = 0;
  c.ws.on('message', (d) => {
    try {
      const m = JSON.parse(String(d));
      if (m.type === 'game_state') c.state = m.data;
    } catch {}
  });
  return c;
}

async function main() {
  log('===== UI 截图 =====');
  const c = await cdpConnect();
  await evalJs(c, `location.href = '${APP}'`);
  await sleep(1800);
  await shot(c, 'ui-01-login');

  await evalJs(c, `document.getElementById('username').value='player1'; document.getElementById('password').value='123456'; document.getElementById('loginBtn').click(); true`);
  await sleep(1500);
  await shot(c, 'ui-02-hall');

  await evalJs(c, `document.getElementById('createRoomBtn').click(); true`);
  await sleep(900);
  const roomId = await evalJs(c, `document.getElementById('roomNum').textContent`);
  log('房号:', roomId);
  await shot(c, 'ui-03-room');

  const others = [];
  for (const name of OTHERS) {
    const cc = await wsLogin(name);
    send(cc.ws, { type: 'join_room', data: { roomId } });
    await waitMsg(cc.inbox, 'room_updated');
    send(cc.ws, { type: 'ready' });
    others.push(cc);
  }
  await evalJs(c, `document.getElementById('readyBtn').click(); true`);
  await sleep(500);
  await evalJs(c, `document.getElementById('startGameBtn').click(); true`);
  await sleep(1500);
  log('开局阶段:', await evalJs(c, `document.getElementById('gPhase').textContent`));
  await shot(c, 'ui-04-game-reveal');

  let guard = 0;
  while (guard < 8) {
    const st = others[0].state;
    if (!st || st.phase !== 'reveal') break;
    const actor = st.revealActor;
    if (actor == null) break;
    if (actor === 0) {
      await evalJs(c, `[...document.querySelectorAll('#buttons button')].find(b=>b.textContent.includes('跳过'))?.click(); true`);
    } else {
      const who = others.find((o) => o.state && o.state.me === actor) || others[actor - 1];
      send(who.ws, { type: 'reveal', data: { cardIds: null } });
    }
    guard++;
    await sleep(700);
  }
  await sleep(800);
  log('亮牌后阶段:', await evalJs(c, `document.getElementById('gPhase').textContent`));

  let st = others[0].state;
  if (st && st.phase === 'bury') {
    if (st.dealerIndex === 0) {
      for (let i = 0; i < 6; i++) {
        await evalJs(c, `(()=>{const cs=[...document.querySelectorAll('#handCards .card')].filter(x=>!x.classList.contains('scoring')&&!x.classList.contains('selected')); if(cs[0]) cs[0].click(); return true;})()`);
        await sleep(150);
      }
      await evalJs(c, `[...document.querySelectorAll('#buttons button')].find(b=>b.textContent.includes('确认埋底'))?.click(); true`);
    } else {
      const dealer = others.find((o) => o.state.me === st.dealerIndex) || others[st.dealerIndex - 1];
      const ds = dealer.state;
      const buryIds = ds.myHand.filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
      send(dealer.ws, { type: 'bury', data: { cardIds: buryIds } });
    }
    await sleep(1200);
    log('埋底后阶段:', await evalJs(c, `document.getElementById('gPhase').textContent`));
  }

  guard = 0;
  while (guard < 60) {
    st = others[0].state;
    if (!st || st.phase !== 'trick') break;
    if (st.currentSeat === 0) break;
    const who = others.find((o) => o.state.me === st.currentSeat) || others[st.currentSeat - 1];
    const ws_st = who.state;
    if (!ws_st.legalPlays || !ws_st.legalPlays.length) break;
    send(who.ws, { type: 'play', data: { cardIds: ws_st.legalPlays[0].cardIds } });
    guard++;
    await sleep(600);
  }
  await sleep(600);
  log('打牌阶段当前行动者:', st && st.currentSeat);
  await shot(c, 'ui-05-game-trick');

  for (const o of others) o.ws.close();
  log('===== 截图完成 =====');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });

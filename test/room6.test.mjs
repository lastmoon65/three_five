// test/room6.test.mjs — 6 人房间模式（V9：模式隔离、6 位房号、6 座开局）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startNetServer } from '../net-server.mjs';

let app, port;
const sockets = [];
before(async () => { app = await startNetServer({ port: 0 }); port = app.port; });
after(async () => {
  for (const s of sockets) { try { s.close(); } catch {} }
  await new Promise((r) => setTimeout(r, 150));
  await app.close();
});

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const inbox = [];
    ws.addEventListener('message', (e) => { try { inbox.push(JSON.parse(String(e.data))); } catch {} });
    ws.addEventListener('open', () => { sockets.push(ws); resolve({ ws, inbox }); });
    ws.addEventListener('error', reject);
  });
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function waitMsg(inbox, type, ms = 6000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const m = inbox.find((x) => x.type === type);
      if (m) return resolve(m);
      if (Date.now() - t0 > ms) return reject(new Error('timeout ' + type));
      setTimeout(tick, 20);
    })();
  });
}
function waitError(inbox, code, ms = 6000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const m = [...inbox].reverse().find((x) => x.type === 'error' && x.data.code === code);
      if (m) return resolve(m);
      if (Date.now() - t0 > ms) return reject(new Error('timeout error ' + code));
      setTimeout(tick, 20);
    })();
  });
}
async function login(name) {
  const c = await connect();
  send(c.ws, { type: 'auth', data: { username: name, password: '123456' } });
  await waitMsg(c.inbox, 'auth_ok');
  send(c.ws, { type: 'leave_room' });
  await new Promise((r) => setTimeout(r, 200));
  c.inbox.length = 0;
  return c;
}

test('p6 建房：6 位房号 + 6 个空座 + mode=p6', async () => {
  const a = await login('player1');
  send(a.ws, { type: 'create_room', data: { mode: 'p6' } });
  const m = await waitMsg(a.inbox, 'room_updated');
  assert.match(m.data.roomId, /^\d{6}$/);
  assert.equal(m.data.mode, 'p6');
  assert.equal(m.data.seats.length, 6);
  assert.equal(m.data.seats.filter(Boolean).length, 1);
});

test('p4 建房：4 位房号 + 4 个空座 + mode=p4', async () => {
  const a = await login('player1');
  send(a.ws, { type: 'create_room', data: { mode: 'p4' } });
  const m = await waitMsg(a.inbox, 'room_updated');
  assert.match(m.data.roomId, /^\d{4}$/);
  assert.equal(m.data.mode, 'p4');
  assert.equal(m.data.seats.length, 4);
});

test('p6 房间坐满 6 人后才能开局；5 人时 NOT_READY', async () => {
  const users = [];
  for (const n of ['player1', 'player2', 'player3', 'player4', 'player5']) {
    users.push(await login(n));
  }
  send(users[0].ws, { type: 'create_room', data: { mode: 'p6' } });
  const created = await waitMsg(users[0].inbox, 'room_updated');
  for (let i = 1; i < 5; i++) {
    send(users[i].ws, { type: 'join_room', data: { roomId: created.data.roomId } });
    await waitMsg(users[i].inbox, 'room_updated');
  }
  for (const u of users) send(u.ws, { type: 'ready' });
  await new Promise((r) => setTimeout(r, 300));
  send(users[0].ws, { type: 'start_game' });
  await waitError(users[0].inbox, 'NOT_READY', 6000);

  const sixth = await login('player6');
  send(sixth.ws, { type: 'join_room', data: { roomId: created.data.roomId } });
  await waitMsg(sixth.inbox, 'room_updated');
  send(sixth.ws, { type: 'ready' });
  await new Promise((r) => setTimeout(r, 400));
  send(users[0].ws, { type: 'start_game' });
  const gs = await waitMsg(users[0].inbox, 'game_state');
  assert.equal(gs.data.phase, 'reveal');
  assert.deepEqual(gs.data.handCounts, [17, 17, 17, 17, 17, 17]);
  assert.equal(gs.data.mode, 'p6');
  assert.equal(gs.data.myHand.length, 17);
});

test('房号位数即模式：6 位房号不能当作 p4 房加入', async () => {
  const a = await login('player1');
  send(a.ws, { type: 'create_room', data: { mode: 'p6' } });
  const created = await waitMsg(a.inbox, 'room_updated');
  // 用 4 位房号加入（不可能命中 6 位房号）→ ROOM_NOT_FOUND
  const b = await login('player2');
  send(b.ws, { type: 'join_room', data: { roomId: '0000' } });
  await waitError(b.inbox, 'ROOM_NOT_FOUND');
  assert.ok(created.data.roomId.length === 6);
});

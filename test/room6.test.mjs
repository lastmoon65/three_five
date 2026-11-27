// test/room6.test.mjs — 6 人房间：统一 6 位房号、mode 区分、满 6 人开局
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTS } from '../config.mjs';
import { startNetServer } from '../net-server.mjs';

const P6 = ['player1', 'player2', 'player3', 'player4', 'player5', 'erxiao'];

function creds(name) {
  const a = ACCOUNTS.find((x) => x.username === name);
  if (!a) throw new Error('missing account');
  return { username: a.username, password: a.password };
}

let app, port;
const sockets = [];
before(async () => { app = await startNetServer({ port: 0 }); port = app.port; });
after(async () => {
  for (const s of sockets) { try { s.close(); } catch { /* 忽略 */ } }
  await new Promise((r) => setTimeout(r, 150));
  await app.close();
});
afterEach(async () => {
  for (const s of sockets) { try { s.close(); } catch { /* 忽略 */ } }
  sockets.length = 0;
  await new Promise((r) => setTimeout(r, 60));
  app._testReset();
});

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const inbox = [];
    ws.addEventListener('message', (e) => { try { inbox.push(JSON.parse(String(e.data))); } catch { /* 忽略 */ } });
    ws.addEventListener('open', () => { sockets.push(ws); resolve({ ws, inbox }); });
    ws.addEventListener('error', (e) => reject(e));
  });
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function waitMsg(inbox, type, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const m = inbox.find((x) => x.type === type);
      if (m) return resolve(m);
      if (Date.now() - t0 > timeout) return reject(new Error('timeout waiting ' + type));
      setTimeout(tick, 20);
    })();
  });
}
function waitUntil(inbox, predicate, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const m = [...inbox].reverse().find(predicate);
      if (m) return resolve(m);
      if (Date.now() - t0 > timeout) return reject(new Error('timeout predicate'));
      setTimeout(tick, 20);
    })();
  });
}
function waitError(inbox, code, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const m = [...inbox].reverse().find((x) => x.type === 'error' && x.data.code === code);
      if (m) return resolve(m);
      if (Date.now() - t0 > timeout) return reject(new Error('timeout error ' + code));
      setTimeout(tick, 20);
    })();
  });
}
async function login(name) {
  const c = await connect();
  send(c.ws, { type: 'auth', data: creds(name) });
  const ok = await waitMsg(c.inbox, 'auth_ok');
  return { ws: c.ws, inbox: c.inbox, token: ok.data.token, user: ok.data.user.username };
}

async function setupMode(mode, names) {
  const users = [];
  const host = await login(names[0]);
  send(host.ws, { type: 'create_room', data: { mode } });
  const created = await waitMsg(host.inbox, 'room_updated');
  users.push({ ...host, seat: 0 });
  for (let i = 1; i < names.length; i++) {
    const u = await login(names[i]);
    send(u.ws, { type: 'join_room', data: { roomId: created.data.roomId, mode } });
    await waitMsg(u.inbox, 'room_updated');
    const seats = [...u.inbox].reverse().find((m) => m.type === 'room_updated').data.seats;
    users.push({ ...u, seat: seats.findIndex((s) => s && s.userId === names[i]) });
  }
  return { users, roomId: created.data.roomId, created: created.data };
}

test('p6 建房：6 位房号 + 6 个座位 + mode=p6', async () => {
  const host = await login(P6[0]);
  send(host.ws, { type: 'create_room', data: { mode: 'p6' } });
  const m = await waitMsg(host.inbox, 'room_updated');
  assert.equal(m.data.mode, 'p6');
  assert.match(m.data.roomId, /^\d{6}$/);
  assert.equal(m.data.seats.length, 6);
  assert.equal(m.data.seats.filter(Boolean).length, 1);
  assert.equal(m.data.hostSeatId, 0);
});

test('未指定 mode 的建房仍为 p4，房号同样 6 位（不回退为 4 位）', async () => {
  const host = await login(P6[0]);
  send(host.ws, { type: 'create_room' });
  const m = await waitMsg(host.inbox, 'room_updated');
  assert.equal(m.data.mode, 'p4');
  assert.match(m.data.roomId, /^\d{6}$/);
  assert.equal(m.data.seats.length, 4);
});

test('p4 显式建房也是 6 位房号、4 个座位', async () => {
  const host = await login(P6[0]);
  send(host.ws, { type: 'create_room', data: { mode: 'p4' } });
  const m = await waitMsg(host.inbox, 'room_updated');
  assert.equal(m.data.mode, 'p4');
  assert.match(m.data.roomId, /^\d{6}$/);
  assert.equal(m.data.seats.length, 4);
});

test('p6 房间 5 人不能开局；6 人全部准备后房主可开局', async () => {
  const { users, created } = await setupMode('p6', P6.slice(0, 5));
  assert.equal(created.seats.length, 6);
  for (const u of users) send(u.ws, { type: 'ready' });
  await waitUntil(users[0].inbox, (m) => m.type === 'room_updated' && m.data.seats.filter((s) => s && s.ready).length === 5);
  send(users[0].ws, { type: 'start_game' });
  const err = await waitError(users[0].inbox, 'NOT_READY');
  assert.match(err.data.message, /6 人/);

  const sixth = await login(P6[5]);
  send(sixth.ws, { type: 'join_room', data: { roomId: created.roomId, mode: 'p6' } });
  await waitMsg(sixth.inbox, 'room_updated');
  send(sixth.ws, { type: 'ready' });
  await waitUntil(users[0].inbox, (m) => m.type === 'room_updated' && m.data.seats.every((s) => s && s.ready && s.connected));
  send(users[0].ws, { type: 'start_game' });
  const gs = await waitUntil(users[0].inbox, (m) => m.type === 'game_state');
  assert.equal(gs.data.phase, 'reveal');
  assert.equal(gs.data.mode, 'p6');
  assert.equal(gs.data.myHand.length, 17);
  assert.deepEqual(gs.data.handCounts, [17, 17, 17, 17, 17, 17]);
});

test('用 p4 模式加入 p6 房间返回 JOIN_MODE_MISMATCH', async () => {
  const host = await login(P6[0]);
  send(host.ws, { type: 'create_room', data: { mode: 'p6' } });
  const created = await waitMsg(host.inbox, 'room_updated');
  const u = await login(P6[1]);
  send(u.ws, { type: 'join_room', data: { roomId: created.data.roomId, mode: 'p4' } });
  await waitError(u.inbox, 'JOIN_MODE_MISMATCH');
});

// test/room.test.mjs — M2 房间契约测试
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startNetServer } from '../net-server.mjs';

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
      if (Date.now() - t0 > timeout) return reject(new Error('timeout waiting ' + type + ' inbox=' + JSON.stringify(inbox)));
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
      if (Date.now() - t0 > timeout) return reject(new Error('timeout predicate inbox=' + JSON.stringify(inbox)));
      setTimeout(tick, 20);
    })();
  });
}

async function login(name) {
  const c = await connect();
  send(c.ws, { type: 'auth', data: { username: name, password: '123456' } });
  const ok = await waitMsg(c.inbox, 'auth_ok');
  return { ws: c.ws, inbox: c.inbox, token: ok.data.token, user: ok.data.user.username };
}

test('建房返回 4 位房号与房主席位', async () => {
  const u = await login('player1');
  send(u.ws, { type: 'create_room' });
  const m = await waitMsg(u.inbox, 'room_updated');
  assert.match(m.data.roomId, /^\d{4}$/);
  assert.equal(m.data.phase, 'waiting');
  assert.equal(m.data.hostSeatId, 0);
  assert.equal(m.data.seats[0].userId, 'player1');
  assert.equal(m.data.seats[0].isHost, true);
});

test('加入房间：双方收到含 2 个座位的 room_updated', async () => {
  const a = await login('player1');
  const b = await login('player2');
  send(a.ws, { type: 'create_room' });
  const created = await waitMsg(a.inbox, 'room_updated');
  send(b.ws, { type: 'join_room', data: { roomId: created.data.roomId } });
  const ma = await waitUntil(a.inbox, (m) => m.type === 'room_updated' && m.data.seats.filter(Boolean).length === 2);
  const mb = await waitUntil(b.inbox, (m) => m.type === 'room_updated' && m.data.seats.filter(Boolean).length === 2);
  assert.equal(ma.data.seats[1].userId, 'player2');
  assert.equal(mb.data.seats[1].userId, 'player2');
});

test('加入不存在的房间返回 ROOM_NOT_FOUND', async () => {
  const u = await login('player3');
  send(u.ws, { type: 'join_room', data: { roomId: '000000' } });
  const m = await waitMsg(u.inbox, 'error');
  assert.equal(m.data.code, 'ROOM_NOT_FOUND');
});

test('房间满员返回 ROOM_FULL', async () => {
  const a = await login('player1');
  send(a.ws, { type: 'create_room' });
  const created = await waitMsg(a.inbox, 'room_updated');
  for (const name of ['player2', 'player3', 'player4']) {
    const u = await login(name);
    send(u.ws, { type: 'join_room', data: { roomId: created.data.roomId } });
    await waitMsg(u.inbox, 'room_updated');
  }
  const fifth = await login('player5');
  send(fifth.ws, { type: 'join_room', data: { roomId: created.data.roomId } });
  const m = await waitMsg(fifth.inbox, 'error');
  assert.equal(m.data.code, 'ROOM_FULL');
});

test('准备/取消准备广播', async () => {
  const a = await login('player1');
  send(a.ws, { type: 'create_room' });
  await waitMsg(a.inbox, 'room_updated');
  send(a.ws, { type: 'ready' });
  const m = await waitUntil(a.inbox, (x) => x.type === 'room_updated' && x.data.seats[0].ready === true);
  assert.ok(m);
  send(a.ws, { type: 'ready' });
  const m2 = await waitUntil(a.inbox, (x) => x.type === 'room_updated' && x.data.seats[0].ready === false);
  assert.ok(m2);
});

test('非房主离开后席位释放', async () => {
  const a = await login('player1');
  const b = await login('player2');
  send(a.ws, { type: 'create_room' });
  const created = await waitMsg(a.inbox, 'room_updated');
  send(b.ws, { type: 'join_room', data: { roomId: created.data.roomId } });
  await waitUntil(a.inbox, (m) => m.type === 'room_updated' && m.data.seats.filter(Boolean).length === 2);
  send(b.ws, { type: 'leave_room' });
  const ma = await waitUntil(a.inbox, (m) => m.type === 'room_updated' && m.data.seats.filter(Boolean).length === 1);
  assert.equal(ma.data.seats[1], null);
});

test('房主离开：全员收到 room_dissolved', async () => {
  const a = await login('player1');
  const b = await login('player2');
  send(a.ws, { type: 'create_room' });
  const created = await waitMsg(a.inbox, 'room_updated');
  send(b.ws, { type: 'join_room', data: { roomId: created.data.roomId } });
  await waitMsg(b.inbox, 'room_updated');
  send(a.ws, { type: 'leave_room' });
  const ma = await waitMsg(a.inbox, 'room_dissolved');
  const mb = await waitMsg(b.inbox, 'room_dissolved');
  assert.equal(ma.data.reason, 'HOST_LEFT');
  assert.equal(mb.data.roomId, created.data.roomId);
});

test('房间阶段断线标记离线，token 重连恢复', async () => {
  const a = await login('player1');
  const b = await login('player2');
  send(a.ws, { type: 'create_room' });
  const created = await waitMsg(a.inbox, 'room_updated');
  send(b.ws, { type: 'join_room', data: { roomId: created.data.roomId } });
  await waitMsg(b.inbox, 'room_updated');
  // b 断线
  b.ws.close();
  const ma = await waitUntil(a.inbox, (m) => m.type === 'room_updated' && m.data.seats[1] && m.data.seats[1].connected === false);
  assert.ok(ma);
  // b 用 token 重连
  const b2 = await connect();
  send(b2.ws, { type: 'auth', data: { token: b.token } });
  const ok = await waitMsg(b2.inbox, 'auth_ok');
  assert.equal(ok.data.user.username, 'player2');
  const rb = await waitUntil(b2.inbox, (m) => m.type === 'room_updated' && m.data.seats[1] && m.data.seats[1].userId === 'player2' && m.data.seats[1].connected === true);
  assert.ok(rb);
  const ra = await waitUntil(a.inbox, (m) => m.type === 'room_updated' && m.data.seats[1] && m.data.seats[1].connected === true);
  assert.ok(ra);
});

test('未登录操作返回 AUTH_REQUIRED', async () => {
  const { ws, inbox } = await connect();
  send(ws, { type: 'create_room' });
  const m = await waitMsg(inbox, 'error');
  assert.equal(m.data.code, 'AUTH_REQUIRED');
});

// ---------- 换位（3/4 号位） ----------
test('互换 3/4 号位：玩家互换，准备状态跟随玩家', async () => {
  const a = await login('player1');
  send(a.ws, { type: 'create_room' });
  const created = await waitMsg(a.inbox, 'room_updated');
  const users = {};
  for (const name of ['player2', 'player3', 'player4']) {
    users[name] = await login(name);
    send(users[name].ws, { type: 'join_room', data: { roomId: created.data.roomId } });
    await waitMsg(users[name].inbox, 'room_updated');
  }
  // player3 在 3 号位（seat2），先准备
  send(users.player3.ws, { type: 'ready' });
  await waitUntil(a.inbox, (m) => m.type === 'room_updated' && m.data.seats[2] && m.data.seats[2].ready === true);
  // player4 发起换位 seat2 <-> seat3
  send(users.player4.ws, { type: 'swap_seats', data: { a: 2, b: 3 } });
  const m = await waitUntil(a.inbox, (m) => m.type === 'room_updated' && m.data.seats[3] && m.data.seats[3].userId === 'player3');
  assert.equal(m.data.seats[2].userId, 'player4');
  assert.equal(m.data.seats[2].ready, false);
  assert.equal(m.data.seats[3].ready, true); // 准备状态跟随 player3 移动
});

test('未在房间换位返回 NOT_IN_ROOM', async () => {
  const u = await login('player1');
  send(u.ws, { type: 'swap_seats', data: { a: 2, b: 3 } });
  const m = await waitMsg(u.inbox, 'error');
  assert.equal(m.data.code, 'NOT_IN_ROOM');
});

test('换位涉及房主返回 HOST_FIXED', async () => {
  const a = await login('player1');
  send(a.ws, { type: 'create_room' });
  await waitMsg(a.inbox, 'room_updated');
  send(a.ws, { type: 'swap_seats', data: { a: 0, b: 2 } });
  const m = await waitMsg(a.inbox, 'error');
  assert.equal(m.data.code, 'HOST_FIXED');
});

test('换空位：3 人时 4 号位玩家可挪到 3 号位', async () => {
  const a = await login('player1');
  send(a.ws, { type: 'create_room' });
  const created = await waitMsg(a.inbox, 'room_updated');
  for (const name of ['player2', 'player3']) {
    const u = await login(name);
    send(u.ws, { type: 'join_room', data: { roomId: created.data.roomId } });
    await waitMsg(u.inbox, 'room_updated');
  }
  // seats: p1(0) p2(1) p3(2) 空(3)
  const c = await login('player3');
  send(c.ws, { type: 'swap_seats', data: { a: 2, b: 3 } });
  const m = await waitUntil(a.inbox, (x) => x.type === 'room_updated' && x.data.seats[3] && x.data.seats[3].userId === 'player3');
  assert.equal(m.data.seats[2], null);
});

// ---------- 其他边界 ----------
test('已在房间再建房返回 ALREADY_IN_ROOM', async () => {
  const a = await login('player1');
  send(a.ws, { type: 'create_room' });
  await waitMsg(a.inbox, 'room_updated');
  send(a.ws, { type: 'create_room' });
  const m = await waitMsg(a.inbox, 'error');
  assert.equal(m.data.code, 'ALREADY_IN_ROOM');
});

test('同账号二次登录（顶号）后席位由新连接接管', async () => {
  const a = await login('player1');
  send(a.ws, { type: 'create_room' });
  const created = await waitMsg(a.inbox, 'room_updated');
  const b = await login('player2');
  send(b.ws, { type: 'join_room', data: { roomId: created.data.roomId } });
  await waitUntil(a.inbox, (m) => m.type === 'room_updated' && m.data.seats.filter(Boolean).length === 2);
  const a2 = await login('player1');
  const m = await waitUntil(a2.inbox, (m) => m.type === 'room_updated' && m.data.seats[0] && m.data.seats[0].userId === 'player1' && m.data.seats[0].connected === true);
  assert.ok(m);
  const kicked = await waitMsg(a.inbox, 'kicked');
  assert.equal(kicked.data.reason, 'NEW_SESSION');
});

test('房主断线不解散，成员见房主离线；重连恢复房主身份', async () => {
  const a = await login('player1');
  send(a.ws, { type: 'create_room' });
  const created = await waitMsg(a.inbox, 'room_updated');
  const b = await login('player2');
  send(b.ws, { type: 'join_room', data: { roomId: created.data.roomId } });
  await waitMsg(b.inbox, 'room_updated');
  a.ws.close(); // 房主断线
  const mb = await waitUntil(b.inbox, (m) => m.type === 'room_updated' && m.data.seats[0] && m.data.seats[0].connected === false);
  assert.ok(mb); // 房间未解散
  const a2 = await connect();
  send(a2.ws, { type: 'auth', data: { token: a.token } });
  await waitMsg(a2.inbox, 'auth_ok');
  const ra = await waitUntil(a2.inbox, (m) => m.type === 'room_updated' && m.data.seats[0] && m.data.seats[0].userId === 'player1' && m.data.seats[0].isHost === true && m.data.seats[0].connected === true);
  assert.ok(ra);
  const rb = await waitUntil(b.inbox, (m) => m.type === 'room_updated' && m.data.seats[0] && m.data.seats[0].connected === true);
  assert.ok(rb);
});
test('离线玩家重连后保留准备状态', async () => {
  const a = await login('player1');
  send(a.ws, { type: 'create_room' });
  const created = await waitMsg(a.inbox, 'room_updated');
  const b = await login('player2');
  send(b.ws, { type: 'join_room', data: { roomId: created.data.roomId } });
  await waitMsg(b.inbox, 'room_updated');
  send(b.ws, { type: 'ready' });
  await waitUntil(a.inbox, (m) => m.type === 'room_updated' && m.data.seats[1] && m.data.seats[1].ready === true);
  b.ws.close(); // 断线
  await waitUntil(a.inbox, (m) => m.type === 'room_updated' && m.data.seats[1] && m.data.seats[1].connected === false && m.data.seats[1].ready === true);
  const b2 = await connect();
  send(b2.ws, { type: 'auth', data: { token: b.token } });
  await waitMsg(b2.inbox, 'auth_ok');
  const m = await waitUntil(b2.inbox, (m) => m.type === 'room_updated' && m.data.seats[1] && m.data.seats[1].connected === true);
  assert.equal(m.data.seats[1].ready, true); // 准备状态保留
});

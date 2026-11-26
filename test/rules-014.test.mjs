// test/rules-014.test.mjs — 4 人 P0 对局中任意参赛者离线暂停，房间阶段不误伤
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startNetServer } from '../net-server.mjs';
import { ACCOUNTS } from '../config.mjs';

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

function passwordFor(username) {
  const acc = ACCOUNTS.find((a) => a.username === username);
  if (!acc) throw new Error('missing test account: ' + username);
  return acc.password;
}

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
function waitError(inbox, code, timeout = 6000) {
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
function waitNewestGame(inbox, checkFn, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const newest = [...inbox].reverse().find((m) => m.type === 'game_state');
      if (newest && checkFn(newest.data)) return resolve(newest);
      if (Date.now() - t0 > timeout) return reject(new Error('timeout newest game_state'));
      setTimeout(tick, 20);
    })();
  });
}
function waitUntil(inbox, predicate, timeout = 3000) {
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
async function login(name) {
  const c = await connect();
  send(c.ws, { type: 'auth', data: { username: name, password: passwordFor(name) } });
  const ok = await waitMsg(c.inbox, 'auth_ok');
  return { ws: c.ws, inbox: c.inbox, token: ok.data.token, user: ok.data.user.username };
}
async function setup4() {
  const names = ['player1', 'player2', 'player3', 'player4'];
  const users = [];
  const host = await login(names[0]);
  send(host.ws, { type: 'create_room' });
  const created = await waitMsg(host.inbox, 'room_updated');
  users.push({ ...host, seat: 0 });
  for (let i = 1; i < 4; i++) {
    const u = await login(names[i]);
    send(u.ws, { type: 'join_room', data: { roomId: created.data.roomId } });
    await waitMsg(u.inbox, 'room_updated');
    const seats = [...u.inbox].reverse().find((m) => m.type === 'room_updated').data.seats;
    users.push({ ...u, seat: seats.findIndex((s) => s && s.userId === names[i]) });
  }
  return { users, roomId: created.data.roomId };
}
async function readyAll(users) {
  for (const u of users) send(u.ws, { type: 'ready' });
  await waitUntil(users[0].inbox, (m) => m.type === 'room_updated' && m.data.seats.every((s) => s && s.ready && s.connected));
}
async function startGame(users) {
  send(users[0].ws, { type: 'start_game' });
  const states = [];
  for (const u of users) {
    const m = await waitUntil(u.inbox, (x) => x.type === 'game_state');
    states.push(m.data);
  }
  return states;
}

function isPausedMessage(message) {
  return /已离线|等待重连/.test(message || '');
}

test('对局中非行动者离线：全员进入本副暂停，写操作被拒绝', async () => {
  const { users } = await setup4();
  await readyAll(users);
  await startGame(users);
  const st = await waitNewestGame(users[0].inbox, (d) => d.phase === 'reveal');
  const actor = st.data.revealActor;
  const actorUser = users.find((u) => u.seat === actor);
  const offlineUser = users.find((u) => u.seat !== actor);
  const onlineOthers = users.filter((u) => u !== offlineUser);
  assert.ok(actorUser && offlineUser && offlineUser.seat !== actor);

  offlineUser.ws.close();
  for (const u of onlineOthers) {
    const paused = await waitNewestGame(u.inbox, (d) => d.seats && d.seats[offlineUser.seat] && d.seats[offlineUser.seat].connected === false);
    assert.equal(paused.data.phase, 'reveal');
    assert.equal(isPausedMessage(paused.data.message), true);
  }

  send(actorUser.ws, { type: 'reveal', data: { cardIds: null } });
  const blocked = await waitError(actorUser.inbox, 'GAME_PAUSED');
  assert.match(blocked.data.message, /暂停|等待重连/);
  const still = await waitNewestGame(actorUser.inbox, (d) => d.phase === 'reveal');
  assert.equal(still.data.phase, 'reveal');
  assert.equal(isPausedMessage(still.data.message), true);
});

test('对局中行动者离线：其余人仍进入本副暂停，重连后可继续', async () => {
  const { users } = await setup4();
  await readyAll(users);
  await startGame(users);
  const st = await waitNewestGame(users[0].inbox, (d) => d.phase === 'reveal');
  const actor = st.data.revealActor;
  const actorUser = users.find((u) => u.seat === actor);
  const other = users.find((u) => u.seat !== actor);
  const beforeSeq = [...other.inbox].reverse().find((x) => x.type === 'game_state').data.seq;

  actorUser.ws.close();
  const paused = await waitNewestGame(other.inbox, (d) => d.seats && d.seats[actor] && d.seats[actor].connected === false);
  assert.equal(isPausedMessage(paused.data.message), true);
  assert.equal(paused.data.phase, 'reveal');

  send(other.ws, { type: 'reveal', data: { cardIds: null } });
  const blocked = await waitError(other.inbox, 'GAME_PAUSED');
  assert.match(blocked.data.message, /暂停|等待重连/);

  const r = await connect();
  send(r.ws, { type: 'auth', data: { token: actorUser.token } });
  await waitMsg(r.inbox, 'auth_ok');
  const gs = await waitNewestGame(r.inbox, (d) => d.me === actor && d.phase === 'reveal' && d.seats[actor].connected === true);
  assert.equal(isPausedMessage(gs.data.message), false);

  send(r.ws, { type: 'reveal', data: { cardIds: null } });
  const next = await waitNewestGame(other.inbox, (d) => d.revealActor != null && d.revealActor !== actor);
  assert.ok(next.data.seq > beforeSeq, '重连后 seq 必须继续递增');
  r.ws.close();
});

test('房间阶段断线只标记离线，其余人仍可准备，不进入对局暂停', async () => {
  const { users, roomId } = await setup4();
  const leaver = users[1];
  const host = users[0];
  leaver.ws.close();
  const updated = await waitUntil(host.inbox, (m) => m.type === 'room_updated' && m.data.seats[leaver.seat] && m.data.seats[leaver.seat].connected === false);
  assert.equal(updated.data.phase, 'waiting');
  assert.equal(updated.data.roomId, roomId);
  const hasPausedGame = host.inbox.some((m) => m.type === 'game_state' && isPausedMessage(m.data && m.data.message));
  assert.equal(hasPausedGame, false);

  send(host.ws, { type: 'ready' });
  const afterReady = await waitUntil(host.inbox, (m) => m.type === 'room_updated' && m.data.seats[0] && m.data.seats[0].ready === true);
  assert.equal(afterReady.data.phase, 'waiting');
  assert.equal(afterReady.data.seats[leaver.seat].connected, false);
});

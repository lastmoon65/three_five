// test/net-server.test.mjs — M1 联网骨架契约测试
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startNetServer } from '../net-server.mjs';

let app, port;
const sockets = [];
before(async () => { app = await startNetServer({ port: 0 }); port = app.port; });
after(async () => {
  for (const s of sockets) { try { s.close(); } catch { /* 忽略 */ } }
  await new Promise((r) => setTimeout(r, 120));
  await app.close();
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

test('错误密码返回 AUTH_FAIL', async () => {
  const { ws, inbox } = await connect();
  send(ws, { type: 'auth', data: { username: 'player1', password: 'wrong' } });
  const m = await waitMsg(inbox, 'error');
  assert.equal(m.data.code, 'AUTH_FAIL');
  ws.close();
});

test('正确登录返回 auth_ok 与 token', async () => {
  const { ws, inbox } = await connect();
  send(ws, { type: 'auth', data: { username: 'player1', password: '123456' } });
  const m = await waitMsg(inbox, 'auth_ok');
  assert.ok(typeof m.data.token === 'string' && m.data.token.length > 10);
  assert.equal(m.data.user.username, 'player1');
  ws.close();
});

test('token 重连免登录', async () => {
  const c1 = await connect();
  send(c1.ws, { type: 'auth', data: { username: 'player2', password: '123456' } });
  const ok1 = await waitMsg(c1.inbox, 'auth_ok');
  c1.ws.close();
  const c2 = await connect();
  send(c2.ws, { type: 'auth', data: { token: ok1.data.token } });
  const ok2 = await waitMsg(c2.inbox, 'auth_ok');
  assert.equal(ok2.data.user.username, 'player2');
  c2.ws.close();
});

test('重复登录顶掉旧连接（单会话）', async () => {
  const c1 = await connect();
  send(c1.ws, { type: 'auth', data: { username: 'player3', password: '123456' } });
  await waitMsg(c1.inbox, 'auth_ok');
  const c2 = await connect();
  send(c2.ws, { type: 'auth', data: { username: 'player3', password: '123456' } });
  await waitMsg(c2.inbox, 'auth_ok');
  const kicked = await waitMsg(c1.inbox, 'kicked');
  assert.equal(kicked.data.reason, 'NEW_SESSION');
  c1.ws.close(); c2.ws.close();
});

function waitPresence(inbox, predicate, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const m = [...inbox].reverse().find((x) => x.type === 'presence');
      if (m && predicate(m.data.online)) return resolve(m);
      if (Date.now() - t0 > timeout) return reject(new Error('timeout presence inbox=' + JSON.stringify(inbox)));
      setTimeout(tick, 20);
    })();
  });
}
test('在线列表广播 presence', async () => {
  const c1 = await connect();
  send(c1.ws, { type: 'auth', data: { username: 'player1', password: '123456' } });
  await waitMsg(c1.inbox, 'auth_ok');
  const c2 = await connect();
  send(c2.ws, { type: 'auth', data: { username: 'player2', password: '123456' } });
  await waitMsg(c2.inbox, 'auth_ok');
  const p1 = await waitPresence(c1.inbox, (o) => o.includes('player1') && o.includes('player2'));
  const p2 = await waitPresence(c2.inbox, (o) => o.includes('player1') && o.includes('player2'));
  assert.ok(true);
  c1.ws.close(); c2.ws.close();
});

test('未知 token 拒绝', async () => {
  const { ws, inbox } = await connect();
  send(ws, { type: 'auth', data: { token: 'not-a-real-token' } });
  const m = await waitMsg(inbox, 'error');
  assert.equal(m.data.code, 'AUTH_FAIL');
  ws.close();
});

test('未知消息类型返回 UNKNOWN_TYPE', async () => {
  const { ws, inbox } = await connect();
  send(ws, { type: 'auth', data: { username: 'player4', password: '123456' } });
  await waitMsg(inbox, 'auth_ok');
  send(ws, { type: 'bogus_type' });
  const m = await waitMsg(inbox, 'error');
  assert.equal(m.data.code, 'UNKNOWN_TYPE');
  ws.close();
});
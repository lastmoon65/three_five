// test/input-validation.test.mjs — 输入层空值/张数校验 + 亮牌 power 加成同步
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../game/game.mjs';
import { Game6 } from '../game/game6.mjs';
import { startNetServer } from '../net-server.mjs';

test('引擎：亮牌张数错误/非数组/空值都报 REVEAL_NEED_3，不抛 TypeError', () => {
  const g = new Game(['a', 'b', 'c', 'd']);
  g.startRound();
  assert.throws(() => g.reveal(0, ['a', 'b']), /REVEAL_NEED_3/);
  assert.throws(() => g.reveal(0, 'abc'), /REVEAL_NEED_3/);
  assert.doesNotThrow(() => g.reveal(0, null), 'null=跳过合法');
});

test('引擎：埋底补亮/埋底/出牌的空值输入报业务错误而非 TypeError', () => {
  const g = new Game(['a', 'b', 'c', 'd']);
  g.startRound();
  for (let i = 0; i < 4; i++) g.reveal(i, null);
  if (g.state().phase === 'bury') {
    assert.throws(() => g.buryReveal(null), /REVEAL_NEED_3/);
    assert.throws(() => g.bury(null), /BURY_NEED_6/);
  }
  // 非打牌阶段可能是 BAD_PHASE，打牌阶段是 BAD_PLAY，总之不能是 TypeError
  assert.throws(() => g.play(null), /BAD_PLAY|BAD_PHASE/);
  assert.throws(() => g.play([]), /BAD_PLAY|BAD_PHASE/);
});

test('引擎：亮牌后 powerOf 返回加成牌力（三反996/五反998/方块5保持1000）', () => {
  const g = new Game(['a', 'b', 'c', 'd']);
  g.startRound();
  const deck = [...g.cardMap.values()];
  const threes = deck.filter((c) => c.rank === '3');
  const fives = deck.filter((c) => c.rank === '5');
  g.hands[0] = threes.slice(0, 3).concat(deck.filter((c) => c.rank !== '3').slice(0, 9));
  g.hands[1] = [fives[0], fives[1], fives[2]].concat(deck.filter((c) => c.rank !== '5').slice(0, 9));
  // 座位0 亮三反
  g.reveal(0, threes.slice(0, 3).map((c) => c.id));
  assert.equal(g.powerOf(g.cardById(threes[0].id)), 996, '三反 996');
  // 座位1 亮五反（含方块5 则保持 1000）
  const wu = fives.slice(0, 3);
  g.reveal(1, wu.map((c) => c.id));
  wu.forEach((c) => {
    const expect = c.suit === 'diamond' && c.rank === '5' ? 1000 : 998;
    assert.equal(g.powerOf(g.cardById(c.id)), expect, c.id);
  });
});

// ---- 服务端：张数不对的 reveal 返回 BAD_REVEAL 而非静默跳过 ----
let app, port;
const sockets = [];
before(async () => { app = await startNetServer({ port: 0 }); port = app.port; });
after(async () => {
  for (const s of sockets) { try { s.close(); } catch {} }
  await new Promise((r) => setTimeout(r, 150));
  await app.close();
});
function conn() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const inbox = [];
    ws.addEventListener('message', (e) => { try { inbox.push(JSON.parse(String(e.data))); } catch {} });
    ws.addEventListener('open', () => { sockets.push(ws); res({ ws, inbox }); });
    ws.addEventListener('error', rej);
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
      setTimeout(tick, 20);
    })();
  });
}
function waitError(inbox, ms = 8000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function tick() {
      const m = [...inbox].reverse().find((x) => x.type === 'error');
      if (m) return res(m);
      if (Date.now() - t0 > ms) return rej(new Error('timeout error'));
      setTimeout(tick, 20);
    })();
  });
}
async function login(name) {
  const c = await conn();
  send(c.ws, { type: 'auth', data: { username: name, password: '123456' } });
  await waitMsg(c.inbox, 'auth_ok');
  send(c.ws, { type: 'leave_room' });
  await new Promise((r) => setTimeout(r, 200));
  c.inbox.length = 0;
  return c;
}

test('服务端：reveal 传 2 张牌返回 BAD_REVEAL（不静默当作跳过）', async () => {
  const users = [];
  for (const n of ['player1', 'player2', 'player3', 'player4']) users.push(await login(n));
  send(users[0].ws, { type: 'create_room' });
  const created = await waitMsg(users[0].inbox, 'room_updated');
  for (let i = 1; i < 4; i++) {
    send(users[i].ws, { type: 'join_room', data: { roomId: created.data.roomId } });
    await waitMsg(users[i].inbox, 'room_updated');
  }
  for (const u of users) send(u.ws, { type: 'ready' });
  await new Promise((r) => setTimeout(r, 400));
  send(users[0].ws, { type: 'start_game' });
  await waitMsg(users[0].inbox, 'game_state');
  send(users[0].ws, { type: 'reveal', data: { cardIds: ['a', 'b'] } });
  const e = await waitError(users[0].inbox);
  assert.equal(e.data.code, 'BAD_REVEAL');
  assert.match(e.data.message, /REVEAL_NEED_3/);
});

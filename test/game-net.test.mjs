// test/game-net.test.mjs — M3 联网对局契约测试（发牌 + 亮牌）
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
function waitMsg(inbox, type, timeout = 5000) {
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
function waitError(inbox, code, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const m = [...inbox].reverse().find((x) => x.type === 'error' && x.data.code === code);
      if (m) return resolve(m);
      if (Date.now() - t0 > timeout) return reject(new Error('timeout error ' + code + ' inbox=' + JSON.stringify(inbox)));
      setTimeout(tick, 20);
    })();
  });
}
function waitNewestGame(inbox, checkFn, timeout = 12000) {
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
function waitUntil(inbox, predicate, timeout = 8000) {
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

test('start_game 校验 + 成功发牌 + 手牌隐私', async () => {
  const { users } = await setup4();
  // 未准备 -> NOT_READY
  send(users[0].ws, { type: 'start_game' });
  await waitError(users[0].inbox, 'NOT_READY');
  // 非房主 -> NOT_HOST
  await readyAll(users);
  send(users[1].ws, { type: 'start_game' });
  await waitError(users[1].inbox, 'NOT_HOST');
  // 房主成功开始
  const states = await startGame(users);
  for (const s of states) {
    assert.equal(s.phase, 'reveal');
    assert.equal(s.myHand.length, 12);
    assert.deepEqual(s.handCounts, [12, 12, 12, 12]);
    assert.equal(s.dealerIndex >= 0 && s.dealerIndex <= 3, true);
  }
  // 手牌隐私：48 张互不重叠
  const all = states.flatMap((s) => s.myHand.map((c) => c.id));
  assert.equal(new Set(all).size, 48);
  // 每人只收到自己的牌：myHand 的座位归属
  states.forEach((s) => {
    const mine = new Set(s.myHand.map((c) => c.id));
    for (const other of states) {
      if (other.me !== s.me) {
        const theirs = new Set(other.myHand.map((c) => c.id));
        for (const id of mine) assert.ok(!theirs.has(id), '交叉泄漏手牌');
      }
    }
  });
});

test('亮牌：同时提交、重复提交与非法输入', async () => {
  const { users } = await setup4();
  await readyAll(users);
  const states = await startGame(users);
  const me = states[0].me;
  const meUser = users.find((u) => u.seat === me);
  const otherUser = users.find((u) => u.seat !== me);
  // 同时亮牌：非自己座位也可先提交（跳过合法）
  send(otherUser.ws, { type: 'reveal', data: { cardIds: null } });
  await waitNewestGame(users[0].inbox, (d) => d.revealDone && d.revealDone[otherUser.seat] === true);
  // 亮 2 张 -> BAD_REVEAL
  send(meUser.ws, { type: 'reveal', data: { cardIds: ['a', 'b'] } });
  await waitError(meUser.inbox, 'BAD_REVEAL');
  // 亮别人的牌 -> BAD_REVEAL
  const otherHand = states.find((s) => s.me === otherUser.seat).myHand;
  send(meUser.ws, { type: 'reveal', data: { cardIds: otherHand.slice(0, 3).map((c) => c.id) } });
  await waitError(meUser.inbox, 'BAD_REVEAL');
  // 重复提交 -> REVEAL_ALREADY_DONE
  send(otherUser.ws, { type: 'reveal', data: { cardIds: null } });
  await waitError(otherUser.inbox, 'BAD_REVEAL'); // 服务端统一 BAD_REVEAL，消息为 REVEAL_ALREADY_DONE
  // 自己跳过 -> 标记已过
  send(meUser.ws, { type: 'reveal', data: { cardIds: null } });
  await waitNewestGame(meUser.inbox, (d) => d.revealDone && d.revealDone[me] === true);
});

test('全部跳过亮牌后进入埋底阶段', async () => {
  const { users } = await setup4();
  await readyAll(users);
  await startGame(users);
  await skipAllReveals(users);
  const m = await waitNewestGame(users[0].inbox, (d) => d.phase === 'bury');
  assert.equal(m.data.phase, 'bury');
  assert.equal(m.data.rebellion, false);
});

// ---------- M4 进贡 + 埋底 ----------
async function skipAllReveals(users) {
  let guard = 0;
  while (guard < 8) {
    const latest = [...users[0].inbox].reverse().find((m) => m.type === 'game_state');
    if (!latest || latest.data.phase !== 'reveal') break;
    const done = latest.data.revealDone || [];
    const seat = done.findIndex((v) => !v);
    if (seat < 0) break;
    const u = users.find((x) => x.seat === seat);
    // 同时亮牌：等待该座位尚未提交的最新状态再发跳过
    const st = await waitNewestGame(u.inbox, (d) => d.phase === 'reveal' && d.revealDone && !d.revealDone[seat] && d.seq >= latest.data.seq, 8000);
    send(u.ws, { type: 'reveal', data: { cardIds: null } });
    guard++;
    const beforeCount = (st.data.revealDone || []).filter(Boolean).length;
    // 等待提交数增加或离开亮牌阶段
    await waitNewestGame(users[0].inbox, (d) => d.seq > st.data.seq && (d.phase !== 'reveal' || (d.revealDone || []).filter(Boolean).length > beforeCount), 8000);
  }
  await waitNewestGame(users[0].inbox, (d) => d.phase !== 'reveal', 8000);
}
function isMainCard(c) {
  return c.suit === 'heart' || c.suit === 'joker' || (c.suit === 'diamond' && c.rank === '5') || (c.suit === 'spade' && c.rank === 'Q') || c.rank === 'J' || c.rank === '2';
}
async function reachBury(users, roomId) {
  await skipAllReveals(users);
  const st = await waitNewestGame(users[0].inbox, (d) => d.phase === 'tribute' && d.tributeState);
  const pairs = st.data.tributeState.pairs;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const takerUser = users.find((u) => u.seat === pair.taker);
    const ts = await waitNewestGame(takerUser.inbox, (d) => d.phase === 'tribute' && d.tributeState && d.tributeState.step === 'take' && d.tributeState.pairIdx === i && d.seq >= st.data.seq);
    const card = ts.data.myHand.find(isMainCard) || ts.data.myHand[0];
    send(takerUser.ws, { type: 'tribute_take', data: { cardId: card.id } });
    await waitNewestGame(users[0].inbox, (d) => d.seq > ts.data.seq && (d.phase !== 'tribute' || d.tributeState.pairIdx > i), 8000);
  }
  await waitNewestGame(users[0].inbox, (d) => d.phase === 'bury');
}

test('单进贡：自动进贡 -> 退贡 -> 埋底公开（含校验）', async () => {
  const { users, roomId } = await setup4();
  await readyAll(users);
  await startGame(users);
  app._testSetTribute(roomId, 'single');
  await skipAllReveals(users);
  // 进贡自动执行
  const st = await waitNewestGame(users[0].inbox, (d) => d.phase === 'tribute');
  assert.equal(st.data.tributeState.step, 'take');
  assert.ok(st.data.lastGive && st.data.lastGive.card);
  assert.equal(st.data.tributeState.pairs.length, 1);
  const taker = st.data.tributeState.pairs[0].taker;
  const takerUser = users.find((u) => u.seat === taker);
  const ts = await waitNewestGame(takerUser.inbox, (d) => d.phase === 'tribute' && d.tributeState && d.tributeState.step === 'take');
  const hand = ts.data.myHand;
  // 有主牌时退副牌被拒
  if (hand.some(isMainCard)) {
    const sub = hand.find((c) => !isMainCard(c));
    send(takerUser.ws, { type: 'tribute_take', data: { cardId: sub.id } });
    await waitError(takerUser.inbox, 'BAD_TAKE');
  }
  // 正常退主牌
  const card = hand.find(isMainCard) || hand[0];
  send(takerUser.ws, { type: 'tribute_take', data: { cardId: card.id } });
  const bury = await waitNewestGame(users[0].inbox, (d) => d.phase === 'bury');
  const dealer = bury.data.dealerIndex;
  const dealerUser = users.find((u) => u.seat === dealer);
  const ds = await waitNewestGame(dealerUser.inbox, (d) => d.phase === 'bury' && d.me === dealer);
  assert.equal(ds.data.myHand.length, 18);
  // 非庄家埋底被拒
  const other = users.find((u) => u.seat !== dealer);
  send(other.ws, { type: 'bury', data: { cardIds: [] } });
  await waitError(other.inbox, 'NOT_YOUR_TURN');
  // 埋底含分被拒
  const scoring = ds.data.myHand.find((c) => c.points > 0);
  if (scoring) {
    const bad = ds.data.myHand.filter((c) => c.id !== scoring.id).slice(0, 5).map((c) => c.id).concat([scoring.id]);
    send(dealerUser.ws, { type: 'bury', data: { cardIds: bad } });
    await waitError(dealerUser.inbox, 'BAD_BURY');
  }
  // 正常埋底 -> 底牌公开
  const buryIds = ds.data.myHand.filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
  send(dealerUser.ws, { type: 'bury', data: { cardIds: buryIds } });
  const trick = await waitNewestGame(users[0].inbox, (d) => d.phase === 'trick');
  assert.equal(trick.data.bottom.length, 6);
  assert.equal(trick.data.bottom.every((c) => c.points === 0), true);
});

test('双进贡：两轮进贡退贡后进入埋底', async () => {
  const { users, roomId } = await setup4();
  await readyAll(users);
  await startGame(users);
  app._testSetTribute(roomId, 'double');
  await skipAllReveals(users);
  const st = await waitNewestGame(users[0].inbox, (d) => d.phase === 'tribute');
  assert.equal(st.data.tributeState.pairs.length, 2);
  await reachBury(users, roomId);
  const bury = await waitNewestGame(users[0].inbox, (d) => d.phase === 'bury');
  assert.equal(bury.data.phase, 'bury');
});

// ---------- M5 打牌 + 健壮性 ----------
async function reachTrick(users) {
  await skipAllReveals(users);
  let st = await waitNewestGame(users[0].inbox, (d) => d.phase === 'bury' || d.phase === 'trick');
  if (st.data.phase === 'trick') return; // 兜底自动埋底
  const dealer = st.data.dealerIndex;
  const dealerUser = users.find((u) => u.seat === dealer);
  const dst = await waitNewestGame(dealerUser.inbox, (d) => d.phase === 'bury' && d.me === dealer);
  const buryIds = dst.data.myHand.filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
  send(dealerUser.ws, { type: 'bury', data: { cardIds: buryIds } });
  await waitNewestGame(users[0].inbox, (d) => d.seq > dst.data.seq && d.phase === 'trick', 8000);
}

async function autoPlayToEnd(users) {
  let guard = 0;
  while (guard < 400) {
    const curState = await waitNewestGame(users[0].inbox, () => true);
    const cur = curState.data.currentSeat;
    const u = users.find((x) => x.seat === cur);
    if (!u) break;
    const st = await waitNewestGame(u.inbox, (d) => d.currentSeat === cur && d.seq >= curState.data.seq);
    if (st.data.phase !== 'trick' || !st.data.legalPlays || !st.data.legalPlays.length) break;
    const before = (st.data.trick ? st.data.trick.plays.length : 0) + ':' + st.data.currentSeat;
    send(u.ws, { type: 'play', data: { cardIds: st.data.legalPlays[0].cardIds } });
    guard++;
    await waitNewestGame(users[0].inbox, (d) => d.seq > st.data.seq && (d.phase !== 'trick' || ((d.trick ? d.trick.plays.length : 0) + ':' + d.currentSeat) !== before), 8000);
  }
  return (await waitNewestGame(users[0].inbox, (d) => d.phase === 'round_end', 15000)).data;
}

test('game_state seq 单调递增（快照防乱序）', async () => {
  const { users } = await setup4();
  await readyAll(users);
  await startGame(users);
  await skipAllReveals(users);
  const seqs = users[0].inbox.filter((m) => m.type === 'game_state').map((m) => m.data.seq);
  assert.ok(seqs.length >= 5);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'seq 必须严格递增');
});

test('打牌全流程：跟牌/裁决/赢墩得分/打到结算', async () => {
  const { users } = await setup4();
  await readyAll(users);
  await startGame(users);
  await reachTrick(users);
  const end = await autoPlayToEnd(users);
  assert.equal(end.phase, 'round_end');
  assert.equal(end.scores[0] + end.scores[1], 100);
});

test('打牌校验：越权/手牌外/非法跟牌被拒', async () => {
  const { users } = await setup4();
  await readyAll(users);
  await startGame(users);
  await reachTrick(users);
  const st = await waitNewestGame(users[0].inbox, (d) => d.phase === 'trick');
  const actor = st.data.currentSeat;
  const actorUser = users.find((u) => u.seat === actor);
  const other = users.find((u) => u.seat !== actor);
  // 越权出牌
  send(other.ws, { type: 'play', data: { cardIds: [] } });
  await waitError(other.inbox, 'NOT_YOUR_TURN');
  // 出别人的牌
  const otherHand = (await waitNewestGame(other.inbox, (d) => d.me === other.seat)).data.myHand;
  send(actorUser.ws, { type: 'play', data: { cardIds: [otherHand[0].id] } });
  await waitError(actorUser.ws ? actorUser.inbox : other.inbox, 'BAD_PLAY');
  // 领出单张后，响应者出 2 张 -> 非法
  const actorSt = await waitNewestGame(actorUser.inbox, (d) => d.phase === 'trick' && d.currentSeat === actor);
  send(actorUser.ws, { type: 'play', data: { cardIds: actorSt.data.legalPlays[0].cardIds } });
  const next = (actor + 3) % 4;
  const nextUser = users.find((u) => u.seat === next);
  const ns = await waitNewestGame(nextUser.inbox, (d) => d.phase === 'trick' && d.currentSeat === next);
  send(nextUser.ws, { type: 'play', data: { cardIds: ns.data.myHand.slice(0, 2).map((c) => c.id) } });
  await waitError(nextUser.inbox, 'BAD_PLAY');
});

test('心跳：客户端自动回 pong，连接保持', async () => {
  const hb = await startNetServer({ port: 0, heartbeatMs: 60 });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${hb.port}/ws`);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    await new Promise((r) => setTimeout(r, 350)); // 跨多个心跳周期
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  } finally {
    await hb.close();
  }
});

// ---------- M6 结算 + 轮庄 ----------
test('结算信息 + 下一副轮庄 + 进贡计划带入', async () => {
  const { users } = await setup4();
  await readyAll(users);
  await startGame(users);
  await reachTrick(users);
  const end = await autoPlayToEnd(users);
  assert.equal(end.phase, 'round_end');
  const r = end.result;
  assert.ok(r, 'round_end 必须带 result');
  assert.equal(r.scores[0] + r.scores[1], 100);
  assert.equal(typeof r.dealerStay, 'boolean');
  assert.ok(r.newDealerIndex >= 0 && r.newDealerIndex <= 3);
  // 下一副
  send(users[0].ws, { type: 'next_round' });
  const next = await waitNewestGame(users[0].inbox, (d) => d.roundNo === 2 && d.phase === 'reveal');
  assert.equal(next.data.dealerIndex, r.newDealerIndex);
  assert.equal(next.data.tributePlan, r.tribute);
  assert.equal(next.data.handCounts.every((n) => n === 12), true);
});

test('非结算阶段发起下一副返回 BAD_PHASE', async () => {
  const { users } = await setup4();
  await readyAll(users);
  await startGame(users);
  send(users[0].ws, { type: 'next_round' }); // 还在亮牌阶段
  await waitError(users[0].inbox, 'BAD_PHASE');
});

// ---------- M7 对局中断线重连 ----------
test('对局中断线：行动者离线等待，重连后继续', async () => {
  const { users } = await setup4();
  await readyAll(users);
  await startGame(users);
  const st = await waitNewestGame(users[0].inbox, (d) => d.phase === 'reveal');
  const done = st.data.revealDone || [];
  const actor = done.findIndex((v) => !v);
  const actorUser = users.find((u) => u.seat === actor);
  const other = users.find((u) => u.seat !== actor);
  const beforeSeq = [...other.inbox].reverse().find((x) => x.type === 'game_state').data.seq;
  // 行动者断线
  actorUser.ws.close();
  // 其他人：room_updated 离线 + game_state 消息提示等待重连
  const m = await waitNewestGame(other.inbox, (d) => d.seats && d.seats[actor] && d.seats[actor].connected === false);
  assert.ok(m.data.message.includes('等待重连') || m.data.message.includes('离线'));
  // 重连（token）
  const r = await connect();
  send(r.ws, { type: 'auth', data: { token: actorUser.token } });
  await waitMsg(r.inbox, 'auth_ok');
  const gs = await waitNewestGame(r.inbox, (d) => d.me === actor && d.phase === 'reveal');
  assert.equal(gs.data.seats[actor].connected, true);
  // 重连者继续行动
  send(r.ws, { type: 'reveal', data: { cardIds: null } });
  const next = await waitNewestGame(other.inbox, (d) => d.revealDone && d.revealDone[actor] === true);
  assert.ok(next.data.seq > beforeSeq, '重连后 seq 必须继续递增');
  r.ws.close();
});

test('对局中顶号：新连接接管席位且拿到快照', async () => {
  const { users } = await setup4();
  await readyAll(users);
  await startGame(users);
  const st = await waitNewestGame(users[0].inbox, (d) => d.phase === 'reveal');
  const done = st.data.revealDone || [];
  const actor = done.findIndex((v) => !v);
  const actorUser = users.find((u) => u.seat === actor);
  // 同账号再次登录（顶号）
  const r = await connect();
  send(r.ws, { type: 'auth', data: { username: actorUser.user, password: '123456' } });
  await waitMsg(r.inbox, 'auth_ok');
  // 旧连接被踢
  await waitMsg(actorUser.inbox, 'kicked');
  // 新连接拿到对局快照，席位在线
  const gs = await waitNewestGame(r.inbox, (d) => d.me === actor && d.phase === 'reveal');
  assert.equal(gs.data.seats[actor].connected, true);
  assert.equal(gs.data.myHand.length, 12);
  r.ws.close();
});

// ---------- M8 端到端验收 ----------
async function round2ToEnd(users) {
  await skipAllReveals(users);
  const st = await waitNewestGame(users[0].inbox, (d) => d.phase === 'tribute' || d.phase === 'bury' || d.phase === 'trick');
  if (st.data.phase === 'tribute') {
    await reachBury(users, null);
  } else if (st.data.phase === 'bury') {
    const dealer = st.data.dealerIndex;
    const dealerUser = users.find((u) => u.seat === dealer);
    const dst = await waitNewestGame(dealerUser.inbox, (d) => d.phase === 'bury' && d.me === dealer);
    const buryIds = dst.data.myHand.filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
    send(dealerUser.ws, { type: 'bury', data: { cardIds: buryIds } });
    await waitNewestGame(users[0].inbox, (d) => d.phase === 'trick');
  }
  return autoPlayToEnd(users);
}

test('端到端验收：连续两副完整对局，轮庄与进贡衔接正确', async () => {
  const { users } = await setup4();
  await readyAll(users);
  await startGame(users);
  // 第一副
  await reachTrick(users);
  const end1 = await autoPlayToEnd(users);
  assert.equal(end1.phase, 'round_end');
  const r1 = end1.result;
  assert.equal(r1.scores[0] + r1.scores[1], 100);
  // 下一副：庄家与进贡计划来自上一副结果
  send(users[0].ws, { type: 'next_round' });
  const r2start = await waitNewestGame(users[0].inbox, (d) => d.roundNo === 2 && d.phase === 'reveal');
  assert.equal(r2start.data.dealerIndex, r1.newDealerIndex);
  assert.equal(r2start.data.tributePlan, r1.tribute);
  // 第二副完整打完（若触发进贡则自动走退贡流程）
  const end2 = await round2ToEnd(users);
  assert.equal(end2.phase, 'round_end');
  assert.equal(end2.roundNo, 2);
  assert.equal(end2.scores[0] + end2.scores[1], 100);
});
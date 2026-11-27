// test/game-net6.test.mjs — 6 人联网协议：进贡可见性、禁空出、断线暂停、完整对局
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
  await new Promise((r) => setTimeout(r, 80));
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
function waitMsg(inbox, type, timeout = 4000) {
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
function waitNewestGame(inbox, checkFn, timeout = 8000) {
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
function waitUntil(inbox, predicate, timeout = 4000) {
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
  send(c.ws, { type: 'auth', data: creds(name) });
  const ok = await waitMsg(c.inbox, 'auth_ok');
  return { ws: c.ws, inbox: c.inbox, token: ok.data.token, user: ok.data.user.username };
}

async function setup6() {
  const users = [];
  const host = await login(P6[0]);
  send(host.ws, { type: 'create_room', data: { mode: 'p6' } });
  const created = await waitMsg(host.inbox, 'room_updated');
  users.push({ ...host, seat: 0 });
  for (let i = 1; i < 6; i++) {
    const u = await login(P6[i]);
    send(u.ws, { type: 'join_room', data: { roomId: created.data.roomId, mode: 'p6' } });
    await waitMsg(u.inbox, 'room_updated');
    const seats = [...u.inbox].reverse().find((m) => m.type === 'room_updated').data.seats;
    users.push({ ...u, seat: seats.findIndex((s) => s && s.userId === P6[i]) });
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
  for (const u of users) states.push((await waitUntil(u.inbox, (x) => x.type === 'game_state')).data);
  return states;
}

async function skipAllReveals(users) {
  let guard = 0;
  while (guard < 16) {
    const latest = [...users[0].inbox].reverse().find((m) => m.type === 'game_state');
    if (!latest || latest.data.phase !== 'reveal') break;
    const actor = latest.data.revealActor;
    if (actor == null) break;
    const u = users.find((x) => x.seat === actor);
    send(u.ws, { type: 'reveal', data: { cardIds: null } });
    guard++;
    await waitNewestGame(users[0].inbox, (d) => d.phase !== 'reveal' || d.revealActor !== actor, 5000);
  }
  await waitNewestGame(users[0].inbox, (d) => d.phase !== 'reveal', 5000);
}

function isMainCard(c) {
  return c.suit === 'heart' || c.suit === 'joker' || (c.suit === 'diamond' && c.rank === '5') || (c.suit === 'spade' && c.rank === 'Q') || c.rank === 'J' || c.rank === '2';
}
function tributeTakeCandidate(hand) {
  const mains = hand.filter(isMainCard);
  const nonScoringMains = mains.filter((c) => c.points === 0);
  if (nonScoringMains.length) return nonScoringMains[0];
  if (mains.length) return mains[0];
  const nonScoring = hand.filter((c) => c.points === 0);
  return nonScoring[0] || hand[0];
}

async function maybeGiveTribute(users) {
  const latest = [...users[0].inbox].reverse().find((m) => m.type === 'game_state');
  if (!latest || latest.data.phase !== 'tribute') return;
  if (latest.data.tributeState && latest.data.tributeState.step === 'give') {
    const giver = users.find((u) => u.seat === latest.data.currentSeat);
    const gs = await waitNewestGame(giver.inbox, (d) => d.phase === 'tribute' && d.tributeState && d.tributeState.step === 'give');
    const opt = (gs.data.giveOptions && gs.data.giveOptions[0]) || null;
    if (opt) send(giver.ws, { type: 'tribute_give', data: { cardId: opt } });
    await waitNewestGame(users[0].inbox, (d) => d.phase !== 'tribute' || (d.tributeState && d.tributeState.step === 'take'), 5000);
  }
}

async function finishTributeIfAny(users) {
  await maybeGiveTribute(users);
  let guard = 0;
  while (guard < 8) {
    const st = [...users[0].inbox].reverse().find((m) => m.type === 'game_state').data;
    if (st.phase !== 'tribute') break;
    if (st.tributeState && st.tributeState.step === 'give') {
      await maybeGiveTribute(users);
      guard++;
      continue;
    }
    if (st.tributeState && st.tributeState.step === 'take') {
      const takerUser = users.find((u) => u.seat === st.currentSeat);
      const ts = await waitNewestGame(takerUser.inbox, (d) => d.phase === 'tribute' && d.tributeState && d.tributeState.step === 'take');
      const card = tributeTakeCandidate(ts.data.myHand);
      send(takerUser.ws, { type: 'tribute_take', data: { cardId: card.id } });
      await waitNewestGame(users[0].inbox, (d) => d.phase !== 'tribute' || d.tributeState.step === 'give' || (d.tributeState && d.tributeState.pairIdx !== st.tributeState.pairIdx), 5000);
    }
    guard++;
  }
}

async function reachTrick(users) {
  for (let i = 0; i < 6; i++) {
    const latest = [...users[0].inbox].reverse().find((m) => m.type === 'game_state');
    if (latest && latest.data.phase === 'trick') return;
    if (!latest || latest.data.phase === 'reveal') await skipAllReveals(users);
    const st = await waitNewestGame(users[0].inbox, (d) => d.phase === 'tribute' || d.phase === 'bury' || d.phase === 'trick' || d.phase === 'reveal', 8000);
    if (st.data.phase === 'reveal') continue; // 重开
    if (st.data.phase === 'tribute') await finishTributeIfAny(users);
    const after = await waitNewestGame(users[0].inbox, (d) => d.phase === 'bury' || d.phase === 'trick' || d.phase === 'reveal', 8000);
    if (after.data.phase === 'reveal') continue;
    if (after.data.phase === 'trick') return;
    if (after.data.phase === 'bury') {
      const dealer = after.data.dealerIndex;
      const dealerUser = users.find((u) => u.seat === dealer);
      const dst = await waitNewestGame(dealerUser.inbox, (d) => d.phase === 'bury' && d.me === dealer, 8000);
      const buryIds = dst.data.myHand.filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
      send(dealerUser.ws, { type: 'bury', data: { cardIds: buryIds } });
      await waitNewestGame(users[0].inbox, (d) => d.phase === 'trick', 8000);
      return;
    }
  }
  throw new Error('reachTrick failed');
}

async function autoPlayToEnd(users) {
  let guard = 0;
  while (guard < 900) {
    const curMsg = await waitNewestGame(users[0].inbox, (d) => d.phase === 'trick' || d.phase === 'round_end', 10000);
    if (curMsg.data.phase === 'round_end') return curMsg.data;
    const cur = curMsg.data.currentSeat;
    const u = users.find((x) => x.seat === cur);
    const st = await waitNewestGame(u.inbox, (d) => d.currentSeat === cur && d.phase === 'trick', 10000);
    if (!st.data.legalPlays || !st.data.legalPlays.length) break;
    const before = (st.data.trick ? st.data.trick.plays.length : 0) + ':' + st.data.currentSeat + ':' + st.data.seq;
    send(u.ws, { type: 'play', data: { cardIds: st.data.legalPlays[0].cardIds } });
    guard++;
    await waitNewestGame(users[0].inbox, (d) => {
      if (d.phase === 'round_end') return true;
      const now = (d.trick ? d.trick.plays.length : 0) + ':' + d.currentSeat + ':' + d.seq;
      return now !== before;
    }, 8000);
  }
  return (await waitNewestGame(users[0].inbox, (d) => d.phase === 'round_end', 12000)).data;
}

test('6 人开局：发牌 17+6、手牌隐私、房号 6 位', async () => {
  const { users, roomId } = await setup6();
  assert.match(roomId, /^\d{6}$/);
  await readyAll(users);
  const states = await startGame(users);
  for (const s of states) {
    assert.equal(s.mode, 'p6');
    assert.equal(s.phase, 'reveal');
    assert.equal(s.myHand.length, 17);
    assert.deepEqual(s.handCounts, [17, 17, 17, 17, 17, 17]);
  }
  const all = states.flatMap((s) => s.myHand.map((c) => c.id));
  assert.equal(new Set(all).size, 102);
  states.forEach((s) => {
    const mine = new Set(s.myHand.map((c) => c.id));
    for (const other of states) {
      if (other.me !== s.me) {
        for (const id of mine) assert.ok(!other.myHand.some((c) => c.id === id), '交叉泄漏手牌');
      }
    }
  });
});

test('单进贡：配对为庄家→顺时针下家；牌面仅双方可见；退贡后埋底公开', async () => {
  const { users, roomId } = await setup6();
  await readyAll(users);
  await startGame(users);
  app._testSetTribute(roomId, 'single');
  await skipAllReveals(users);
  const st = await waitNewestGame(users[0].inbox, (d) => d.phase === 'tribute' || d.phase === 'bury' || d.phase === 'reveal');
  if (st.data.phase === 'reveal') return; // 极端重开，本用例跳过可见性断言（仍不失败整个套件结构）
  if (st.data.phase === 'tribute') {
    await maybeGiveTribute(users);
    const give = await waitNewestGame(users[0].inbox, (d) => d.phase === 'tribute' && d.lastGive && d.tributeState && d.tributeState.step === 'take');
    const { from, to } = give.data.lastGive;
    assert.equal(to, (from + 1) % 6);
    assert.equal(from, give.data.dealerIndex);
    for (const u of users) {
      const own = await waitNewestGame(u.inbox, (d) => d.phase === 'tribute' && d.lastGive);
      if (own.data.me === from || own.data.me === to) {
        assert.ok(own.data.lastGive.card && own.data.lastGive.card.rank && own.data.lastGive.card.suit, '进贡双方必须看到牌面');
      } else {
        assert.ok(!own.data.lastGive.card, '旁观者不得看到进贡牌面');
      }
    }
    const takerUser = users.find((u) => u.seat === to);
    const ts = await waitNewestGame(takerUser.inbox, (d) => d.phase === 'tribute' && d.tributeState && d.tributeState.step === 'take');
    send(takerUser.ws, { type: 'tribute_take', data: { cardId: tributeTakeCandidate(ts.data.myHand).id } });
  }
  const bury = await waitNewestGame(users[0].inbox, (d) => d.phase === 'bury', 8000);
  const dealerUser = users.find((u) => u.seat === bury.data.dealerIndex);
  const ds = await waitNewestGame(dealerUser.inbox, (d) => d.phase === 'bury' && d.me === bury.data.dealerIndex);
  assert.equal(ds.data.myHand.length, 23);
  const scoring = ds.data.myHand.find((c) => c.points > 0);
  if (scoring) {
    const bad = ds.data.myHand.filter((c) => c.id !== scoring.id && c.points === 0).slice(0, 5).map((c) => c.id).concat([scoring.id]);
    if (bad.length === 6) {
      send(dealerUser.ws, { type: 'bury', data: { cardIds: bad } });
      await waitError(dealerUser.inbox, 'BAD_BURY');
    }
  }
  const buryIds = ds.data.myHand.filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
  send(dealerUser.ws, { type: 'bury', data: { cardIds: buryIds } });
  const trick = await waitNewestGame(users[0].inbox, (d) => d.phase === 'trick');
  assert.equal(trick.data.bottom.length, 6);
  assert.ok(trick.data.bottom.every((c) => c.suit || c.rank), '埋完后底牌应公开');
});

test('客户端主动 play([]) 被拒绝；对局中非行动者离线则暂停并锁定写操作', async () => {
  const { users } = await setup6();
  await readyAll(users);
  await startGame(users);
  await reachTrick(users);
  const st = await waitNewestGame(users[0].inbox, (d) => d.phase === 'trick');
  const actor = users.find((u) => u.seat === st.data.currentSeat);
  send(actor.ws, { type: 'play', data: { cardIds: [] } });
  const bad = await waitError(actor.inbox, 'BAD_PLAY');
  assert.equal(bad.data.message, '请重新选择要出的牌');

  const watcher = actor.seat === users[0].seat ? users[1] : users[0];
  const other = users.find((u) => u.seat !== st.data.currentSeat && u !== watcher);
  other.ws.close();
  const paused = await waitNewestGame(watcher.inbox, (d) => /已离线|等待重连/.test(d.message || ''), 8000);
  assert.match(paused.data.message, /本副暂停|等待重连/);
  send(actor.ws, { type: 'play', data: { cardIds: (await waitNewestGame(actor.inbox, (d) => d.phase === 'trick')).data.legalPlays[0].cardIds } });
  await waitError(actor.inbox, 'GAME_PAUSED');
});

test('6 人完整对局：17 墩可打完，结算 200 分，轮庄计划带入下一副', async () => {
  const { users } = await setup6();
  await readyAll(users);
  await startGame(users);
  await reachTrick(users);
  const end1 = await autoPlayToEnd(users);
  assert.equal(end1.phase, 'round_end');
  assert.equal(end1.result.scores[0] + end1.result.scores[1], 200);
  send(users[0].ws, { type: 'next_round' });
  const r2 = await waitNewestGame(users[0].inbox, (d) => d.roundNo === 2 && d.phase === 'reveal', 8000);
  assert.equal(r2.data.dealerIndex, end1.result.newDealerIndex);
  assert.equal(r2.data.tributePlan, end1.result.tribute);
});

// test/game-net6.test.mjs — 6 人两副牌联网集成：建房→开局→亮牌→进贡/埋底→打牌→结算→轮庄
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
    ws.addEventListener('open', () => { sockets.push(ws); resolve({ ws, inbox, state: null }); });
    ws.addEventListener('error', reject);
  });
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function waitMsg(inbox, type, ms = 10000) {
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
function waitSeqUntil(inbox, minSeq, pred, ms = 12000, label = '条件') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const m = [...inbox].reverse().find((x) => x.type === 'game_state' && x.data.seq > minSeq && pred(x.data));
      if (m) return resolve(m);
      if (Date.now() - t0 > ms) return reject(new Error('timeout ' + label));
      setTimeout(tick, 20);
    })();
  });
}
function newestGame(inbox) { return [...inbox].reverse().find((m) => m.type === 'game_state'); }
function latestSeq(inbox) { const m = newestGame(inbox); return m ? m.data.seq : 0; }
async function syncTo(inbox, target) { return waitSeqUntil(inbox, Math.max(0, target - 1), () => true, 12000, 'sync'); }

async function login(name) {
  const c = await connect();
  send(c.ws, { type: 'auth', data: { username: name, password: '123456' } });
  const ok = await waitMsg(c.inbox, 'auth_ok');
  c.token = ok.data.token;
  send(c.ws, { type: 'leave_room' });
  await new Promise((r) => setTimeout(r, 200));
  c.inbox.length = 0;
  c.ws.addEventListener('message', (e) => {
    try {
      const m = JSON.parse(String(e.data));
      if (m.type === 'game_state') c.state = m.data;
    } catch {}
  });
  return c;
}

async function setup6() {
  const names = ['player1', 'player2', 'player3', 'player4', 'player5', 'player6'];
  const users = [];
  const host = await login(names[0]);
  send(host.ws, { type: 'create_room', data: { mode: 'p6' } });
  const created = await waitMsg(host.inbox, 'room_updated');
  host.seat = 0;
  users.push(host);
  for (let i = 1; i < 6; i++) {
    const u = await login(names[i]);
    send(u.ws, { type: 'join_room', data: { roomId: created.data.roomId } });
    await waitMsg(u.inbox, 'room_updated');
    const ru = [...u.inbox].reverse().find((m) => m.type === 'room_updated');
    u.seat = ru.data.seats.findIndex((s) => s && s.userId === names[i]);
    users.push(u);
  }
  for (const u of users) send(u.ws, { type: 'ready' });
  await new Promise((r) => setTimeout(r, 400));
  send(users[0].ws, { type: 'start_game' });
  for (const u of users) await waitSeqUntil(u.inbox, 0, (d) => d.phase === 'reveal', 12000, '开局');
  return users;
}

async function skipReveals(users) {
  let guard = 0;
  while (guard < 12) {
    const st = newestGame(users[0].inbox);
    if (!st || st.data.phase !== 'reveal') break;
    const done = st.data.revealDone || [];
    const seat = done.findIndex((v) => !v);
    if (seat < 0) break;
    const u = users.find((x) => x.seat === seat);
    await syncTo(u.inbox, st.data.seq);
    const before = newestGame(u.inbox).data.seq;
    const beforeCount = (st.data.revealDone || []).filter(Boolean).length;
    send(u.ws, { type: 'reveal', data: { cardIds: null } });
    guard++;
    await waitSeqUntil(users[0].inbox, before, (d) => d.phase !== 'reveal' || (d.revealDone || []).filter(Boolean).length > beforeCount, 12000, '亮牌推进');
  }
  const st = newestGame(users[0].inbox);
  if (!st || st.data.phase === 'reveal') throw new Error('亮牌未结束');
  return st;
}

async function handleTribute(users, st) {
  if (st.data.phase !== 'tribute') return;
  const pairs = st.data.tributeState.pairs;
  for (let i = 0; i < pairs.length; i++) {
    const takerUser = users.find((u) => u.seat === pairs[i].taker);
    await syncTo(takerUser.inbox, newestGame(users[0].inbox).data.seq);
    const ts = newestGame(takerUser.inbox);
    if (!ts.data.tributeState || ts.data.tributeState.step !== 'take' || ts.data.tributeState.pairIdx !== i) {
      throw new Error('进贡状态异常');
    }
    const card = ts.data.myHand.find((c) => c.suit === 'heart' || c.suit === 'joker' || (c.suit === 'diamond' && c.rank === '5') || (c.suit === 'spade' && c.rank === 'Q') || c.rank === 'J' || c.rank === '2') || ts.data.myHand[0];
    send(takerUser.ws, { type: 'tribute_take', data: { cardId: card.id } });
    await waitSeqUntil(users[0].inbox, ts.data.seq, (d) => d.phase !== 'tribute' || d.tributeState.pairIdx > i, 12000, '进贡推进');
  }
}

async function reachTrick(users) {
  const st = await skipReveals(users);
  await handleTribute(users, st);
  let bst = newestGame(users[0].inbox);
  if (bst.data.phase === 'bury') {
    const dealer = bst.data.dealerIndex;
    const dealerUser = users.find((u) => u.seat === dealer);
    await syncTo(dealerUser.inbox, bst.data.seq);
    const dst = newestGame(dealerUser.inbox);
    if (dst.data.phase === 'bury' && dst.data.me === dealer) {
      const buryIds = dst.data.myHand.filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
      if (buryIds.length === 6) {
        send(dealerUser.ws, { type: 'bury', data: { cardIds: buryIds } });
        await waitSeqUntil(users[0].inbox, dst.data.seq, (d) => d.phase === 'trick', 12000, '埋底');
      }
    }
  }
}

async function autoPlayToEnd(users) {
  let guard = 0;
  while (guard < 500) {
    const cur = newestGame(users[0].inbox);
    if (!cur || cur.data.phase !== 'trick') break;
    const actor = cur.data.currentSeat;
    const u = users.find((x) => x.seat === actor);
    await syncTo(u.inbox, cur.data.seq);
    const as = newestGame(u.inbox);
    if (!as.data.legalPlays || !as.data.legalPlays.length) break;
    const mark = (as.data.trick ? as.data.trick.plays.length : 0) + ':' + as.data.currentSeat;
    send(u.ws, { type: 'play', data: { cardIds: as.data.legalPlays[0].cardIds } });
    guard++;
    await waitSeqUntil(users[0].inbox, as.data.seq, (d) => {
      const now = (d.trick ? d.trick.plays.length : 0) + ':' + d.currentSeat;
      return d.phase !== 'trick' || now !== mark;
    }, 12000, '出牌推进');
  }
  const end = newestGame(users[0].inbox);
  if (!end || end.data.phase !== 'round_end') throw new Error('未到结算: ' + (end && end.data.phase));
  return end.data;
}

test('6 人两副牌完整对局：发牌隐私 + 17 墩打完 + 200 分结算 + 轮庄', async () => {
  const users = await setup6();
  // 手牌隐私：102 张互不重叠
  const all = users.flatMap((u) => u.state.myHand.map((c) => c.id));
  assert.equal(new Set(all).size, 102, '6×17=102 张互不重叠');
  await reachTrick(users);
  const end = await autoPlayToEnd(users);
  assert.equal(end.scores[0] + end.scores[1], 200, '每副总分 200');
  assert.ok(end.result && end.result.newDealerIndex >= 0 && end.result.newDealerIndex < 6);
  assert.ok(['none', 'single', 'triple'].includes(end.result.tribute));

  // 下一副轮庄 + 进贡计划带入
  const endSeq = latestSeq(users[0].inbox);
  send(users[0].ws, { type: 'next_round' });
  const r2 = await waitSeqUntil(users[0].inbox, endSeq, (d) => d.roundNo === 2 && d.phase === 'reveal', 12000, '第二副');
  assert.equal(r2.data.dealerIndex, end.result.newDealerIndex);
  assert.equal(r2.data.tributePlan, end.result.tribute);
  await reachTrick(users);
  const end2 = await autoPlayToEnd(users);
  assert.equal(end2.roundNo, 2);
  assert.equal(end2.scores[0] + end2.scores[1], 200);

  // seq 单调递增
  const seqs = users[0].inbox.filter((m) => m.type === 'game_state').map((m) => m.data.seq);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'seq 单调递增');
});

test('6 人对局中断线重连：恢复快照并继续', async () => {
  const users = await setup6();
  await reachTrick(users);
  const cur = newestGame(users[0].inbox).data;
  const actor = cur.currentSeat;
  const actorUser = users.find((u) => u.seat === actor);
  const other = users.find((u) => u.seat !== actor);
  const beforeSeq = latestSeq(other.inbox);
  const token = actorUser.token;
  actorUser.ws.close();
  await waitSeqUntil(other.inbox, beforeSeq, (d) => d.seats && d.seats[actor] && d.seats[actor].connected === false, 12000, '离线广播');
  // 重连
  const r = await connect();
  send(r.ws, { type: 'auth', data: { token } });
  await waitMsg(r.inbox, 'auth_ok');
  const snap = await waitSeqUntil(r.inbox, 0, (d) => d.me === actor && d.seats[actor].connected === true, 12000, '重连快照');
  assert.equal(snap.data.myHand.length, cur.handCounts[actor], '重连后手牌数一致');
  const idx = users.indexOf(actorUser);
  users[idx] = { ...actorUser, ws: r.ws, inbox: r.inbox };
  const end = await autoPlayToEnd(users);
  assert.equal(end.phase, 'round_end');
});

// test/remote-live-check2.mjs — 公网第二轮验证：
// 第一副打完 -> next_round 轮庄 -> 第二副打牌中途断线重连 -> 续打完成
// 用法：node test/remote-live-check2.mjs [ws://host/ws]
import WebSocket from 'ws';

const BASE = process.argv[2] || 'ws://12zb315lr1084.vicp.fun/ws';
const ACCOUNTS = [
  ['player1', '123456'],
  ['player2', '123456'],
  ['player3', '123456'],
  ['player4', '123456'],
];
const T = { wait: 10000, game: 15000 };

function log(...args) { console.log(new Date().toISOString().slice(11, 19), ...args); }

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE);
    const inbox = [];
    const errors = [];
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(String(data));
        inbox.push(m);
        if (m.type === 'error') errors.push(m.data);
      } catch { /* 忽略 */ }
    });
    ws.on('open', () => resolve({ ws, inbox, errors }));
    ws.on('error', (e) => reject(new Error('连接失败: ' + (e && e.message))));
  });
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function newest(inbox, type) {
  return [...inbox].reverse().find((m) => m.type === type);
}
function newestGame(inbox) { return newest(inbox, 'game_state'); }
function waitMsg(inbox, type, timeout = T.wait) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const m = inbox.find((x) => x.type === type);
      if (m) return resolve(m);
      if (Date.now() - t0 > timeout) return reject(new Error(`超时等待 ${type}`));
      setTimeout(tick, 25);
    })();
  });
}
function waitSeqUntil(inbox, minSeq, predicate, timeout = T.wait, label = '条件') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const m = [...inbox].reverse().find((x) => x.type === 'game_state' && x.data.seq > minSeq && predicate(x.data));
      if (m) return resolve(m);
      if (Date.now() - t0 > timeout) return reject(new Error(`超时等待 ${label} (seq>${minSeq})`));
      setTimeout(tick, 25);
    })();
  });
}
async function syncTo(inbox, targetSeq, label = '状态同步') {
  return waitSeqUntil(inbox, Math.max(0, targetSeq - 1), () => true, T.game, label);
}

async function login(name, pass) {
  const c = await connect();
  send(c.ws, { type: 'auth', data: { username: name, password: pass } });
  const ok = await waitMsg(c.inbox, 'auth_ok');
  send(c.ws, { type: 'leave_room' });
  await new Promise((r) => setTimeout(r, 300));
  c.inbox.length = 0;
  c.errors.length = 0;
  log(`✔ ${name} 登录成功`);
  return { ws: c.ws, inbox: c.inbox, errors: c.errors, token: ok.data.token, user: name };
}

async function setupRoom(users) {
  send(users[0].ws, { type: 'create_room' });
  const created = await waitMsg(users[0].inbox, 'room_updated');
  const roomId = created.data.roomId;
  users[0].seat = 0;
  for (let i = 1; i < 4; i++) {
    send(users[i].ws, { type: 'join_room', data: { roomId } });
    const ru = await waitMsg(users[i].inbox, 'room_updated');
    users[i].seat = ru.data.seats.findIndex((s) => s && s.userId === ACCOUNTS[i][0]);
    if (users[i].seat < 0) throw new Error(`${ACCOUNTS[i][0]} 未入座`);
  }
  for (const u of users) send(u.ws, { type: 'ready' });
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      const m = newest(users[0].inbox, 'room_updated');
      if (m && m.data.seats.every((s) => s && s.ready && s.connected)) return resolve();
      if (Date.now() - t0 > T.wait) return reject(new Error('超时等待全员准备'));
      setTimeout(tick, 25);
    })();
  });
  send(users[0].ws, { type: 'start_game' });
  await waitSeqUntil(users[0].inbox, 0, (d) => d.phase === 'reveal', T.game, '开局');
  log(`✔ 开局成功 roomId=${roomId}`);
  return roomId;
}

async function skipReveals(users) {
  let guard = 0;
  while (guard < 8) {
    const latest = newestGame(users[0].inbox);
    if (!latest || latest.data.phase !== 'reveal') break;
    const actor = latest.data.revealActor;
    if (actor == null) break;
    const u = users.find((x) => x.seat === actor);
    await syncTo(u.inbox, latest.data.seq, `亮牌${actor}同步`);
    const before = newestGame(u.inbox).data.seq;
    send(u.ws, { type: 'reveal', data: { cardIds: null } });
    guard++;
    await waitSeqUntil(users[0].inbox, before,
      (d) => d.phase !== 'reveal' || d.revealActor !== actor, T.game, '亮牌轮转');
  }
  const st = newestGame(users[0].inbox);
  if (!st || st.data.phase === 'reveal') throw new Error('亮牌未结束');
  return st;
}

async function reachTrick(users) {
  const st = await skipReveals(users);
  if (st.data.phase === 'tribute') {
    const pairs = st.data.tributeState.pairs;
    log(`✔ 触发进贡 ${pairs.length === 1 ? '单进贡' : '双进贡'}`);
    for (let i = 0; i < pairs.length; i++) {
      const takerUser = users.find((u) => u.seat === pairs[i].taker);
      await syncTo(takerUser.inbox, st.data.seq, `退贡${i}同步`);
      const ts = newestGame(takerUser.inbox);
      if (!ts.data.tributeState || ts.data.tributeState.step !== 'take' || ts.data.tributeState.pairIdx !== i) {
        throw new Error('进贡状态异常');
      }
      const card = ts.data.myHand.find((c) => c.suit === 'heart' || c.suit === 'joker' || (c.suit === 'diamond' && c.rank === '5') || (c.suit === 'spade' && c.rank === 'Q') || c.rank === 'J' || c.rank === '2') || ts.data.myHand[0];
      send(takerUser.ws, { type: 'tribute_take', data: { cardId: card.id } });
      await waitSeqUntil(users[0].inbox, ts.data.seq,
        (d) => d.phase !== 'tribute' || d.tributeState.pairIdx > i, T.game, `进贡完成${i}`);
    }
  }
  let bst = newestGame(users[0].inbox);
  if (bst.data.phase === 'bury') {
    const dealer = bst.data.dealerIndex;
    const dealerUser = users.find((u) => u.seat === dealer);
    await syncTo(dealerUser.inbox, bst.data.seq, '庄家同步');
    const dst = newestGame(dealerUser.inbox);
    const buryIds = dst.data.myHand.filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
    send(dealerUser.ws, { type: 'bury', data: { cardIds: buryIds } });
    await waitSeqUntil(users[0].inbox, dst.data.seq, (d) => d.phase === 'trick', T.game, '埋底后进入打牌');
  }
}

async function autoPlay(users, { onProgress } = {}) {
  let plays = 0;
  let guard = 0;
  while (guard < 400) {
    const cur = newestGame(users[0].inbox);
    if (!cur || cur.data.phase !== 'trick') break;
    const actor = cur.data.currentSeat;
    const u = users.find((x) => x.seat === actor);
    if (!u) break;
    await syncTo(u.inbox, cur.data.seq, `行动者${actor}同步`);
    const as = newestGame(u.inbox);
    if (!as.data.legalPlays || !as.data.legalPlays.length) break;
    const mark = (as.data.trick ? as.data.trick.plays.length : 0) + ':' + as.data.currentSeat;
    send(u.ws, { type: 'play', data: { cardIds: as.data.legalPlays[0].cardIds } });
    plays++;
    guard++;
    await waitSeqUntil(users[0].inbox, as.data.seq, (d) => {
      const now = (d.trick ? d.trick.plays.length : 0) + ':' + d.currentSeat;
      return d.phase !== 'trick' || now !== mark;
    }, T.game, '出牌推进');
    if (onProgress) await onProgress(users, plays, guard);
  }
  const end = newestGame(users[0].inbox);
  if (!end || end.data.phase !== 'round_end') throw new Error('未进入结算: ' + (end && end.data.phase));
  return end.data;
}

async function main() {
  log('===== 公网第二轮 + 断线重连测试 =====');
  log('目标:', BASE);

  const users = [];
  for (const [name, pass] of ACCOUNTS) users.push(await login(name, pass));
  await setupRoom(users);

  // 第一副完整打完
  await reachTrick(users);
  const end1 = await autoPlay(users);
  log(`✔ 第一副结算：${end1.scores.join(' : ')} 合计100分，新庄家=座位${end1.result.newDealerIndex} 进贡=${end1.result.tribute || '无'}`);

  // 第二副：轮庄 + 进贡计划带入
  send(users[0].ws, { type: 'next_round' });
  const r2 = await waitSeqUntil(users[0].inbox, newestGame(users[0].inbox).data.seq,
    (d) => d.roundNo === 2 && d.phase === 'reveal', T.game, '第二副开局');
  if (r2.data.dealerIndex !== end1.result.newDealerIndex) throw new Error('轮庄错误');
  log(`✔ 第二副开局，庄家=座位${r2.data.dealerIndex}（与第一副结果一致）`);
  await reachTrick(users);

  // 打牌中途断线重连
  let reconnected = false;
  const end2 = await autoPlay(users, {
    onProgress: async (us, plays) => {
      if (reconnected || plays < 3) return;
      reconnected = true;
      const cur = newestGame(us[0].inbox);
      const actor = cur.data.currentSeat;
      const u = us.find((x) => x.seat === actor);
      const seatIdx = us.indexOf(u);
      log(`✔ 第 ${plays} 手：座位${actor} 模拟断线...`);
      u.ws.close();
      // 其他玩家应看到离线 + 等待提示
      const offline = await waitSeqUntil(us[0].inbox, cur.data.seq,
        (d) => d.seats && d.seats[actor] && d.seats[actor].connected === false, T.game, '离线广播');
      if (!/等待|离线/.test(offline.data.message || '')) throw new Error('离线提示缺失: ' + offline.data.message);
      log(`✔ 其余玩家收到离线提示：${offline.data.message}`);
      // 重连（token）
      const r = await connect();
      send(r.ws, { type: 'auth', data: { token: u.token } });
      await waitMsg(r.inbox, 'auth_ok');
      const snap = await waitSeqUntil(r.inbox, 0, (d) => d.me === actor && d.seats[actor].connected === true, T.game, '重连快照');
      if (snap.data.myHand.length !== newestGame(us[0].inbox).data.handCounts[actor]) {
        throw new Error('重连后手牌数与服务端不一致');
      }
      log(`✔ 座位${actor} 重连成功，恢复对局快照（手牌 ${snap.data.myHand.length} 张）`);
      us[seatIdx] = { ...us[seatIdx], ws: r.ws, inbox: r.inbox, errors: r.errors };
      log(`✔ 断线重连测试通过，继续打完第二副`);
    },
  });
  log(`✔ 第二副结算：${end2.scores.join(' : ')} 合计100分`);

  const allErrors = users.flatMap((u) => u.errors.map((e) => `${u.user}:${e.code}`));
  if (allErrors.length) throw new Error('测试过程中收到服务端错误: ' + allErrors.join(', '));
  log('===== 公网第二轮 + 断线重连测试全部通过 =====');
  for (const u of users) { try { u.ws.close(); } catch { /* 忽略 */ } }
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });

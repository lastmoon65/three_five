// test/remote-live-check.mjs — 对公网部署做端到端冒烟：
// 登录后先清理残留房间 -> 4 人建房 -> 准备 -> 开局 -> 亮牌 -> 进贡/埋底 -> 自动打完一副 -> 校验结算
// 用法：node test/remote-live-check.mjs [ws://host/ws]
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
function newestGame(inbox) {
  return [...inbox].reverse().find((m) => m.type === 'game_state');
}
function latestSeq(inbox) {
  const m = newestGame(inbox);
  return m ? m.data.seq : 0;
}
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
// 等待 seq > minSeq 且满足条件的 game_state（用于"行动后等推进"）
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
// 同步：等待该玩家收件箱推进到 seq >= target（拿到与参考方一致的最新状态）
async function syncTo(inbox, targetSeq, label = '状态同步') {
  return waitSeqUntil(inbox, Math.max(0, targetSeq - 1), () => true, T.game, label);
}

async function login(name, pass) {
  const c = await connect();
  send(c.ws, { type: 'auth', data: { username: name, password: pass } });
  await waitMsg(c.inbox, 'auth_ok');
  // 清理：若残留房间（含进行中的对局），先退出。房主退出会解散房间。
  send(c.ws, { type: 'leave_room' });
  await new Promise((r) => setTimeout(r, 300));
  // 清掉登录/清理期间的旧消息，避免误读到残留房间的 room_updated
  c.inbox.length = 0;
  c.errors.length = 0;
  log(`✔ ${name} 登录成功（已清理旧房间）`);
  return { ws: c.ws, inbox: c.inbox, errors: c.errors, token: null, user: name };
}

async function main() {
  log('===== 公网端到端测试 =====');
  log('目标:', BASE);

  // 1) 登录 4 人（顺带清理残留房间）
  const users = [];
  for (const [name, pass] of ACCOUNTS) users.push(await login(name, pass));

  // 2) 建房 + 加入
  send(users[0].ws, { type: 'create_room' });
  const created = await waitMsg(users[0].inbox, 'room_updated');
  const roomId = created.data.roomId;
  if (created.data.phase !== 'waiting' || created.data.seats.filter(Boolean).length !== 1) {
    throw new Error('建房异常，room_updated 不是新房状态: ' + JSON.stringify(created.data));
  }
  log(`✔ 房主建房 roomId=${roomId}`);
  users[0].seat = 0;
  for (let i = 1; i < 4; i++) {
    send(users[i].ws, { type: 'join_room', data: { roomId } });
    const ru = await waitMsg(users[i].inbox, 'room_updated');
    users[i].seat = ru.data.seats.findIndex((s) => s && s.userId === ACCOUNTS[i][0]);
    if (users[i].seat < 0) throw new Error(`${ACCOUNTS[i][0]} 未出现在房间座位中`);
    log(`✔ ${ACCOUNTS[i][0]} 入座 座位${users[i].seat}`);
  }

  // 3) 全员准备 + 房主开局
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
  await waitSeqUntil(users[0].inbox, 0,
    (d) => d.phase === 'reveal', T.game, '开局进入亮牌阶段');
  log('✔ 4 人全部准备，开局成功');

  // 4) 亮牌：全部跳过（行动者先同步，再行动，再等推进）
  let guard = 0;
  while (guard < 8) {
    const latest = newestGame(users[0].inbox);
    if (!latest || latest.data.phase !== 'reveal') break;
    const actor = latest.data.revealActor;
    if (actor == null) break;
    const u = users.find((x) => x.seat === actor);
    if (!u) throw new Error('找不到亮牌行动者座位 ' + actor);
    await syncTo(u.inbox, latest.data.seq, `亮牌行动者${actor}同步`);
    const before = newestGame(u.inbox).data.seq;
    send(u.ws, { type: 'reveal', data: { cardIds: null } });
    guard++;
    await waitSeqUntil(users[0].inbox, before,
      (d) => d.phase !== 'reveal' || d.revealActor !== actor, T.game, '亮牌轮转');
  }
  const revealEnd = newestGame(users[0].inbox);
  if (!revealEnd || revealEnd.data.phase === 'reveal') {
    throw new Error('亮牌未结束: ' + (revealEnd && revealEnd.data.phase));
  }
  log(`✔ 亮牌阶段完成，进入 ${revealEnd.data.phase}`);

  // 5) 进贡（若有）-> 埋底 -> 打牌
  if (revealEnd.data.phase === 'tribute') {
    const pairs = revealEnd.data.tributeState.pairs;
    log(`✔ 触发进贡 ${pairs.length === 1 ? '单进贡' : '双进贡'}`);
    for (let i = 0; i < pairs.length; i++) {
      const takerUser = users.find((u) => u.seat === pairs[i].taker);
      await syncTo(takerUser.inbox, revealEnd.data.seq, `进贡退牌者${i}同步`);
      const ts = newestGame(takerUser.inbox);
      if (!ts.data.tributeState || ts.data.tributeState.step !== 'take' || ts.data.tributeState.pairIdx !== i) {
        throw new Error('进贡状态异常: ' + JSON.stringify(ts.data.tributeState));
      }
      const card = ts.data.myHand.find((c) => c.suit === 'heart' || c.suit === 'joker' || (c.suit === 'diamond' && c.rank === '5') || (c.suit === 'spade' && c.rank === 'Q') || c.rank === 'J' || c.rank === '2') || ts.data.myHand[0];
      send(takerUser.ws, { type: 'tribute_take', data: { cardId: card.id } });
      await waitSeqUntil(users[0].inbox, ts.data.seq,
        (d) => d.phase !== 'tribute' || d.tributeState.pairIdx > i, T.game, `进贡完成${i}`);
    }
    const afterTribute = newestGame(users[0].inbox);
    if (afterTribute.data.phase !== 'bury') throw new Error('进贡后未进入埋底: ' + afterTribute.data.phase);
    log('✔ 进贡完成，进入埋底');
  }

  let bst = newestGame(users[0].inbox);
  if (bst.data.phase === 'bury') {
    const dealer = bst.data.dealerIndex;
    const dealerUser = users.find((u) => u.seat === dealer);
    await syncTo(dealerUser.inbox, bst.data.seq, `庄家${dealer}同步`);
    const dst = newestGame(dealerUser.inbox);
    if (dst.data.phase !== 'bury' || dst.data.me !== dealer) throw new Error('庄家埋底状态异常');
    const buryIds = dst.data.myHand.filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
    send(dealerUser.ws, { type: 'bury', data: { cardIds: buryIds } });
    await waitSeqUntil(users[0].inbox, dst.data.seq, (d) => d.phase === 'trick', T.game, '埋底后进入打牌');
    log('✔ 埋底完成，底牌公开');
  }

  // 6) 自动打完一整副
  let plays = 0;
  guard = 0;
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
    if (plays % 10 === 0) log(`  ... 已出 ${plays} 手`);
  }
  log(`✔ 打牌完成，共 ${plays} 手`);

  const end = newestGame(users[0].inbox);
  if (!end || end.data.phase !== 'round_end') throw new Error('未进入结算: ' + (end && end.data.phase));
  const r = end.data.result;
  if (!r) throw new Error('round_end 缺少 result');
  const scoreSum = r.scores[0] + r.scores[1];
  if (scoreSum !== 100) throw new Error(`得分和异常: ${scoreSum}`);
  log('✔ 整副牌打完，结算正常：');
  log(`   庄家留庄=${r.dealerStay} 新庄家=座位${r.newDealerIndex} 进贡计划=${r.tribute || '无'}`);
  log(`   得分 [${r.scores.join(', ')}] 合计=${scoreSum}分`);

  // 7) seq 单调递增 + 无服务端报错
  const seqs = users[0].inbox.filter((m) => m.type === 'game_state').map((m) => m.data.seq);
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] <= seqs[i - 1]) throw new Error(`seq 未递增: ${seqs[i - 1]} -> ${seqs[i]}`);
  }
  const allErrors = users.flatMap((u) => u.errors.map((e) => `${u.user}:${e.code}`));
  if (allErrors.length) throw new Error('测试过程中收到服务端错误: ' + allErrors.join(', '));
  log(`✔ 快照 seq 单调递增（共 ${seqs.length} 个状态），全程无服务端报错`);

  for (const u of users) { try { u.ws.close(); } catch { /* 忽略 */ } }
  log('===== 公网端到端测试全部通过 =====');
}

main().then(
  () => process.exit(0),
  (e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); }
);

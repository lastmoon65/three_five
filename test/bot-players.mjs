// test/bot-players.mjs — 陪玩机器人：坐进房间、准备、按规则自动打完
// 策略：有 三五反 就亮（优先五反）、出牌优先 真杠/假杠/四清、退贡退主牌、埋底扣无分
// 用法：node test/bot-players.mjs [ws://host/ws] [房间号] [账号1,账号2,...]
import WebSocket from 'ws';

const BASE = process.argv[2] || 'ws://127.0.0.1:8095/ws';
const ROOM = process.argv[3] || '';
const ACCOUNTS = (process.argv[4] || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!ROOM || ACCOUNTS.length === 0) {
  console.error('用法: node test/bot-players.mjs <ws> <房间号> <账号1,账号2,...>');
  process.exit(1);
}

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

async function bot(name) {
  const ws = new WebSocket(BASE);
  let me = null;
  let lastSeq = 0;
  let readySent = false;
  let triedReveal = 0; // 本轮是否已尝试亮牌（防重复/被拒后重发）

  ws.on('message', (d) => {
    let m;
    try { m = JSON.parse(String(d)); } catch { return; }
    const data = m.data || {};
    if (m.type === 'auth_ok') {
      me = data.user.username;
      log(`${name} 登录成功`);
      ws.send(JSON.stringify({ type: 'join_room', data: { roomId: ROOM } }));
    }
    if (m.type === 'room_updated') {
      // 仅在等待阶段且自己未准备时才发送准备，避免重连时误取消
      const mySeat = (data.seats || []).find((s) => s && s.userId === me);
      if (data.phase === 'waiting' && mySeat && !mySeat.ready && !readySent) {
        readySent = true;
        ws.send(JSON.stringify({ type: 'ready' }));
        log(`${name} 已准备`);
      }
    }
    if (m.type === 'game_state') {
      if (data.seq <= lastSeq) return;
      lastSeq = data.seq;
      act(data);
    }
  });

  function act(st) {
    if (me == null) return;
    const seatIdx = (st.seats || []).findIndex((s) => s && s.userId === me);
    if (seatIdx < 0) return;
    // 亮牌：同时进行，未提交就亮（优先五反）或跳过，每轮只试一次
    if (st.phase === 'reveal') {
      if (st.revealDone && !st.revealDone[seatIdx] && triedReveal !== st.roundNo) {
        triedReveal = st.roundNo;
        const opts = st.revealOptions || [];
        const pick = opts.find((o) => o.level === 'wu') || opts[0];
        if (pick && pick.cardIds) {
          ws.send(JSON.stringify({ type: 'reveal', data: { cardIds: pick.cardIds } }));
          log(`${name} 亮${pick.level === 'wu' ? '五反' : '三反'}`);
        } else {
          ws.send(JSON.stringify({ type: 'reveal', data: { cardIds: null } }));
        }
      }
      return;
    }
    if (st.phase === 'tribute' && st.tributeState && st.tributeState.step === 'take' && st.currentSeat === seatIdx) {
      const take = (st.takeOptions && st.takeOptions[0]) || (st.myHand && st.myHand[0] && st.myHand[0].id);
      if (take) ws.send(JSON.stringify({ type: 'tribute_take', data: { cardId: take } }));
      return;
    }
    if (st.phase === 'bury' && st.currentSeat === seatIdx && st.me === seatIdx) {
      const ids = (st.myHand || []).filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
      if (ids.length === 6) ws.send(JSON.stringify({ type: 'bury', data: { cardIds: ids } }));
      return;
    }
    if (st.phase === 'trick' && st.currentSeat === seatIdx) {
      // 优先出杠（真杠/假杠/四清），否则按提示第一手
      const kong = st.kongPlays && st.kongPlays[0];
      const play = kong || (st.legalPlays && st.legalPlays[0]);
      if (play && play.cardIds && play.cardIds.length) {
        if (kong) log(`${name} 出${kong.label}`);
        ws.send(JSON.stringify({ type: 'play', data: { cardIds: play.cardIds } }));
      }
    }
  }

  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'auth', data: { username: name, password: '123456' } }));
  log(`${name} 已连接`);
}

log('陪玩机器人启动，目标:', BASE, '房间:', ROOM, '账号:', ACCOUNTS.join(','));
for (const b of ACCOUNTS) bot(b).catch((e) => log('机器人异常:', b, e.message));

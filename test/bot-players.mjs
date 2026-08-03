// test/bot-players.mjs — 陪玩机器人：坐进房间、准备、按规则自动打完
// 用法：node test/bot-players.mjs [ws://host/ws] [房间号]
import WebSocket from 'ws';

const BASE = process.argv[2] || 'ws://127.0.0.1:8095/ws';
const ROOM = process.argv[3] || '847986';
// 三个机器人账号：tingjie 已在房内（探测时占座），player5/player6 新加入
const BOTS = [
  ['tingjie', '123456'],
  ['player5', '123456'],
  ['player6', '123456'],
];

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

async function bot([name, pass]) {
  const ws = new WebSocket(BASE);
  let me = null;
  let lastSeq = 0;
  let readySent = false;
  const inbox = [];

  ws.on('message', (d) => {
    let m;
    try { m = JSON.parse(String(d)); } catch { return; }
    inbox.push(m);
    const data = m.data || {};
    if (m.type === 'auth_ok') {
      me = data.user.username;
      log(`${name} 登录成功`);
      // 已在房间则自动回席；否则加入
      if (!inbox.some((x) => x.type === 'room_updated')) {
        ws.send(JSON.stringify({ type: 'join_room', data: { roomId: ROOM } }));
      }
    }
    if (m.type === 'room_updated') {
      if (!readySent) {
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
    // 亮牌：同时进行，未提交就跳过
    if (st.phase === 'reveal') {
      if (st.revealDone && !st.revealDone[seatIdx]) {
        ws.send(JSON.stringify({ type: 'reveal', data: { cardIds: null } }));
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
      const play = st.legalPlays && st.legalPlays[0];
      if (play && play.cardIds && play.cardIds.length) {
        ws.send(JSON.stringify({ type: 'play', data: { cardIds: play.cardIds } }));
      }
    }
  }

  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'auth', data: { username: name, password: pass } }));
  log(`${name} 已连接，等待对局`);
}

log('陪玩机器人启动，目标:', BASE, '房间:', ROOM);
for (const b of BOTS) bot(b).catch((e) => log('机器人异常:', b[0], e.message));

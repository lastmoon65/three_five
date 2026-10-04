// net-server.mjs — 红心对决 联网版服务（M1 鉴权 + M2 房间）
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { ACCOUNTS } from './config.mjs';
import { Game } from './game/game.mjs';
import { Game6 } from './game/game6.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const NICK = new Map(ACCOUNTS.map((a) => [a.username, a.nickname]));
const LOG_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'logs');
function logError(tag, err) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'server.log'), `[${new Date().toISOString()}] ${tag}: ${(err && err.stack) || err}\n`);
  } catch { /* 日志失败不影响服务 */ }
}
process.on('uncaughtException', (e) => logError('uncaughtException', e));
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));

export async function startNetServer({ port = 8090, staticRoot, heartbeatMs = 30000 } = {}) {
  const root = normalize(staticRoot || join(fileURLToPath(new URL('.', import.meta.url)), 'public-net'));
  const passwords = new Map(ACCOUNTS.map((a) => [a.username, a.password]));
  const sessions = new Map(); // username -> { token, ws|null }
  const tokens = new Map();   // token -> username
  const rooms = new Map();    // roomId -> room
  const userRoom = new Map(); // username -> roomId

  const server = http.createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path === '/') path = '/index.html';
      const file = normalize(join(root, path.slice(1)));
      if (!file.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
      const data = await readFile(file);
      // 禁止缓存：前端改版后刷新即可生效，避免手机旧样式残留
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('Not Found');
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { ws.terminate(); }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function err(ws, code, message) { send(ws, { type: 'error', data: { code, message } }); }
  function broadcastPresence() {
    const online = [...sessions.entries()].filter(([, s]) => s.ws).map(([u]) => u).sort();
    const msg = JSON.stringify({ type: 'presence', data: { online } });
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
  }

  /* ---------- 房间 ---------- */
  function seatDTO(room, seat) {
    if (!seat) return null;
    const s = sessions.get(seat.username);
    return {
      seatId: seat.seatId,
      userId: seat.username,
      nickname: NICK.get(seat.username) || seat.username,
      ready: seat.ready,
      connected: !!(s && s.ws),
      isHost: room.hostSeatId === seat.seatId,
    };
  }
  function roomDTO(room) {
    return {
      roomId: room.roomId,
      mode: room.mode || 'p4',
      phase: room.phase,
      hostSeatId: room.hostSeatId,
      seats: room.seats.map((s) => seatDTO(room, s)),
    };
  }
  function broadcastRoom(room) {
    const dto = roomDTO(room);
    for (const seat of room.seats) {
      if (!seat) continue;
      const s = sessions.get(seat.username);
      if (s && s.ws) send(s.ws, { type: 'room_updated', data: dto });
    }
  }
  function sendRoomTo(username, room) {
    const s = sessions.get(username);
    if (s && s.ws) send(s.ws, { type: 'room_updated', data: roomDTO(room) });
  }
  function genRoomId(mode) {
    const len = mode === 'p6' ? 6 : 4;
    let id;
    do {
      id = '';
      for (let i = 0; i < len; i++) id += String(Math.floor(Math.random() * 10));
    } while (rooms.has(id));
    return id;
  }
  function dissolveRoom(room, reason) {
    rooms.delete(room.roomId);
    for (const seat of room.seats) if (seat) userRoom.delete(seat.username);
    for (const seat of room.seats) {
      if (!seat) continue;
      const s = sessions.get(seat.username);
      if (s && s.ws) send(s.ws, { type: 'room_dissolved', data: { roomId: room.roomId, reason } });
    }
  }
  function sendLeft(username, roomId) {
    const s = sessions.get(username);
    if (s && s.ws) send(s.ws, { type: 'left_room', data: { roomId: roomId || null } });
  }
  function leaveRoom(username) {
    const roomId = userRoom.get(username);
    if (!roomId) { sendLeft(username, null); return; }
    const room = rooms.get(roomId);
    if (!room) { userRoom.delete(username); sendLeft(username, roomId); return; }
    const idx = room.seats.findIndex((s) => s && s.username === username);
    userRoom.delete(username);
    if (idx < 0) { sendLeft(username, roomId); return; }
    // 游戏进行中任何人退出 → 本局作废、房间解散；等待阶段：房主退出解散，非房主清座
    if (room.phase === 'playing' || room.hostSeatId === idx) {
      dissolveRoom(room, room.hostSeatId === idx ? 'HOST_LEFT' : 'GAME_LEFT');
      return;
    }
    room.seats[idx] = null;
    broadcastRoom(room);
    sendLeft(username, roomId);
  }

  /* ---------- 对局 ---------- */
  function buildGameState(room, seatIdx, seq = 0) {
    const g = room.game;
    if (!g) return null;
    const s = g.state();
    const revealActor = s.revealOrder ? s.revealOrder[s.revealIdx] : null;
    let revealOptions = [];
    const canRevealNow = s.phase === 'reveal' && !(s.revealDone && s.revealDone[seatIdx]);
    const canBuryReveal = s.phase === 'bury' && s.dealerIndex === seatIdx && !s.effectiveReveal;
    if (canRevealNow || canBuryReveal) {
      try { revealOptions = g.legalReveals(seatIdx).map((o) => ({ ...o, cardIds: o.cardIds.slice() })); } catch { /* 忽略 */ }
    }
    let takeOptions = [];
    if (s.phase === 'tribute' && s.tributeState && s.tributeState.step === 'take' && s.currentSeat === seatIdx) {
      const revealedSet = new Set(s.revealed.map((r) => r.id));
      const mains = s.hands[seatIdx].filter((c) => c.suit === 'heart' || c.suit === 'joker' || (c.suit === 'diamond' && c.rank === '5') || (c.suit === 'spade' && c.rank === 'Q') || c.rank === 'J' || c.rank === '2' || revealedSet.has(c.id));
      takeOptions = (mains.length ? mains : s.hands[seatIdx]).map((c) => c.id);
    }
    let lastGive = null;
    if (s.lastGive) {
      const card = g.cardById(s.lastGive.cardId);
      lastGive = { from: s.lastGive.from, to: s.lastGive.to, card: { id: card.id, rank: card.rank, suit: card.suit, points: card.points } };
    }
    let trick = s.trick ? JSON.parse(JSON.stringify(s.trick)) : null;
    let playHints = null;
    let legalPlays = [];
    let kongPlays = [];
    if (s.phase === 'trick' && s.currentSeat === seatIdx) {
      try { playHints = g.playHints(); } catch { playHints = null; }
      try {
        legalPlays = g.legalPlays().map((p) => ({ ...p, cardIds: p.cardIds.slice() }));
      } catch { legalPlays = []; }
      const seen = new Set();
      for (const p of legalPlays) {
        const cards = p.cardIds.map((id) => g.cardById(id));
        const isKong = p.dimension === 'four_clear' || (cards.length === 4 && cards.every((c) => c.rank === cards[0].rank)) || (p.dimension === 'fake_kong' && cards.some((c) => c.suit === 'spade' && c.rank === 'Q'));
        if (!isKong) continue;
        const key = p.cardIds.slice().sort().join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const label = cards.length === 4 && cards.every((c) => c.rank === cards[0].rank)
          ? (cards[0].rank === '4' ? '四清' : '真杠' + cards[0].rank)
          : '假杠';
        kongPlays.push({ cardIds: p.cardIds.slice(), dimension: p.dimension, label });
      }
    }
    const SUITSYM = { spade: '♠', heart: '♥', club: '♣', diamond: '♦' };
    const cardTxt = (c) => c ? (c.suit === 'joker' ? (String(c.rank).includes('big') ? '大王' : '小王') : (SUITSYM[c.suit] || '') + c.rank) : '';
    const nickOf = (seat) => { const se = room.seats[seat]; return se ? (NICK.get(se.username) || se.username) : '?'; };
    let message;
    if (s.phase === 'reveal') {
      const done = (s.revealDone || []).filter(Boolean).length;
      const total = room.seats.filter(Boolean).length;
      message = s.revealDone && s.revealDone[seatIdx]
        ? '已选择（' + done + '/' + total + '），等待其他玩家'
        : '亮牌阶段：三张3=三反 / 三张5=五反，每人可同时亮或跳过';
    } else if (s.phase === 'tribute') {
      const st = s.tributeState;
      const giveTxt = lastGive ? (nickOf(lastGive.from) + ' 进贡 ' + cardTxt(lastGive.card) + ' 给 ' + nickOf(lastGive.to)) : '庄家方进最大牌';
      if (st && st.step === 'take') {
        const who = nickOf(s.currentSeat);
        message = s.currentSeat === seatIdx
          ? (lastGive ? cardTxt(lastGive.card) + ' 已进贡给你，请点选一张主牌（高亮）退贡' : '轮到你了：退一张主牌')
          : '等待 ' + who + ' 退贡（' + giveTxt + '）';
      } else message = '进贡阶段：' + giveTxt;
    } else if (s.phase === 'bury') {
      message = s.currentSeat === seatIdx ? '庄家选 6 张无分牌扣底（底牌将公开）' : '等待庄家埋底';
    } else if (s.phase === 'trick') {
      if (s.trick && s.trick.winnerSeat != null) {
        const who = room.seats[s.trick.winnerSeat] ? (NICK.get(room.seats[s.trick.winnerSeat].username) || room.seats[s.trick.winnerSeat].username) : '?';
        message = who + ' 赢得本墩' + (s.trick.pointsWon ? '，得 ' + s.trick.pointsWon + ' 分' : '');
      } else if (s.currentSeat === seatIdx) {
        message = '轮到你了：出牌';
      } else {
        const who = room.seats[s.currentSeat] ? (NICK.get(room.seats[s.currentSeat].username) || room.seats[s.currentSeat].username) : '?';
        message = '等待 ' + who + ' 出牌';
      }
    } else if (s.phase === 'round_end') {
      const r = s.result;
      if (r) {
        const dTeam = s.dealerIndex % 2;
        const planTxt = r.tribute === 'double' ? ' · 下一副双进贡（两人各进一张）' : r.tribute === 'single' ? ' · 下一副单进贡（庄家进一张）' : ' · 下一副无进贡（闲家需 ≥60 分才有进贡）';
        message = '本副结束 · 庄家方 ' + r.scores[dTeam] + ' 分，闲家方 ' + r.scores[1 - dTeam] + ' 分（闲家得分 ' + r.x + '）· ' + (r.dealerStay ? '庄家守庄（连庄）' : '换庄') + planTxt;
      } else message = '本副结算';
    } else {
      message = '阶段：' + s.phase;
    }
    if (['reveal', 'tribute', 'bury', 'trick'].includes(s.phase)) {
      let actorSeat = s.currentSeat;
      if (s.phase === 'reveal') {
        const done = s.revealDone || [];
        actorSeat = (s.revealOrder && s.revealOrder[s.revealIdx] != null) ? s.revealOrder[s.revealIdx] : done.findIndex((v) => !v);
      }
      const actor = actorSeat != null ? room.seats[actorSeat] : null;
      if (actor) {
        const actSession = sessions.get(actor.username);
        if (!actSession || !actSession.ws) message = (NICK.get(actor.username) || actor.username) + ' 已离线，等待重连（本副暂停）';
      }
    }
    return {
      roomId: room.roomId,
      mode: room.mode || 'p4',
      seq,
      phase: s.phase,
      roundNo: s.roundNo,
      dealerIndex: s.dealerIndex,
      currentSeat: s.currentSeat,
      me: seatIdx,
      revealActor,
      seats: roomDTO(room).seats,
      handCounts: s.handCounts,
      myHand: s.hands[seatIdx].map((c) => ({ ...c, power: g.powerOf(c) })), // power 含亮牌加成
      revealed: s.revealed.map((r) => { const c = g.cardById(r.id); return { id: c.id, suit: c.suit, rank: c.rank, power: g.powerOf(c), points: c.points }; }), // power 含亮牌加成
      effectiveReveal: s.effectiveReveal ? { ...s.effectiveReveal, cardIds: s.effectiveReveal.cardIds.slice() } : null,
      rebellion: s.rebellion,
      rebellionLevel: s.rebellionLevel ?? 0,
      revealBy: s.revealBy || null,
      revealCards: s.revealCards || null,
      revealDone: s.revealDone || null,
      tributePlan: s.tributePlan,
      tributeState: s.tributeState ? JSON.parse(JSON.stringify(s.tributeState)) : null,
      lastGive,
      takeOptions,
      scores: s.scores.slice(),
      bottom: (s.phase === 'trick' || s.phase === 'round_end') && s.bottom ? s.bottom.map((c) => ({ ...c })) : [],
      revealOptions,
      trick,
      playHints,
      legalPlays,
      kongPlays,
      result: s.result ? { ...s.result, scores: s.result.scores.slice() } : null,
      message,
    };
  }
  function broadcastGameState(room) {
    const seq = ++room.seq;
    room.seats.forEach((seat) => {
      if (!seat) return;
      const s = sessions.get(seat.username);
      if (s && s.ws) {
        const gs = buildGameState(room, seat.seatId, seq);
        if (gs) send(s.ws, { type: 'game_state', data: gs });
      }
    });
  }

  /* ---------- 鉴权 ---------- */
  function kick(username) {
    const old = sessions.get(username);
    if (old && old.ws) {
      send(old.ws, { type: 'kicked', data: { reason: 'NEW_SESSION' } });
      try { old.ws.close(4001, 'kicked'); } catch { /* 忽略 */ }
      old.ws = null;
    }
    if (old) tokens.delete(old.token);
  }
  function bind(ws, username) {
    const token = crypto.randomBytes(24).toString('hex');
    kick(username);
    sessions.set(username, { token, ws });
    tokens.set(token, username);
    return token;
  }
  // 登录/重连成功后：若该用户原本在房间，恢复席位并推送房间状态
  function afterAuth(ws, username) {
    ws._username = username;
    const roomId = userRoom.get(username);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) { sendRoomTo(username, room); broadcastRoom(room); if (room.game) broadcastGameState(room); }
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      try {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { err(ws, 'BAD_JSON'); return; }
      if (!msg || typeof msg !== 'object' || !msg.type) { err(ws, 'BAD_MESSAGE'); return; }
      const d = msg.data || {};
      const username = ws._username;

      if (msg.type === 'auth') {
        if (typeof d.token === 'string' && d.token) {
          const uname = tokens.get(d.token);
          if (!uname) { err(ws, 'AUTH_FAIL', 'token 无效'); return; }
          bind(ws, uname);
          send(ws, { type: 'auth_ok', data: { token: sessions.get(uname).token, user: { username: uname, nickname: NICK.get(uname) || uname } } });
          afterAuth(ws, uname);
          broadcastPresence();
          return;
        }
        const uname = String(d.username || '');
        const pwd = String(d.password || '');
        if (passwords.get(uname) !== pwd) { err(ws, 'AUTH_FAIL', '用户名或密码错误'); return; }
        bind(ws, uname);
        send(ws, { type: 'auth_ok', data: { token: sessions.get(uname).token, user: { username: uname, nickname: NICK.get(uname) || uname } } });
        afterAuth(ws, uname);
        broadcastPresence();
        return;
      }

      if (!username) { err(ws, 'AUTH_REQUIRED', '请先登录'); return; }

      if (msg.type === 'create_room') {
        if (userRoom.has(username)) { err(ws, 'ALREADY_IN_ROOM', '你已在房间中'); return; }
        const mode = d.mode === 'p6' ? 'p6' : 'p4';
        const roomId = genRoomId(mode);
        const room = { roomId, mode, phase: 'waiting', hostSeatId: 0, seats: new Array(mode === 'p6' ? 6 : 4).fill(null), game: null, seq: 0 };
        room.seats[0] = { seatId: 0, username, ready: false };
        rooms.set(roomId, room);
        userRoom.set(username, roomId);
        send(ws, { type: 'room_updated', data: roomDTO(room) });
        return;
      }
      if (msg.type === 'join_room') {
        if (userRoom.has(username)) { err(ws, 'ALREADY_IN_ROOM', '你已在房间中'); return; }
        const room = rooms.get(String(d.roomId || ''));
        if (!room) { err(ws, 'ROOM_NOT_FOUND', '房间不存在'); return; }
        const expectMode = String(d.roomId || '').length === 6 ? 'p6' : 'p4';
        if (room.mode !== expectMode) { err(ws, 'JOIN_MODE_MISMATCH', '房号与模式不匹配'); return; }
        const idx = room.seats.findIndex((s) => !s);
        if (idx < 0) { err(ws, 'ROOM_FULL', '房间已满'); return; }
        room.seats[idx] = { seatId: idx, username, ready: false };
        userRoom.set(username, room.roomId);
        broadcastRoom(room);
        return;
      }
      if (msg.type === 'ready') {
        const roomId = userRoom.get(username);
        const room = roomId && rooms.get(roomId);
        if (!room) { err(ws, 'NOT_IN_ROOM', '你不在房间中'); return; }
        const seat = room.seats.find((s) => s && s.username === username);
        if (seat) seat.ready = !seat.ready;
        broadcastRoom(room);
        return;
      }
      if (msg.type === 'leave_room') {
        leaveRoom(username);
        return;
      }
      if (msg.type === 'swap_seats') {
        const roomId = userRoom.get(username);
        const room = roomId && rooms.get(roomId);
        if (!room) { err(ws, 'NOT_IN_ROOM', '你不在房间中'); return; }
        if (room.phase !== 'waiting') { err(ws, 'ROOM_NOT_WAITING', '游戏开始后不能换位'); return; }
        const a = Number(d.a), b = Number(d.b);
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= room.seats.length || b >= room.seats.length || a === b) {
          err(ws, 'BAD_SEATS', '座位参数错误'); return;
        }
        if (a === room.hostSeatId || b === room.hostSeatId) { err(ws, 'HOST_FIXED', '房主座位固定'); return; }
        [room.seats[a], room.seats[b]] = [room.seats[b], room.seats[a]];
        if (room.seats[a]) room.seats[a].seatId = a;
        if (room.seats[b]) room.seats[b].seatId = b;
        broadcastRoom(room);
        return;
      }
      if (msg.type === 'start_game') {
        const roomId = userRoom.get(username);
        const room = roomId && rooms.get(roomId);
        if (!room) { err(ws, 'NOT_IN_ROOM', '你不在房间中'); return; }
        if (room.phase !== 'waiting') { err(ws, 'ROOM_NOT_WAITING', '房间不在等待状态'); return; }
        const hostSeat = room.seats[room.hostSeatId];
        if (!hostSeat || hostSeat.username !== username) { err(ws, 'NOT_HOST', '只有房主可以开始游戏'); return; }
        const need = room.mode === 'p6' ? 6 : 4;
        const allOk = room.seats.length === need && room.seats.every((s) => s && s.ready && sessions.get(s.username) && sessions.get(s.username).ws);
        if (!allOk) { err(ws, 'NOT_READY', '需要 ' + need + ' 人在线且全部已准备'); return; }
        const game = room.mode === 'p6'
          ? new Game6(room.seats.map((s) => s.username))
          : new Game(room.seats.map((s) => NICK.get(s.username) || s.username));
        game.startRound();
        room.game = game;
        room.phase = 'playing';
        broadcastRoom(room);
        broadcastGameState(room);
        return;
      }
      if (msg.type === 'reveal') {
        const roomId = userRoom.get(username);
        const room = roomId && rooms.get(roomId);
        if (!room || !room.game) { err(ws, 'NO_GAME', '游戏未开始'); return; }
        const g = room.game;
        const seatIdx = room.seats.findIndex((s) => s && s.username === username);
        if (seatIdx < 0) { err(ws, 'NOT_IN_ROOM', '你不在房间中'); return; }
        const ids = Array.isArray(d.cardIds) ? d.cardIds : null; // 张数合法性交给引擎校验，不静默当跳过
        const st = g.state();
        if (st.phase === 'reveal') {
          // 同时亮牌：任何座位可提交一次（亮或跳过），全部提交后推进
          try { g.reveal(seatIdx, ids); } catch (e) { err(ws, 'BAD_REVEAL', e.message); return; }
          if (g.state().phase === 'tribute' && g.state().tributeState && g.state().tributeState.step === 'give') g.tributeGive();
          broadcastGameState(room);
          return;
        }
        if (st.phase === 'bury') {
          // 庄家埋底补亮：仅无人亮牌时可用（服务端与引擎双重校验）
          if (seatIdx !== st.dealerIndex) { err(ws, 'NOT_YOUR_TURN', '只有庄家可补亮'); return; }
          try { g.buryReveal(ids); } catch (e) { err(ws, 'BAD_REVEAL', e.message); return; }
          broadcastGameState(room);
          return;
        }
        err(ws, 'BAD_PHASE', '当前不是亮牌阶段');
        return;
      }
      if (msg.type === 'tribute_take') {
        const roomId = userRoom.get(username);
        const room = roomId && rooms.get(roomId);
        if (!room || !room.game) { err(ws, 'NO_GAME', '游戏未开始'); return; }
        const g = room.game;
        const st = g.state();
        if (st.phase !== 'tribute' || !st.tributeState || st.tributeState.step !== 'take') { err(ws, 'BAD_PHASE', '当前不是退贡阶段'); return; }
        const seatIdx = room.seats.findIndex((s) => s && s.username === username);
        if (st.currentSeat !== seatIdx) { err(ws, 'NOT_YOUR_TURN', '还没轮到你退贡'); return; }
        try { g.tributeTake(String(d.cardId || '')); } catch (e) { err(ws, 'BAD_TAKE', e.message); return; }
        if (g.state().phase === 'tribute' && g.state().tributeState && g.state().tributeState.step === 'give') g.tributeGive();
        broadcastGameState(room);
        return;
      }
      if (msg.type === 'bury') {
        const roomId = userRoom.get(username);
        const room = roomId && rooms.get(roomId);
        if (!room || !room.game) { err(ws, 'NO_GAME', '游戏未开始'); return; }
        const g = room.game;
        const st = g.state();
        if (st.phase !== 'bury') { err(ws, 'BAD_PHASE', '当前不是埋底阶段'); return; }
        const seatIdx = room.seats.findIndex((s) => s && s.username === username);
        if (st.currentSeat !== seatIdx) { err(ws, 'NOT_YOUR_TURN', '只有庄家可以埋底'); return; }
        const ids = Array.isArray(d.cardIds) ? d.cardIds : [];
        try { g.bury(ids); } catch (e) { err(ws, 'BAD_BURY', e.message); return; }
        broadcastGameState(room);
        return;
      }
      if (msg.type === 'play') {
        const roomId = userRoom.get(username);
        const room = roomId && rooms.get(roomId);
        if (!room || !room.game) { err(ws, 'NO_GAME', '游戏未开始'); return; }
        const g = room.game;
        const st = g.state();
        if (st.phase !== 'trick') { err(ws, 'BAD_PHASE', '当前不是打牌阶段'); return; }
        const seatIdx = room.seats.findIndex((s) => s && s.username === username);
        if (st.currentSeat !== seatIdx) { err(ws, 'NOT_YOUR_TURN', '还没轮到你出牌'); return; }
        const ids = Array.isArray(d.cardIds) ? d.cardIds : [];
        try { g.play(ids); } catch (e) { err(ws, 'BAD_PLAY', e.message); return; }
        broadcastGameState(room);
        return;
      }
      if (msg.type === 'next_round') {
        const roomId = userRoom.get(username);
        const room = roomId && rooms.get(roomId);
        if (!room || !room.game) { err(ws, 'NO_GAME', '游戏未开始'); return; }
        const g = room.game;
        if (g.state().phase !== 'round_end') { err(ws, 'BAD_PHASE', '当前不是结算阶段'); return; }
        g.nextRound();
        broadcastGameState(room);
        return;
      }
      err(ws, 'UNKNOWN_TYPE', '未知消息类型: ' + msg.type);
      } catch (e) {
        logError('message-handler', e);
        try { err(ws, 'SERVER_ERROR', '服务器内部错误'); } catch { /* 忽略 */ }
      }
    });

    ws.on('close', () => {
      const uname = ws._username;
      if (uname) {
        const s = sessions.get(uname);
        if (s && s.ws === ws) {
          s.ws = null;
          const roomId = userRoom.get(uname);
          if (roomId) {
            const room = rooms.get(roomId);
            if (room) {
              broadcastRoom(room);
              if (room.game) broadcastGameState(room);
            }
          }
        }
      }
      broadcastPresence();
    });
  });

  await new Promise((resolve) => server.listen(port, resolve));
  logError('info', 'server started on port ' + port);
  return {
    server,
    wss,
    port: server.address().port,
    close: () => new Promise((resolve) => { clearInterval(heartbeat); wss.close(); server.close(() => resolve()); }),
    _testReset: () => { rooms.clear(); userRoom.clear(); },
    _testSetTribute: (roomId, plan) => { const r = rooms.get(roomId); if (r && r.game) r.game.tributePlan = plan; },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startNetServer({ port: Number(process.env.PORT) || 8090 });
  console.log('红心对决联网版已启动: http://localhost:' + app.port + '（单机版在 8080）');
}
// public-net/app.js — M1 鉴权 + M2 房间
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'hx_token';
let ws = null;
let token = localStorage.getItem(TOKEN_KEY) || null;
let myName = null;
let room = null; // 当前房间 room_updated 快照
let game = null; // 当前对局 game_state 快照
let handSel = [];   // 进贡/埋底阶段的选牌
let handKey = '';   // 选牌重置依据
let gameSeq = 0;    // 快照序号过滤（丢弃过期快照）

const SUIT_SYM = { spade: '♠', heart: '♥', club: '♣', diamond: '♦', joker: '★' };
const PHASE_LABEL = { reveal: '亮牌', tribute: '进贡/退贡', bury: '埋底', trick: '打牌', round_end: '结算', waiting: '房间' };

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
let noticeTimer = null;
function notice(msg) {
  $('connMsg').textContent = msg;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('connMsg').textContent = ''; }, 2500);
}
function cardLabel(c) {
  if (!c) return '?';
  if (c.suit === 'joker') return '王';
  return (c.rank || '') + (SUIT_SYM[c.suit] || '');
}

function showLogin(msg = '') {
  $('loginView').classList.remove('hidden');
  $('hallView').classList.add('hidden');
  $('roomView').classList.add('hidden');
  $('loginMsg').textContent = msg;
}

function showHall() {
  room = null;
  $('loginView').classList.add('hidden');
  $('roomView').classList.add('hidden');
  $('hallView').classList.remove('hidden');
  $('joinPanel').classList.add('hidden');
}

function showRoom() {
  $('loginView').classList.add('hidden');
  $('hallView').classList.add('hidden');
  $('roomView').classList.remove('hidden');
}

function renderOnline(online) {
  const ul = $('onlineList');
  ul.innerHTML = '';
  (online || []).forEach((name) => {
    const li = document.createElement('li');
    li.textContent = name;
    ul.appendChild(li);
  });
}

const DIM_LABEL = { single: '单张', throw: '甩牌', fake_kong: '假杠', true_kong: '真杠', four_clear: '四清' };
function sameIds(x, y) {
  if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
  const sx = x.map(String).sort(), sy = y.map(String).sort();
  return sx.every((v, i) => v === sy[i]);
}
function selectedPlay() {
  return (game && game.legalPlays || []).find((p) => sameIds(p.cardIds, handSel)) || null;
}

function toggleHandSel(id, maxSel) {
  const i = handSel.indexOf(id);
  if (i >= 0) handSel.splice(i, 1);
  else {
    if (handSel.length >= maxSel) { notice('最多选 ' + maxSel + ' 张'); return; }
    handSel.push(id);
  }
  renderGame();
}

function renderGame() {
  if (!game) return;
  $('loginView').classList.add('hidden');
  $('hallView').classList.add('hidden');
  $('roomView').classList.add('hidden');
  $('gameView').classList.remove('hidden');
  $('gRound').textContent = game.roundNo ?? 1;
  $('gPhase').textContent = PHASE_LABEL[game.phase] || game.phase;
  const seats = game.seats || [];
  const dealer = game.dealerIndex != null ? seats[game.dealerIndex] : null;
  $('gDealer').textContent = dealer ? '庄家：' + dealer.nickname + (game.rebellion ? '（造反成立，本副免进贡）' : '') : '';
  const opp = $('opponents');
  opp.innerHTML = '';
  seats.forEach((seat, i) => {
    if (!seat || seat.seatId === game.me) return;
    const div = document.createElement('div');
    div.className = 'oppRow';
    div.textContent = (seat.seatId + 1) + '号位 · ' + seat.nickname + ' · ' + (game.handCounts[i] ?? 0) + ' 张';
    if (i === game.dealerIndex) div.textContent += '（庄家）';
    if (!seat.connected) div.textContent += '（离线）';
    if (game.revealActor === i && game.phase === 'reveal') div.textContent += ' ← 行动中';
    opp.appendChild(div);
  });
  const p = game.phase;
  const myTurnTake = p === 'tribute' && game.tributeState && game.tributeState.step === 'take' && game.currentSeat === game.me;
  const myTurnBury = p === 'bury' && game.currentSeat === game.me;
  const myTurnPlay = p === 'trick' && game.currentSeat === game.me;
  const interactive = myTurnTake || myTurnBury || myTurnPlay;
  const maxSel = myTurnBury ? 6 : (myTurnPlay ? ((game.playHints && game.playHints.count) ? game.playHints.count : 12) : 1);
  const key = p + ':' + game.currentSeat + ':' + (game.tributeState ? game.tributeState.step + '/' + game.tributeState.pairIdx : '-') + ':' + (game.trick ? game.trick.plays.length : '-');
  if (key !== handKey) { handSel = []; handKey = key; }
  const takeSet = new Set(game.takeOptions || []);
  const allowedSet = new Set((game.playHints && game.playHints.allowed) || []);
  const kongIds = new Set((game.kongPlays || []).flatMap((k) => k.cardIds || []));
  const handEl = $('gHand');
  handEl.innerHTML = '';
  (game.myHand || []).slice().sort((x, y) => y.power - x.power).forEach((c) => {
    const d = document.createElement('div');
    d.className = 'card ' + ((c.suit === 'heart' || c.suit === 'diamond' || c.suit === 'joker') ? 'red' : 'black');
    d.textContent = cardLabel(c);
    if (c.points > 0) d.classList.add('scoring');
    if (handSel.includes(c.id)) d.classList.add('selected');
    if (kongIds.has(c.id)) d.classList.add('suggested');
    if (interactive) {
      if (myTurnTake && !takeSet.has(c.id)) d.classList.add('dim');
      else if (myTurnPlay && game.playHints && game.playHints.count === 1 && allowedSet.has(c.id)) {
        d.classList.add('clickable');
        d.classList.add('hot');
        d.addEventListener('click', () => send({ type: 'play', data: { cardIds: [c.id] } }));
      } else if (myTurnPlay && allowedSet.size > 0 && !allowedSet.has(c.id)) {
        d.classList.add('dim');
      } else {
        d.classList.add('clickable');
        d.addEventListener('click', () => toggleHandSel(c.id, maxSel));
      }
    }
    handEl.appendChild(d);
  });
  const center = $('gCenter');
  center.innerHTML = '';
  const centerParts = [];
  if (game.lastGive) {
    const who = game.seats[game.lastGive.to] ? game.seats[game.lastGive.to].nickname : '?';
    centerParts.push(who + ' 进贡 ' + cardLabel(game.lastGive.card));
  }
  if (game.bottom && game.bottom.length) {
    centerParts.push('底牌（公开）：' + game.bottom.map(cardLabel).join(' '));
  }
  if (game.trick && game.trick.plays && game.trick.plays.length) {
    const dim = game.trick.dimension ? '（' + (DIM_LABEL[game.trick.dimension] || game.trick.dimension) + '）' : '';
    const who = game.trick.leaderSeat != null && seats[game.trick.leaderSeat] ? seats[game.trick.leaderSeat].nickname : '';
    const parts = game.trick.plays.map((pl) => {
      const n = seats[pl.seat] ? seats[pl.seat].nickname : ('玩家' + (pl.seat + 1));
      const cards = (pl.cards || []).map(cardLabel).join(' ') || ((pl.cardIds || []).length + ' 张');
      return n + ':' + cards;
    });
    centerParts.push('领出 ' + who + dim + ' | ' + parts.join('  '));
  }
  if (game.effectiveReveal) {
    const who = game.effectiveReveal.seat != null && seats[game.effectiveReveal.seat] ? seats[game.effectiveReveal.seat].nickname : '?';
    centerParts.push(who + ' 亮出：' + (game.effectiveReveal.level === 'wu' ? '五反' : '三反'));
  }
  if (game.phase === 'reveal') {
    centerParts.push('亮牌阶段：亮出三张3（三反）或三张5（五反）可提升牌力，闲家亮出可造反');
  }
  if (game.phase === 'round_end' && game.result) {
    const r = game.result;
    const dTeam = game.dealerIndex % 2;
    centerParts.push('庄家方 ' + r.scores[dTeam] + ' 分 : ' + r.scores[1 - dTeam] + ' 分 闲家方' + (r.dealerStay ? ' · 守庄' : ' · 换庄') + (r.tribute !== 'none' ? ' · 进贡:' + r.tribute : ''));
  }
  center.textContent = centerParts.join(' | ');
  const btns = $('gButtons');
  btns.innerHTML = '';
  if (game.phase === 'reveal' && game.revealActor === game.me) {
    (game.revealOptions || []).forEach((o) => {
      const b = document.createElement('button');
      b.textContent = '✨ ' + (o.level === 'wu' ? '亮五反' : '亮三反');
      b.addEventListener('click', () => send({ type: 'reveal', data: { cardIds: o.cardIds } }));
      btns.appendChild(b);
    });
    const skip = document.createElement('button');
    skip.textContent = '不亮 / 跳过';
    skip.className = 'ghost';
    skip.addEventListener('click', () => send({ type: 'reveal', data: { cardIds: null } }));
    btns.appendChild(skip);
  } else if (myTurnTake) {
    const b = document.createElement('button');
    b.textContent = handSel.length === 1 ? '退贡（1 张）' : '退贡';
    b.disabled = handSel.length !== 1;
    b.addEventListener('click', () => { send({ type: 'tribute_take', data: { cardId: handSel[0] } }); handSel = []; });
    btns.appendChild(b);
  } else if (myTurnBury) {
    const b = document.createElement('button');
    b.textContent = '确认埋底（' + handSel.length + '/6）';
    b.disabled = handSel.length !== 6;
    b.addEventListener('click', () => { send({ type: 'bury', data: { cardIds: handSel } }); handSel = []; });
    btns.appendChild(b);
    if (handSel.length > 0) {
      const c = document.createElement('button');
      c.textContent = '清空';
      c.className = 'ghost';
      c.addEventListener('click', () => { handSel = []; renderGame(); });
      btns.appendChild(c);
    }
  } else if (myTurnPlay) {
    (game.kongPlays || []).forEach((k) => {
      const b = document.createElement('button');
      b.textContent = '🔥 ' + k.label;
      b.addEventListener('click', () => send({ type: 'play', data: { cardIds: k.cardIds } }));
      btns.appendChild(b);
    });
    const hints = game.playHints;
    if (hints && hints.auto) {
      const nb = document.createElement('button');
      nb.textContent = '垫出全部分值牌（' + (hints.allowed || []).length + ' 张）';
      nb.addEventListener('click', () => send({ type: 'play', data: { cardIds: hints.allowed } }));
      btns.appendChild(nb);
    } else if (!(hints && hints.count === 1)) {
      const sel = selectedPlay();
      const b = document.createElement('button');
      b.textContent = sel ? '出牌：' + (DIM_LABEL[sel.dimension] || sel.dimension) + '（' + sel.cardIds.length + ' 张）' : '出牌';
      b.disabled = !sel;
      b.addEventListener('click', () => { send({ type: 'play', data: { cardIds: handSel } }); handSel = []; });
      btns.appendChild(b);
      if (handSel.length > 0) {
        const c = document.createElement('button');
        c.textContent = '清空';
        c.className = 'ghost';
        c.addEventListener('click', () => { handSel = []; renderGame(); });
        btns.appendChild(c);
      }
    }
  } else if (p === 'round_end') {
    const b = document.createElement('button');
    b.textContent = '下一副';
    b.addEventListener('click', () => send({ type: 'next_round' }));
    btns.appendChild(b);
  }
  $('gMsg').textContent = game.message || '';
}

function renderRoom() {
  if (!room) return;
  showRoom();
  $('roomNum').textContent = room.roomId;
  const seatsEl = $('seats');
  seatsEl.innerHTML = '';
  room.seats.forEach((seat) => {
    const div = document.createElement('div');
    div.className = 'seatRow';
    if (!seat) {
      div.textContent = '空位';
      div.classList.add('empty');
    } else {
      div.textContent = (seat.seatId + 1) + '号位 · ' + seat.nickname;
      if (seat.isHost) div.textContent += '（房主）';
      if (seat.ready) div.textContent += '（已准备）';
      if (!seat.connected) div.textContent += '（离线）';
      if (seat.userId === myName) div.classList.add('me');
    }
    seatsEl.appendChild(div);
  });
  const meSeat = room.seats.find((s) => s && s.userId === myName);
  const allReady = room.seats.every((s) => s && s.ready && s.connected) && room.seats.length === 4;
  $('readyBtn').textContent = (meSeat && meSeat.ready) ? '取消准备' : '准备';
  $('startGameBtn').classList.toggle('hidden', !(room.hostSeatId != null && room.seats[room.hostSeatId] && room.seats[room.hostSeatId].userId === myName));
  $('startGameBtn').disabled = !allReady;
  $('roomTip').textContent = allReady ? '4 人在线且已准备，房主可开始游戏（M3 接入）' : `等待玩家就绪（在线已准备 ${room.seats.filter((s) => s && s.ready && s.connected).length}/4）`;
}

function handle(msg) {
  if (!msg || !msg.type) return;
  const d = msg.data || {};
  if (msg.type === 'auth_ok') {
    token = d.token;
    myName = d.user.username;
    localStorage.setItem(TOKEN_KEY, token);
    $('me').textContent = d.user.nickname || d.user.username;
    if (game) {
      $('connMsg').textContent = '已重连，恢复对局…';
      renderGame();
    } else {
      showHall();
    }
  } else if (msg.type === 'presence') {
    renderOnline(d.online);
  } else if (msg.type === 'room_updated') {
    room = d;
    const stillIn = d.seats.some((s) => s && s.userId === myName);
    if (!stillIn) { game = null; showHall(); }
    else if (game && d.phase === 'playing') renderGame();
    else renderRoom();
  } else if (msg.type === 'game_state') {
    if (d.seq != null && gameSeq > 0 && d.seq <= gameSeq) return; // 丢弃过期快照
    gameSeq = d.seq != null ? d.seq : gameSeq;
    game = d;
    renderGame();
  } else if (msg.type === 'room_dissolved') {
    game = null;
    $('connMsg').textContent = '房间已解散，返回大厅';
    showHall();
  } else if (msg.type === 'kicked') {
    token = null;
    localStorage.removeItem(TOKEN_KEY);
    myName = null;
    if (ws) ws.close();
    showLogin('该账号已在别处登录，你已被顶下线');
  } else if (msg.type === 'error') {
    $('connMsg').textContent = d.message || '出错';
  }
}

function connect(credentials) {
  if (ws) { try { ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    $('connMsg').textContent = '';
    gameSeq = 0;
    send({ type: 'auth', data: credentials });
  };
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    if (token) {
      $('connMsg').textContent = '连接断开，正在重连…';
      setTimeout(() => connect({ token }), 1500);
    } else if (document.visibilityState !== 'hidden') {
      $('connMsg').textContent = '未连接';
    }
  };
  ws.onerror = () => { $('connMsg').textContent = '连接失败，请检查服务器'; };
}

/* ---------- 事件 ---------- */
$('loginBtn').addEventListener('click', () => {
  const username = $('username').value.trim();
  const password = $('password').value;
  if (!username || !password) { showLogin('请输入用户名和密码'); return; }
  connect({ username, password });
});
$('logoutBtn').addEventListener('click', () => {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  myName = null;
  if (ws) ws.close();
  showLogin();
});
$('createRoomBtn').addEventListener('click', () => send({ type: 'create_room' }));
$('joinRoomBtn').addEventListener('click', () => $('joinPanel').classList.remove('hidden'));
$('joinCancelBtn').addEventListener('click', () => $('joinPanel').classList.add('hidden'));
$('joinConfirmBtn').addEventListener('click', () => {
  const id = $('joinRoomInput').value.trim();
  if (!/^\d{6}$/.test(id)) { $('connMsg').textContent = '请输入 6 位房间号'; return; }
  $('joinPanel').classList.add('hidden');
  send({ type: 'join_room', data: { roomId: id } });
});
$('readyBtn').addEventListener('click', () => send({ type: 'ready' }));
$('leaveRoomBtn').addEventListener('click', () => send({ type: 'leave_room' }));
$('startGameBtn').addEventListener('click', () => send({ type: 'start_game' }));
$('gResetBtn').addEventListener('click', () => location.reload());
$('swapBtn').addEventListener('click', () => send({ type: 'swap_seats', data: { a: 2, b: 3 } }));
$('copyRoomBtn').addEventListener('click', () => {
  if (navigator.clipboard && room) navigator.clipboard.writeText(room.roomId).then(() => $('connMsg').textContent = '房号已复制');
  else $('connMsg').textContent = '复制失败，请手动记下房号';
});

// 已有 token：自动重连
if (token) {
  showLogin('正在恢复登录…');
  connect({ token });
} else {
  showLogin();
}
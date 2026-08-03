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
let mode = 'p4';      // 当前模式 p4|p6
let swapSel = null;   // 6 人房换位选中座位

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

function showMode() {
  $('loginView').classList.add('hidden');
  $('hallView').classList.add('hidden');
  $('roomView').classList.add('hidden');
  $('gameView').classList.add('hidden');
  $('modeView').classList.remove('hidden');
}

function showLogin(msg = '') {
  $('modeView').classList.add('hidden');
  $('hallView').classList.add('hidden');
  $('roomView').classList.add('hidden');
  $('gameView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  $('loginMsg').textContent = msg;
}

function showHall() {
  room = null;
  $('modeView').classList.add('hidden');
  $('loginView').classList.add('hidden');
  $('roomView').classList.add('hidden');
  $('gameView').classList.add('hidden');
  $('hallView').classList.remove('hidden');
  $('joinPanel').classList.add('hidden');
  $('modeLabel').textContent = mode === 'p6' ? '6 人模式（两副牌）' : '4 人模式（一副牌）';
  $('joinRoomInput').placeholder = mode === 'p6' ? '6 位房间号' : '4 位房间号';
  $('hallTip').textContent = (mode === 'p6' ? 6 : 4) + ' 人坐满并全部准备后，房主可开始游戏';
}

function showRoom() {
  $('modeView').classList.add('hidden');
  $('loginView').classList.add('hidden');
  $('hallView').classList.add('hidden');
  $('gameView').classList.add('hidden');
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

function makeCard(c, extra) {
  const d = document.createElement('div');
  d.className = 'card ' + ((c.suit === 'heart' || c.suit === 'diamond' || c.suit === 'joker') ? 'red' : 'black');
  if (c.suit === 'joker') d.classList.add('joker');
  if (c.points > 0) { d.classList.add('scoring'); d.dataset.pts = c.points; }
  if (extra) d.classList.add(extra);
  const r = document.createElement('div'); r.className = 'cRank';
  r.textContent = c.suit === 'joker' ? (String(c.rank).includes('big') ? '大' : '小') : String(c.rank);
  const s = document.createElement('div'); s.className = 'cSuit';
  s.textContent = c.suit === 'joker' ? '★' : (SUIT_SYM[c.suit] || '');
  d.appendChild(r); d.appendChild(s);
  return d;
}

function renderSeat(el, idx) {
  el.innerHTML = '';
  const s = game.seats && game.seats[idx];
  const actorSeat = game.phase === 'reveal' ? game.revealActor : game.currentSeat;
  const n = s ? (game.handCounts[idx] ?? 0) : 0;
  const name = document.createElement('div');
  name.className = 'seatName' + (idx === actorSeat ? ' current' : '');
  name.textContent = s ? s.nickname : '空位';
  el.appendChild(name);
  const info = document.createElement('div');
  info.className = 'seatInfo';
  const parts = [n + ' 张'];
  if (game.dealerIndex === idx) parts.push('庄家');
  if (s && idx % 2 === game.me % 2) parts.push('队友');
  if (s && !s.connected) parts.push('离线');
  if (game.revealBy && game.revealBy[idx]) parts.push('已亮' + (game.revealBy[idx] === 'wu' ? '五反' : '三反'));
  else if (game.effectiveReveal && game.effectiveReveal.seat === idx) parts.push('已亮' + (game.effectiveReveal.level === 'wu' ? '五反' : '三反'));
  info.textContent = parts.join(' · ');
  el.appendChild(info);
  const backs = document.createElement('div');
  backs.className = 'backs';
  const show = Math.min(n, 8);
  for (let i = 0; i < show; i++) {
    const b = document.createElement('div');
    b.className = 'card back';
    backs.appendChild(b);
  }
  if (n > show) {
    const more = document.createElement('span');
    more.className = 'more';
    more.textContent = '+' + (n - show);
    backs.appendChild(more);
  }
  el.appendChild(backs);
  if (idx === actorSeat) {
    const badge = document.createElement('div');
    badge.className = 'turnBadge';
    badge.textContent = game.phase === 'reveal' ? '亮牌中' : (game.phase === 'bury' ? '埋底中' : (game.phase === 'tribute' ? '退贡中' : '出牌中'));
    el.appendChild(badge);
  }
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
  const me = game.me;
  if (game.scores && game.scores.length === 2 && game.dealerIndex != null) {
    const dTeam = game.dealerIndex % 2;
    $('gScore').textContent = '我队 ' + game.scores[dTeam] + ' : ' + game.scores[1 - dTeam] + ' 对方';
  } else $('gScore').textContent = '';
  const is6 = (game.handCounts || []).length === 6;
  $('gameView').classList.toggle('mode6', is6);
  if (is6) {
    renderSeat($('seatTopL'), (me + 4) % 6);
    renderSeat($('seatTop'), (me + 3) % 6);
    renderSeat($('seatTopR'), (me + 2) % 6);
    renderSeat($('seatLeft'), (me + 5) % 6);
    renderSeat($('seatRight'), (me + 1) % 6);
    $('seatTopL').classList.remove('hidden');
    $('seatTopR').classList.remove('hidden');
  } else {
    renderSeat($('seatTop'), (me + 2) % 4);
    renderSeat($('seatLeft'), (me + 1) % 4);
    renderSeat($('seatRight'), (me + 3) % 4);
    $('seatTopL').classList.add('hidden');
    $('seatTopR').classList.add('hidden');
  }
  const trickCards = $('trickCards');
  const trickResult = $('trickResult');
  const bottomBar = $('bottomBar');
  trickCards.innerHTML = '';
  trickResult.textContent = '';
  trickResult.classList.remove('flash');
  bottomBar.innerHTML = '';
  const infoParts = [];
  if (game.lastGive) {
    const who = seats[game.lastGive.to] ? seats[game.lastGive.to].nickname : '?';
    infoParts.push(who + ' 进贡 ' + cardLabel(game.lastGive.card));
  }
  if (game.phase === 'reveal') infoParts.push('亮牌阶段：三张3=三反 / 三张5=五反，闲家亮出可造反');
  if (game.rebellionLevel > 0) infoParts.push('造反 ' + game.rebellionLevel + ' 人，本副免进贡');
  if (game.phase === 'trick' && game.trick) {
    const dim = game.trick.dimension ? (DIM_LABEL[game.trick.dimension] || game.trick.dimension) : '';
    if (game.trick.leaderSeat != null && seats[game.trick.leaderSeat]) infoParts.push(seats[game.trick.leaderSeat].nickname + ' 领出' + (dim ? '（' + dim + '）' : ''));
    (game.trick.plays || []).forEach((pl) => {
      const wrap = document.createElement('div');
      wrap.className = 'play';
      const who = seats[pl.seat] ? seats[pl.seat].nickname : ('玩家' + (pl.seat + 1));
      const label = document.createElement('div');
      label.className = 'playSeat';
      label.textContent = who;
      const cards = document.createElement('div');
      cards.className = 'playCards';
      (pl.cards || []).forEach((c) => cards.appendChild(makeCard(c)));
      wrap.appendChild(label);
      wrap.appendChild(cards);
      trickCards.appendChild(wrap);
    });
    if (game.trick.winnerSeat != null) {
      const who = seats[game.trick.winnerSeat] ? seats[game.trick.winnerSeat].nickname : '?';
      trickResult.textContent = who + ' 赢墩' + (game.trick.pointsWon ? '，得 ' + game.trick.pointsWon + ' 分' : '');
      trickResult.classList.add('flash');
    }
  }
  if (game.bottom && game.bottom.length) {
    const lab = document.createElement('div');
    lab.className = 'bottomLabel';
    lab.textContent = '底牌（公开）';
    const row = document.createElement('div');
    row.className = 'bottomCards';
    game.bottom.forEach((c) => row.appendChild(makeCard(c)));
    bottomBar.appendChild(lab);
    bottomBar.appendChild(row);
  }
  $('trickInfo').textContent = infoParts.join(' | ');
  const p = game.phase;
  const myTurnTake = p === 'tribute' && game.tributeState && game.tributeState.step === 'take' && game.currentSeat === me;
  const myTurnBury = p === 'bury' && game.currentSeat === me;
  const myTurnPlay = p === 'trick' && game.currentSeat === me;
  const interactive = myTurnTake || myTurnBury || myTurnPlay;
  const maxSel = myTurnBury ? 6 : (myTurnPlay ? ((game.playHints && game.playHints.count) ? game.playHints.count : 12) : 1);
  const key = p + ':' + game.currentSeat + ':' + (game.tributeState ? game.tributeState.step + '/' + game.tributeState.pairIdx : '-') + ':' + (game.trick ? game.trick.plays.length : '-');
  if (key !== handKey) { handSel = []; handKey = key; }
  $('handTitle').textContent = (seats[me] ? seats[me].nickname : '我') + ' 的手牌（' + (game.myHand || []).length + ' 张）' + (interactive ? ' · 轮到你了' : '');
  const takeSet = new Set(game.takeOptions || []);
  const allowedSet = new Set((game.playHints && game.playHints.allowed) || []);
  const kongIds = new Set((game.kongPlays || []).flatMap((k) => k.cardIds || []));
  const handEl = $('handCards');
  handEl.innerHTML = '';
  (game.myHand || []).slice().sort((x, y) => y.power - x.power).forEach((c) => {
    const d = makeCard(c);
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
  const btns = $('buttons');
  btns.innerHTML = '';
  $('hint').textContent = game.message || '';
  if (game.phase === 'reveal' && game.revealActor === me) {
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
    const seenKong = new Set();
    (game.kongPlays || []).forEach((k) => {
      if (seenKong.has(k.label)) return; // 8 张同点拆两副：同款只出一个建议按钮
      seenKong.add(k.label);
      const b = document.createElement('button');
      b.textContent = '🔥 ' + k.label;
      b.className = 'suggest';
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
    if (game.result) {
      const r = game.result;
      const dTeam = game.dealerIndex % 2;
      trickResult.textContent = '庄家方 ' + r.scores[dTeam] + ' : ' + r.scores[1 - dTeam] + ' 闲家方' + (r.dealerStay ? ' · 守庄' : ' · 换庄') + (r.tribute !== 'none' ? ' · 进贡:' + r.tribute : '');
    }
  }
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
      if (seat.seatId === swapSel) div.classList.add('sel');
      if (room.mode === 'p6' && room.phase === 'waiting' && seat.seatId !== room.hostSeatId) {
        div.classList.add('swappable');
        div.addEventListener('click', () => {
          if (swapSel == null) { swapSel = seat.seatId; renderRoom(); }
          else if (swapSel === seat.seatId) { swapSel = null; renderRoom(); }
          else { send({ type: 'swap_seats', data: { a: swapSel, b: seat.seatId } }); swapSel = null; }
        });
      }
    }
    seatsEl.appendChild(div);
  });
  const need = room.mode === 'p6' ? 6 : 4;
  const meSeat = room.seats.find((s) => s && s.userId === myName);
  const allReady = room.seats.length === need && room.seats.every((s) => s && s.ready && s.connected);
  $('readyBtn').textContent = (meSeat && meSeat.ready) ? '取消准备' : '准备';
  $('startGameBtn').classList.toggle('hidden', !(room.hostSeatId != null && room.seats[room.hostSeatId] && room.seats[room.hostSeatId].userId === myName));
  $('startGameBtn').disabled = !allReady;
  $('swapBtn').classList.toggle('hidden', room.mode === 'p6');
  $('roomMode').textContent = room.mode === 'p6' ? '6 人模式' : '4 人模式';
  $('roomTip').textContent = allReady
    ? need + ' 人在线且已准备，房主可开始游戏'
    : `等待玩家就绪（在线已准备 ${room.seats.filter((s) => s && s.ready && s.connected).length}/${need}）` + (room.mode === 'p6' ? ' · 点击座位互换（房主固定）' : '');
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
      showMode();
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
  } else if (msg.type === 'left_room') {
    room = null;
    game = null;
    showHall();
  } else if (msg.type === 'kicked') {
    token = null;
    localStorage.removeItem(TOKEN_KEY);
    myName = null;
    if (ws) ws.close();
    showLogin('该账号已在别处登录，你已被顶下线');
  } else if (msg.type === 'error') {
    if (d.code === 'AUTH_FAIL' && token) {
      token = null;
      localStorage.removeItem(TOKEN_KEY);
      myName = null;
      if (ws) { try { ws.close(); } catch {} }
      showLogin('登录已失效（服务器可能重启过），请重新登录');
    } else {
      $('connMsg').textContent = d.message || '出错';
    }
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
$('mode4Btn').addEventListener('click', () => { mode = 'p4'; showHall(); });
$('mode6Btn').addEventListener('click', () => { mode = 'p6'; showHall(); });
$('modeSwitchBtn').addEventListener('click', () => showMode());
$('logoutBtn').addEventListener('click', () => {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  myName = null;
  if (ws) ws.close();
  showLogin();
});
$('createRoomBtn').addEventListener('click', () => send({ type: 'create_room', data: { mode } }));
$('joinRoomBtn').addEventListener('click', () => $('joinPanel').classList.remove('hidden'));
$('joinCancelBtn').addEventListener('click', () => $('joinPanel').classList.add('hidden'));
$('joinConfirmBtn').addEventListener('click', () => {
  const id = $('joinRoomInput').value.trim();
  const pat = mode === 'p6' ? /^\d{6}$/ : /^\d{4}$/;
  if (!pat.test(id)) { $('connMsg').textContent = mode === 'p6' ? '请输入 6 位房间号' : '请输入 4 位房间号'; return; }
  $('joinPanel').classList.add('hidden');
  send({ type: 'join_room', data: { roomId: id } });
});
$('readyBtn').addEventListener('click', () => send({ type: 'ready' }));
$('leaveRoomBtn').addEventListener('click', () => send({ type: 'leave_room' }));
$('startGameBtn').addEventListener('click', () => send({ type: 'start_game' }));
$('gResetBtn').addEventListener('click', () => location.reload());
$('gLeaveBtn').addEventListener('click', () => send({ type: 'leave_room' }));
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
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
let dealAnimRound = 0; // 发牌动画标记（每副首帧触发）
let winHoldUntil = 0;   // 赢墩展示停顿截止时间
let winHoldSeq = 0;     // 已展示的赢墩 seq
let pendingState = null; // 停顿期间暂存的最新状态
let winShown = false;    // 本墩赢牌是否已展示（避免重绘重复显示旧牌）

const SUIT_SYM = { spade: '♠', heart: '♥', club: '♣', diamond: '♦', joker: '★' };
const SEAT_EMOJI = ['🦊', '🐯', '🐼', '🦁', '🐸', '🐨'];
const SUB_SUIT_ORDER = { diamond: 0, club: 1, spade: 2 }; // 副牌分组顺序：方块→梅花→黑桃
const PHASE_LABEL = { reveal: '亮牌', tribute: '进贡/退贡', bury: '埋底', trick: '打牌', round_end: '结算', waiting: '房间' };

function send(obj) {
  if (!ws || ws.readyState !== 1) return;
  if (obj.type !== 'auth') clearWinHold(); // 用户主动操作：立即结束赢墩停顿，防止看到旧牌
  ws.send(JSON.stringify(obj));
}
// 解除赢墩停顿并应用最新状态
function clearWinHold() {
  if (winHoldUntil > 0 || pendingState) {
    winHoldUntil = 0;
    if (pendingState) {
      const p = pendingState;
      pendingState = null;
      handle({ type: 'game_state', data: p });
    }
  }
}
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
  clearWinHold(); // 点牌时若有停顿先解除，避免在旧牌面上选牌
  const i = handSel.indexOf(id);
  if (i >= 0) handSel.splice(i, 1);
  else {
    if (handSel.length >= maxSel) { notice('最多选 ' + maxSel + ' 张'); return; }
    handSel.push(id);
  }
  renderGame();
}

function cardSvg(c) {
  const rank = c.suit === 'joker' ? (String(c.rank).includes('big') ? '大' : '小') : String(c.rank);
  const suit = c.suit === 'joker' ? '★' : (SUIT_SYM[c.suit] || '');
  const color = (c.suit === 'heart' || c.suit === 'diamond' || c.suit === 'joker') ? '#c62828' : '#1a1a1a';
  const center = c.suit === 'joker'
    ? '<text x="50" y="94" font-size="48" fill="#6a1b9a" text-anchor="middle">★</text>'
    : '<text x="50" y="94" font-size="56" fill="' + color + '" text-anchor="middle">' + suit + '</text>';
  return '<svg viewBox="0 0 100 150" preserveAspectRatio="xMidYMid meet">'
    + '<rect x="2" y="2" width="96" height="146" rx="10" fill="#ffffff" stroke="#d8d8d8" stroke-width="1.5"/>'
    + '<text x="13" y="27" font-size="23" font-weight="800" fill="' + color + '">' + rank + '</text>'
    + '<text x="17" y="43" font-size="15" fill="' + color + '">' + suit + '</text>'
    + '<text x="87" y="134" font-size="23" font-weight="800" fill="' + color + '" text-anchor="end" transform="rotate(180 87 129)">' + rank + '</text>'
    + '<text x="83" y="118" font-size="15" fill="' + color + '" text-anchor="end" transform="rotate(180 83 113)">' + suit + '</text>'
    + center
    + '</svg>';
}
function makeCard(c, extra) {
  const d = document.createElement('div');
  d.className = 'card ' + ((c.suit === 'heart' || c.suit === 'diamond' || c.suit === 'joker') ? 'red' : 'black');
  if (c.suit === 'joker') d.classList.add('joker');
  if (c.points > 0) { d.classList.add('scoring'); d.dataset.pts = c.points; }
  if (extra) d.classList.add(extra);
  d.innerHTML = cardSvg(c);
  return d;
}

function renderSeat(el, idx) {
  el.innerHTML = '';
  el.classList.toggle('won', !!(game.trick && game.trick.winnerSeat === idx));
  const s = game.seats && game.seats[idx];
  const actorSeat = game.phase === 'reveal' ? game.revealActor : game.currentSeat;
  const n = s ? (game.handCounts[idx] ?? 0) : 0;
  const name = document.createElement('div');
  name.className = 'seatName' + (idx === actorSeat ? ' current' : '');
  name.textContent = s ? (SEAT_EMOJI[idx % SEAT_EMOJI.length] + ' ' + s.nickname) : '空位';
  el.appendChild(name);
  const info = document.createElement('div');
  info.className = 'seatInfo';
  const parts = [n + ' 张'];
  if (game.dealerIndex === idx) parts.push('庄家');
  if (s && idx % 2 === game.me % 2) parts.push('队友');
  if (s && !s.connected) parts.push('离线');
  if (game.phase === 'reveal' && game.revealDone && game.revealDone[idx] && !(game.revealCards && game.revealCards[idx])) parts.push('已过');
  info.textContent = parts.join(' · ');
  el.appendChild(info);
  const backs = document.createElement('div');
  backs.className = 'backs';
  // 亮出的牌直接显示真牌（不再用牌背/文字）
  const revealedById = new Map((game.revealed || []).map((r) => [r.id, r]));
  const seatRevealed = ((game.revealCards && game.revealCards[idx]) || [])
    .map((id) => revealedById.get(id)).filter(Boolean);
  seatRevealed.forEach((c) => backs.appendChild(makeCard(c, 'mini')));
  const hidden = n - seatRevealed.length;
  const show = Math.min(hidden, 8);
  for (let i = 0; i < show; i++) {
    const b = document.createElement('div');
    b.className = 'card back';
    backs.appendChild(b);
  }
  if (hidden > show) {
    const more = document.createElement('span');
    more.className = 'more';
    more.textContent = '+' + (hidden - show);
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

function winnerDir(g, winSeat) {
  const me = g.me;
  const is6 = (g.handCounts || []).length === 6;
  const map = is6
    ? { [(me + 4) % 6]: [-85, -55], [(me + 3) % 6]: [0, -70], [(me + 2) % 6]: [85, -55], [(me + 5) % 6]: [-110, 0], [(me + 1) % 6]: [110, 0], [me]: [0, 120] }
    : { [(me + 2) % 4]: [0, -70], [(me + 1) % 4]: [-110, 0], [(me + 3) % 4]: [110, 0], [me]: [0, 120] };
  return map[winSeat] || [0, -70];
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
  trickCards.classList.remove('winning');
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
    const winFrame = !!(game.trick.winnerSeat != null);
    if (!winFrame) winShown = false;
    if (winFrame) {
      const who = seats[game.trick.winnerSeat] ? seats[game.trick.winnerSeat].nickname : '?';
      trickResult.textContent = who + ' 赢墩' + (game.trick.pointsWon ? '，得 ' + game.trick.pointsWon + ' 分' : '');
      trickResult.classList.add('flash');
    }
    // 赢墩牌面只展示一次；之后重绘（如点击选牌）不再重复显示上一轮牌
    if (!(winFrame && winShown)) {
      (game.trick.plays || []).forEach((pl, pi) => {
        const wrap = document.createElement('div');
        wrap.className = 'play' + (pi === (game.trick.plays || []).length - 1 ? ' fresh' : '');
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
        const [wx, wy] = winnerDir(game, game.trick.winnerSeat);
        trickCards.classList.add('winning');
        trickCards.style.setProperty('--win-x', wx + 'px');
        trickCards.style.setProperty('--win-y', wy + 'px');
      }
    }
    if (winFrame) winShown = true;
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
  const dealing = game.phase === 'reveal' && game.roundNo !== dealAnimRound;
  if (dealing) dealAnimRound = game.roundNo;
  handEl.classList.toggle('dealing', dealing);
  const revealedMain = new Set((game.revealed || []).map((r) => r.id));
  const isMainC = (c) => c.suit === 'heart' || c.suit === 'joker' || (c.suit === 'diamond' && c.rank === '5') || (c.suit === 'spade' && c.rank === 'Q') || c.rank === 'J' || c.rank === '2' || revealedMain.has(c.id);
  // 排序：主牌（牌力从大到小）→ 副牌按 方块/梅花/黑桃 分组（组内牌力从大到小）
  (game.myHand || []).slice().sort((x, y) => {
    const rx = revealedMain.has(x.id);
    const ry = revealedMain.has(y.id);
    if (rx !== ry) return rx ? -1 : 1; // 亮出的牌排最前
    const ax = isMainC(x) ? [1, -x.power] : [2, SUB_SUIT_ORDER[x.suit] ?? 9, -x.power];
    const ay = isMainC(y) ? [1, -y.power] : [2, SUB_SUIT_ORDER[y.suit] ?? 9, -y.power];
    return (ax[0] - ay[0]) || (ax[1] - ay[1]) || ((ax[2] || 0) - (ay[2] || 0));
  }).forEach((c, ci) => {
    const d = makeCard(c);
    if (dealing) d.style.animationDelay = (ci * 25) + 'ms';
    if (revealedMain.has(c.id)) d.classList.add('revealed');
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
  if (game.phase === 'reveal' && !(game.revealDone && game.revealDone[me])) {
    (game.revealOptions || []).forEach((o) => {
      const b = document.createElement('button');
      b.textContent = '✨ ' + (o.level === 'wu' ? '亮五反' : '亮三反');
      b.className = 'suggest';
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
    if (!game.effectiveReveal) {
      const canReveal = !!(game.revealOptions && game.revealOptions.length);
      const rb = document.createElement('button');
      rb.textContent = canReveal ? '✨ 亮牌（三五反）' : '亮牌（无可亮 3/5）';
      rb.disabled = !canReveal;
      if (canReveal) rb.className = 'suggest';
      rb.addEventListener('click', () => {
        const o = game.revealOptions && game.revealOptions[0];
        if (o) send({ type: 'reveal', data: { cardIds: o.cardIds } });
      });
      btns.appendChild(rb);
    }
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
      nb.textContent = '垫出 ' + (hints.allowed || []).length + ' 张（优先高分）';
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
    if (Date.now() < winHoldUntil) { pendingState = d; return; } // 赢墩停顿期间暂存
    gameSeq = d.seq != null ? d.seq : gameSeq;
    game = d;
    renderGame();
    // 本墩刚决出胜负：停顿 2 秒展示赢家 + 飞牌动画
    if (d.trick && d.trick.winnerSeat != null && d.seq !== winHoldSeq) {
      winHoldSeq = d.seq;
      winHoldUntil = Date.now() + 5000;
      setTimeout(() => {
        winHoldUntil = 0;
        if (pendingState) { const p = pendingState; pendingState = null; handle({ type: 'game_state', data: p }); }
      }, 5200);
    }
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
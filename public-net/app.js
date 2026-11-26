import {
  autoFourClearPlay,
  cardLabel,
  dimensionLabel,
  handLayout,
  hasAutoBurySnapshot,
  isConstCard,
  isGamePaused,
  isHandCardClickable,
  isHandCardDimmed,
  isPointCard,
  isTrumpCard,
  matchLegalPlay,
  playErrorToastText,
  recommendedPlay,
  sameIdSet,
  seatTeamLabel,
  sortHandForDisplay,
  SUIT_SYMBOLS,
  TOAST_MS,
} from './ui-logic.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'hx_token';
const THEME_KEY = 'hx_theme';
const MOTION_KEY = 'hx_reduce_motion';
const PHASE_LABEL = { reveal: '亮牌', tribute: '进贡', bury: '埋底', trick: '打牌', round_end: '结算', idle: '准备' };
const TRIBUTE_LABEL = { none: '无进贡', single: '单进贡', double: '双进贡' };
const WAITING_PHASE = new Set(['reveal', 'tribute', 'bury', 'trick']);

const state = {
  ws: null,
  token: localStorage.getItem(TOKEN_KEY) || '',
  user: null,
  room: null,
  game: null,
  gameSeq: 0,
  screen: 'login',
  selected: new Set(),
  recommended: new Set(),
  handKey: '',
  online: [],
  pendingAuth: null,
  manualClose: false,
  reconnectAttempted: false,
  awaiting: false,
  lastGame: null,
  lastDealRound: null,
  dealAnimationRound: null,
  lastAutoBuryKey: '',
  lastRevealKey: '',
  lastGiveKey: '',
  trickRects: null,
  toastTimer: null,
  resizeTimer: null,
  skipAnimationOnce: false,
  submittedRects: null,
};

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(min, value, max) { return Math.min(max, Math.max(min, value)); }
function motionMs(ms) { return motionQuery.matches || document.documentElement.classList.contains('reduce-motion') ? 1 : ms; }
function avatarText(name) {
  const value = String(name || '我').trim();
  if (!value) return '我';
  return /^[A-Za-z]/.test(value) ? value[0].toUpperCase() : value.slice(-1);
}
function avatarClass(seatIdx) {
  return ['avatar-blue', 'avatar-purple', 'avatar-green', 'avatar-orange'][seatIdx % 4] || 'avatar-gray';
}
function seatName(seat) { return seat?.nickname || seat?.userId || '玩家'; }
function seatAt(index) { return state.game?.seats?.[index] || null; }
function nickAt(index) { return seatName(seatAt(index)); }
function dealerTeam(game) { return number(game?.dealerIndex) % 2; }
function idleScore(game) { return number(game?.scores?.[1 - dealerTeam(game)]); }
function dealerScore(game) { return number(game?.scores?.[dealerTeam(game)]); }
function tierText(score) {
  if (score < 40) return '庄家守庄';
  if (score < 60) return '换庄';
  if (score < 80) return '换庄 · 单进贡';
  return '换庄 · 双进贡';
}
function currentActor(game) {
  if (!game) return -1;
  return game.phase === 'reveal' ? game.revealActor : game.currentSeat;
}
function isMyTurn(game) { return !!game && currentActor(game) === game.me; }
function isTakeTurn(game) { return game?.phase === 'tribute' && game.tributeState?.step === 'take' && game.currentSeat === game.me; }
function isBuryTurn(game) { return game?.phase === 'bury' && game.currentSeat === game.me; }
function isPlayTurn(game) { return game?.phase === 'trick' && game.currentSeat === game.me; }
function autoSelectionFor(game) {
  if (!isPlayTurn(game)) return null;
  return autoFourClearPlay({ trick: game.trick, playHints: game.playHints, legalPlays: game.legalPlays || [] });
}
function syncAutoSelection(game) {
  const auto = autoSelectionFor(game);
  if (!auto) return null;
  const ids = auto.cardIds.map(String);
  if (!sameIdSet([...state.selected], ids)) state.selected = new Set(ids);
  state.recommended.clear();
  return auto;
}

function setScreen(name) {
  state.screen = name;
  document.body.dataset.screen = name;
  if ((name === 'game' || name === 'settle') && state.game?.phase) document.body.dataset.phase = state.game.phase;
  else document.body.removeAttribute('data-phase');
}

function showToast(message, tone = '') {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = 'toast' + (tone ? ' ' + tone : '');
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { toast.hidden = true; }, TOAST_MS);
}

function showLoginError(message = '') {
  const box = $('login-error');
  box.textContent = message;
  box.hidden = !message;
}

function setLoginBusy(busy) {
  const button = $('login-submit');
  button.disabled = busy;
  button.textContent = busy ? '正在进入…' : '进入牌局';
}

function showLogin(message = '') {
  setScreen('login');
  setLoginBusy(false);
  showLoginError(message);
  closeMenu();
  hidePause();
  updateMenu();
}

function showLobby() {
  state.room = null;
  resetGameState();
  setScreen('lobby');
  renderLobby();
  hidePause();
  updateMenu();
}

function resetGameState() {
  state.game = null;
  state.gameSeq = 0;
  state.selected.clear();
  state.recommended.clear();
  state.handKey = '';
  state.awaiting = false;
  state.lastGame = null;
  state.lastDealRound = null;
  state.dealAnimationRound = null;
  state.lastAutoBuryKey = '';
  state.lastRevealKey = '';
  state.lastGiveKey = '';
  state.trickRects = null;
  state.submittedRects = null;
}

function showRoom() {
  if (!state.room) { showLobby(); return; }
  setScreen('room');
  renderRoom();
  hidePause();
  updateMenu();
}

function showGame() {
  setScreen('game');
  hidePause();
  updateMenu();
}

function showSettle() {
  setScreen('settle');
  hidePause();
  updateMenu();
}

function updateMenu() {
  const name = state.user?.nickname || state.user?.username || '玩家';
  $('menu-name').textContent = name;
  $('menu-avatar').textContent = avatarText(name);
  $('menu-avatar').className = 'avatar avatar-blue';
  $('menu-room').textContent = state.room ? '房间 ' + state.room.roomId : '未入房';
  $('btn-menu-leave').hidden = !state.room;
  document.querySelectorAll('[data-theme-choice]').forEach((button) => {
    button.classList.toggle('active', button.dataset.themeChoice === document.documentElement.dataset.theme);
  });
  $('toggle-motion').checked = motionQuery.matches || document.documentElement.classList.contains('reduce-motion');
}

function openMenu() {
  updateMenu();
  $('menu-overlay').hidden = false;
  setTimeout(() => $('btn-menu-close').focus(), 30);
}
function closeMenu() { $('menu-overlay').hidden = true; }

function showPause(title = '连接中断', copy = '本副已暂停，恢复连接后会继续。', canReconnect = true) {
  $('pause-title').textContent = title;
  $('pause-copy').textContent = copy;
  $('btn-reconnect').hidden = !canReconnect;
  $('pause-overlay').hidden = false;
}
function hidePause() { $('pause-overlay').hidden = true; }

function applyTheme(theme) {
  const selected = theme === 'midnight' ? 'midnight' : 'green';
  document.documentElement.dataset.theme = selected;
  document.body.dataset.theme = selected;
  localStorage.setItem(THEME_KEY, selected);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = selected === 'midnight' ? '#0b1026' : '#07130e';
  updateMenu();
}

function applyMotionPreference(manualReduced) {
  document.documentElement.classList.toggle('reduce-motion', !!manualReduced);
  localStorage.setItem(MOTION_KEY, manualReduced ? '1' : '0');
  updateMenu();
}

function send(message) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(message));
    return true;
  }
  showToast('连接尚未恢复', 'error');
  return false;
}

function connect(auth, { reconnect = false } = {}) {
  if (state.ws) {
    try { state.ws.close(); } catch { /* ignore */ }
  }
  state.manualClose = false;
  state.pendingAuth = auth;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try {
    ws = new WebSocket(`${protocol}://${location.host}/ws`);
  } catch {
    setLoginBusy(false);
    showLoginError('无法连接服务器');
    return;
  }
  state.ws = ws;
  let opened = false;
  ws.addEventListener('open', () => {
    opened = true;
    ws.send(JSON.stringify({ type: 'auth', data: auth }));
  });
  ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    handleMessage(message);
  });
  ws.addEventListener('error', () => {
    if (!opened && state.screen === 'login') {
      setLoginBusy(false);
      showLoginError('无法连接服务器，请稍后再试');
    }
  });
  ws.addEventListener('close', () => {
    if (state.ws !== ws) return;
    state.ws = null;
    if (state.manualClose) return;
    if (state.token && state.screen === 'login' && !state.user) {
      state.token = '';
      localStorage.removeItem(TOKEN_KEY);
      setLoginBusy(false);
      showLoginError('无法恢复登录，请重新登录');
    } else if (state.token) {
      showPause(reconnect ? '连接仍未恢复' : '连接中断', '本副已暂停，恢复连接后会继续。', true);
      if (!state.reconnectAttempted) {
        state.reconnectAttempted = true;
        setTimeout(() => {
          if (state.token && !state.ws) connect({ token: state.token }, { reconnect: true });
        }, 1200);
      }
    } else if (state.screen === 'login') {
      setLoginBusy(false);
      showLoginError('连接已断开，请重新登录');
    } else {
      showPause('连接中断', '本副已暂停，请重新登录后继续。', false);
    }
  });
}

function beginLogin(username, password) {
  state.token = '';
  localStorage.removeItem(TOKEN_KEY);
  state.reconnectAttempted = false;
  setLoginBusy(true);
  showLoginError('');
  connect({ username, password });
}

function handleAuthFailure(message) {
  const failedToken = !!state.pendingAuth?.token;
  state.token = '';
  localStorage.removeItem(TOKEN_KEY);
  state.user = null;
  state.room = null;
  resetGameState();
  state.manualClose = true;
  if (state.ws) {
    try { state.ws.close(); } catch { /* ignore */ }
  }
  state.ws = null;
  state.pendingAuth = null;
  showLogin(failedToken ? '登录已失效，请重新登录' : (message || '账号或密码错误'));
}

function handleMessage(message) {
  const data = message?.data || {};
  switch (message?.type) {
    case 'auth_ok': {
      const resumingSession = !!state.pendingAuth?.token;
      state.token = data.token || state.token;
      state.user = data.user || state.user;
      state.pendingAuth = null;
      state.reconnectAttempted = false;
      state.skipAnimationOnce = resumingSession;
      if (state.token) localStorage.setItem(TOKEN_KEY, state.token);
      setLoginBusy(false);
      showLoginError('');
      $('lobby-name').textContent = state.user?.nickname || state.user?.username || '玩家';
      $('lobby-avatar').textContent = avatarText($('lobby-name').textContent);
      hidePause();
      updateMenu();
      if (!state.room && !state.game) showLobby();
      else if (state.room && !state.game) renderRoom();
      return;
    }
    case 'presence':
      state.online = Array.isArray(data.online) ? data.online.slice() : [];
      $('lobby-online').textContent = state.online.length ? state.online.length + ' 人在线' : '在线';
      return;
    case 'room_updated': {
      const previousRoom = state.room;
      state.room = data;
      if (data.phase !== 'playing') state.skipAnimationOnce = false;
      const mine = (data.seats || []).find((seat) => seat && seat.userId === state.user?.username);
      if (!mine) {
        state.room = null;
        if (!state.game) showLobby();
        return;
      }
      if (!state.game || state.screen === 'room' || (previousRoom && previousRoom.phase === 'waiting')) {
        if (!state.game) showRoom();
        else if (state.screen === 'room') renderRoom();
      }
      if (state.screen === 'game' && state.game) renderGame(state.game);
      return;
    }
    case 'game_state':
      receiveGameState(data);
      return;
    case 'room_dissolved':
      state.room = null;
      resetGameState();
      showLobby();
      showToast('房间已解散');
      return;
    case 'kicked':
      state.token = '';
      localStorage.removeItem(TOKEN_KEY);
      state.user = null;
      state.room = null;
      resetGameState();
      state.manualClose = true;
      if (state.ws) {
        try { state.ws.close(); } catch { /* ignore */ }
      }
      state.ws = null;
      showLogin('该账号已在别处登录，你已被顶下线');
      return;
    case 'error': {
      state.awaiting = false;
      const code = data.code || '';
      const text = data.message || '操作未完成';
      if (code === 'AUTH_FAIL') { handleAuthFailure('账号或密码错误'); return; }
      if (code === 'AUTH_REQUIRED') {
        state.token = '';
        localStorage.removeItem(TOKEN_KEY);
        showLogin('登录已失效，请重新登录');
        return;
      }
      const buryNoPoints = String(data.message || '').toUpperCase().includes('BURY_NO_POINTS');
      showToast((code === 'BAD_PLAY' || code === 'BAD_BURY' || buryNoPoints) ? playErrorToastText({ code, message: data.message }) : text, 'error');
      if (state.screen === 'game' && state.game) renderGame(state.game);
      else if (state.screen === 'settle' && state.game) renderSettle(state.game);
      return;
    }
    default:
      return;
  }
}

function receiveGameState(game) {
  if (!game) return;
  if (game.seq != null && state.gameSeq && game.seq <= state.gameSeq) return;
  const previous = state.game;
  const skipAnimation = state.skipAnimationOnce;
  state.skipAnimationOnce = false;
  state.game = game;
  state.gameSeq = game.seq != null ? game.seq : state.gameSeq;
  state.lastGame = previous;
  state.awaiting = false;
  if (skipAnimation) {
    state.dealAnimationRound = game.roundNo;
    state.lastDealRound = game.roundNo;
  }

  const nextKey = handSelectionKey(game);
  if (nextKey !== state.handKey) {
    state.selected.clear();
    state.recommended.clear();
    state.handKey = nextKey;
  }
  const handIds = new Set((game.myHand || []).map((card) => card.id));
  for (const id of [...state.selected]) if (!handIds.has(id)) state.selected.delete(id);
  for (const id of [...state.recommended]) if (!handIds.has(id)) state.recommended.delete(id);

  if (game.phase === 'round_end') {
    showSettle();
    renderSettle(game);
  } else {
    showGame();
    renderGame(skipAnimation ? null : previous, game);
  }
}

function handSelectionKey(game) {
  return [game.roundNo, game.phase, game.currentSeat, game.revealActor, game.tributeState?.step, game.tributeState?.pairIdx, game.trick?.plays?.length, game.trick?.dimension].join(':');
}

function renderLobby() {
  setScreen('lobby');
  const name = state.user?.nickname || state.user?.username || '玩家';
  $('lobby-name').textContent = name;
  $('lobby-avatar').textContent = avatarText(name);
  $('lobby-online').textContent = state.online.length ? state.online.length + ' 人在线' : '在线';
  updateMenu();
}

function renderRoom() {
  if (!state.room) return;
  const room = state.room;
  $('room-code').textContent = room.roomId || '------';
  const seats = room.seats || [];
  const container = $('room-seats');
  container.innerHTML = '';
  for (let index = 0; index < 4; index += 1) {
    const seat = seats[index];
    const element = document.createElement('div');
    element.className = 'rseat s' + index;
    if (!seat) {
      element.innerHTML = `<span class="avatar avatar-gray">空</span><b>等待加入</b><small>${index + 1} 号位</small>`;
    } else {
      const mine = seat.userId === state.user?.username;
      element.classList.toggle('is-me', mine);
      element.classList.toggle('is-host', !!seat.isHost);
      element.classList.toggle('is-offline', !seat.connected);
      element.style.setProperty('--rseat-color', index === 0 || index === 2 ? 'var(--crimson-300)' : 'var(--team-dealer)');
      const tags = [];
      if (seat.isHost) tags.push('<span class="seat-tag host">房主</span>');
      if (seat.ready) tags.push('<span class="seat-tag ready">已准备</span>');
      if (!seat.connected) tags.push('<span class="seat-tag offline">离线</span>');
      element.innerHTML = `
        <span class="avatar ${avatarClass(index)}">${esc(avatarText(seat.nickname || seat.userId))}</span>
        <b>${esc(seat.nickname || seat.userId)}</b>
        <small>${index + 1} 号位${mine ? ' · 我' : ''}</small>
        <span class="seat-tags">${tags.join('')}</span>`;
    }
    container.appendChild(element);
  }

  const occupied = seats.filter(Boolean).length;
  const readyOnline = seats.filter((seat) => seat && seat.ready && seat.connected).length;
  const allReady = occupied === 4 && readyOnline === 4;
  const missingReady = seats.filter((seat) => seat && !seat.ready).map((seat) => seat.nickname);
  if (occupied < 4) $('room-status').textContent = `等待玩家加入（${occupied}/4）`;
  else if (!allReady) $('room-status').textContent = `在线且已准备 ${readyOnline}/4${missingReady.length ? ' · 等待 ' + missingReady.join('、') : ''}`;
  else $('room-status').textContent = '四人在线，房主可以开局';

  const me = seats.find((seat) => seat && seat.userId === state.user?.username);
  $('btn-ready').textContent = me?.ready ? '取消准备' : '准备';
  $('btn-ready').disabled = !me;
  const isHost = Number(room.hostSeatId) >= 0 && seats[room.hostSeatId]?.userId === state.user?.username;
  $('btn-start-game').disabled = !isHost || !allReady;
  $('btn-start-game').textContent = isHost ? '开始游戏' : '等待房主开始';
  $('btn-swap-seats').disabled = room.phase !== 'waiting';
  setScreen('room');
  updateMenu();
}

function renderGame(previous, game = state.game) {
  if (!game) return;
  showGame();
  setScreen('game');
  syncAutoSelection(game);
  const phase = PHASE_LABEL[game.phase] || '牌桌';
  $('game-round').textContent = `第 ${number(game.roundNo, 1)} 副 · ${phase}`;
  $('game-subtitle').textContent = `四人一副 · 主 ♥${game.trick?.dimension ? ' · ' + dimensionLabel(game.trick.dimension) : ''}`;

  const dScore = dealerScore(game);
  const iScore = idleScore(game);
  $('dealer-score').textContent = dScore;
  $('idle-score').textContent = iScore;
  $('idle-progress').style.width = clamp(0, iScore, 100) + '%';
  $('tier-chip').textContent = tierText(iScore);

  renderGameSeats(game);
  renderTrick(game);
  renderHand(game);
  renderGameActions(game);
  renderBottom(game);
  announceAutoBury(game);
  renderTributeNote(game);
  renderReveal(game);
  renderTableNote(game);

  const status = gameStatus(game);
  $('game-message').textContent = status;
  $('game-message').classList.toggle('paused', /离线|重连/.test(status));
  $('selection-note').textContent = selectionSummary(game);
  if (/已离线|等待重连/.test(game.message || '')) showPause('本副暂停', game.message, false);
  else if (state.ws?.readyState === WebSocket.OPEN) hidePause();

  const canAnimate = !!previous && previous !== game;
  requestAnimationFrame(() => {
    if (canAnimate && !motionQuery.matches) runGameAnimations(previous, game);
    if (state.dealAnimationRound !== game.roundNo) animateDeal(game);
    state.trickRects = captureTrickRects();
  });
}

function renderGameSeats(game) {
  const me = number(game.me);
  const container = $('game-seats');
  container.innerHTML = '';
  const slots = [
    { index: (me + 2) % 4, position: 'top' },
    { index: (me + 1) % 4, position: 'left' },
    { index: (me + 3) % 4, position: 'right' },
    { index: me, position: 'me' },
  ];
  const actor = currentActor(game);
  for (const slot of slots) {
    const seat = game.seats?.[slot.index];
    const element = document.createElement('div');
    element.id = 'seat-' + slot.index;
    element.className = `gseat seat-${slot.position}`;
    element.dataset.seat = String(slot.index);
    if (!seat) {
      element.innerHTML = '<span class="avatar avatar-gray">空</span><span class="seat-copy"><b>空位</b><small>等待加入</small></span>';
      container.appendChild(element);
      continue;
    }
    element.classList.toggle('turn', actor === slot.index && WAITING_PHASE.has(game.phase));
    element.classList.toggle('offline', !seat.connected);
    element.style.setProperty('--seat-color', slot.index === game.dealerIndex ? 'var(--team-dealer)' : (slot.index % 2 === 0 ? 'var(--crimson-300)' : 'var(--team-idle)'));
    const isSelf = slot.index === me;
    const isDealer = slot.index === game.dealerIndex;
    const team = slot.index % 2 === me % 2 ? '队友' : '对手';
    const thinking = actor === slot.index && WAITING_PHASE.has(game.phase) ? (seat.connected ? '行动中' : '离线') : '';
    if (isSelf) element.dataset.self = '1';
    const seatTitle = isSelf ? '我' : seatName(seat);
    const seatMeta = isSelf
      ? seatTeamLabel(slot.index, game.dealerIndex)
      : `${team} · <span class="count">${number(game.handCounts?.[slot.index])}</span> 张${thinking ? ' · ' + thinking : ''}${seat.connected ? '' : ' · 离线'}`;
    element.innerHTML = `
      <span class="avatar ${avatarClass(slot.index)}">${esc(avatarText(seat.nickname || seat.userId))}${isDealer ? '<i class="dealer-tag">庄</i>' : ''}</span>
      <span class="bank-fan" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="seat-copy"><b>${esc(seatTitle)}</b><small>${seatMeta}</small></span>`;
    container.appendChild(element);
  }
}

function renderTrick(game) {
  const zone = $('trick-zone');
  zone.innerHTML = '';
  const me = number(game.me);
  const positions = { 0: 'me', 1: 'left', 2: 'top', 3: 'right' };
  for (let offset = 0; offset < 4; offset += 1) {
    const seatIdx = (me + offset) % 4;
    const position = positions[offset];
    const slot = document.createElement('div');
    slot.className = `trick-slot slot-${position}`;
    slot.dataset.slot = position;
    const play = game.trick?.plays?.find((item) => item.seat === seatIdx);
    if (!play) {
      slot.innerHTML = '<span class="trick-empty"></span>';
    } else {
      const wrapper = document.createElement('div');
      wrapper.className = 'trick-play' + (game.trick?.winnerSeat === seatIdx ? ' winner' : '');
      if (!play.cards || !play.cards.length) {
        wrapper.innerHTML = '<span class="trick-label">不出</span>';
      } else {
        for (const card of play.cards) wrapper.appendChild(miniCard(card, { revealedIds: revealedIds(game) }));
      }
      const label = document.createElement('span');
      label.className = 'trick-label';
      label.innerHTML = `<b>${esc(nickAt(seatIdx))}</b>${game.trick?.dimension && game.trick?.leaderSeat === seatIdx ? ' · ' + esc(dimensionLabel(game.trick.dimension)) : ''}`;
      slot.append(wrapper, label);
    }
    zone.appendChild(slot);
  }
}

function renderHand(game) {
  const handEl = $('my-hand');
  const previousRects = new Map();
  handEl.querySelectorAll('[data-card-id]').forEach((element) => {
    previousRects.set(element.dataset.cardId, element.getBoundingClientRect().toJSON());
  });
  handEl.innerHTML = '';
  const revealed = game.revealed || [];
  const revealedIdSet = revealedIds(game);
  const sorted = sortHandForDisplay(game.myHand || [], revealed);
  const width = Math.max(1, handEl.clientWidth || window.innerWidth - 20);
  const count = sorted.length;
  const portrait = window.innerWidth < 1000 && window.innerHeight >= window.innerWidth;
  const desktop = window.innerWidth >= 1000;
  const orientation = desktop ? 'desktop' : (portrait ? 'portrait' : 'landscape');

  let cardWidth;
  if (portrait) {
    if (count > 18) cardWidth = clamp(50, window.innerWidth * 0.14, 56);
    else if (count > 12) cardWidth = clamp(54, Math.min(window.innerWidth * 0.17, window.innerHeight * 0.08), 68);
    else cardWidth = clamp(56, Math.min(window.innerWidth * 0.185, window.innerHeight * 0.1), 84);
  } else if (desktop) {
    cardWidth = count > 18 ? clamp(60, window.innerHeight * 0.09, 82) : clamp(84, window.innerHeight * 0.115, 116);
  } else {
    cardWidth = count > 18 ? clamp(44, window.innerHeight * 0.1, 54) : clamp(52, window.innerHeight * 0.165, 66);
  }
  cardWidth = Math.round(cardWidth);
  const cardHeight = Math.round(cardWidth * 1.4);
  const layout = handLayout({ count, containerWidth: width, cardWidth, orientation });
  const rowGap = layout.rows > 1 ? Math.round(cardHeight * 0.72) : 0;
  const selectedLift = Math.round(cardWidth * 0.28);
  handEl.style.height = (cardHeight + Math.max(0, layout.rows - 1) * rowGap + selectedLift + 6) + 'px';
  handEl.style.setProperty('--cw', cardWidth + 'px');
  handEl.style.setProperty('--ch', cardHeight + 'px');
  const totalWidth = cardWidth + layout.step * Math.max(0, layout.perRow - 1);
  const startX = Math.max(0, (width - totalWidth) / 2);
  const newRound = state.lastDealRound !== game.roundNo;

  sorted.forEach((card, index) => {
    const row = layout.rows > 1 ? Math.floor(index / layout.perRow) : 0;
    const col = row === 0 ? index : index - row * layout.perRow;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'card';
    button.dataset.cardId = String(card.id);
    button.dataset.row = String(row);
    button.style.width = cardWidth + 'px';
    button.style.height = cardHeight + 'px';
    button.style.left = (startX + col * layout.step) + 'px';
    button.style.top = (row * rowGap) + 'px';
    button.style.setProperty('--cw', cardWidth + 'px');
    button.style.setProperty('--ch', cardHeight + 'px');
    button.style.zIndex = String(20 + row * 100 + col);
    const clickable = isHandCardClickable(card, game);
    const joker = card.suit === 'joker';
    const red = card.suit === 'heart' || card.suit === 'diamond' || (joker && card.rank === 'big');
    button.classList.add(red ? 'red' : 'black');
    if (isTrumpCard(card, revealedIdSet)) button.classList.add('is-trump');
    if (isConstCard(card)) button.classList.add('is-const');
    if (joker) button.classList.add('joker', card.rank === 'big' ? 'big' : 'small');
    if (number(card.points) > 0) button.classList.add('point');
    if (['J', 'Q', 'K'].includes(card.rank)) button.classList.add('high');
    if (clickable) button.classList.add('clickable');
    if (isHandCardDimmed(card, game)) button.classList.add('dim');
    if (state.selected.has(String(card.id))) button.classList.add('selected');
    if (state.recommended.has(String(card.id))) button.classList.add('recommended');
    if (newRound) button.classList.add('card-enter');
    button.style.animationDelay = `${Math.min(index * 18, 260)}ms`;
    button.setAttribute('aria-pressed', state.selected.has(String(card.id)) ? 'true' : 'false');
    button.setAttribute('aria-label', cardLabel(card) + (state.selected.has(String(card.id)) ? '，已选中' : ''));
    button.innerHTML = cardFaceHTML(card, revealedIdSet);
    if (state.recommended.has(String(card.id))) {
      const tag = document.createElement('span');
      tag.className = 'reco-tag';
      tag.textContent = '荐';
      button.appendChild(tag);
    }
    if (clickable) button.addEventListener('click', () => toggleCard(card));
    handEl.appendChild(button);
  });
  if (previousRects.size && !newRound && !motionQuery.matches && !document.documentElement.classList.contains('reduce-motion')) {
    requestAnimationFrame(() => {
      handEl.querySelectorAll('[data-card-id]').forEach((element) => {
        const before = previousRects.get(element.dataset.cardId);
        if (!before) return;
        const after = element.getBoundingClientRect();
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        element.animate([
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: 'translate(0, 0)' },
        ], { duration: motionMs(200), easing: 'cubic-bezier(.65,0,.35,1)' });
      });
    });
  }
  if (newRound) state.lastDealRound = game.roundNo;
}

function revealedIds(game) {
  return new Set((game?.revealed || []).map((item) => String(item.id)));
}

function badgeFor(card, revealedIdSet) {
  if (!card) return null;
  if (card.suit === 'joker') return { className: 'joker', text: '王牌' };
  if (card.suit === 'diamond' && card.rank === '5') return { className: 'const', text: '常主' };
  if (revealedIdSet.has(String(card.id))) return { className: 'fan', text: card.rank === '5' ? '五反' : '三反' };
  if (isConstCard(card)) return { className: 'const', text: '常主' };
  return null;
}

function cardFaceHTML(card, revealedIdSet) {
  const joker = card.suit === 'joker';
  const bigJoker = joker && card.rank === 'big';
  const red = card.suit === 'heart' || card.suit === 'diamond' || bigJoker;
  const classes = ['face'];
  const point = number(card.points);
  const badge = badgeFor(card, revealedIdSet);
  const high = ['J', 'Q', 'K'].includes(card.rank);
  const indexLabel = joker ? (bigJoker ? '大王' : '小王') : esc(card.rank || '');
  const suit = joker ? '★' : (SUIT_SYMBOLS[card.suit] || '');
  let center = '';
  if (joker) center = `<span class="joker-art">${bigJoker ? '♛' : '★'}<em>JOKER</em></span>`;
  else if (high) center = `<span class="court"><b>${esc(card.rank)}</b><i>${esc(suit)}</i></span>`;
  else center = `<span class="pip">${esc(suit)}</span>`;
  const pointTag = point > 0 ? `<span class="ptb">+${point}</span>` : '';
  const badgeTag = badge ? `<span class="rbadge ${badge.className}">${badge.text}</span>` : '';
  return `<div class="${classes.join(' ')}">
    <span class="idx"><b>${indexLabel}</b><i>${esc(suit)}</i></span>
    ${pointTag}${center}${badgeTag}
    <span class="idx br"><b>${indexLabel}</b><i>${esc(suit)}</i></span>
  </div>`;
}

function miniCard(card, { back = false, revealedIds: ids = new Set() } = {}) {
  const element = document.createElement('span');
  if (back) {
    element.className = 'mini-card back';
    element.setAttribute('aria-label', '牌背');
    return element;
  }
  const red = card.suit === 'heart' || card.suit === 'diamond' || (card.suit === 'joker' && card.rank === 'big');
  element.className = 'mini-card' + (red ? ' red' : '') + (isTrumpCard(card, ids) ? ' is-trump' : '') + (number(card.points) > 0 ? ' point' : '');
  element.innerHTML = `${esc(cardLabel(card))}${number(card.points) > 0 ? `<span class="mini-pt">+${number(card.points)}</span>` : ''}`;
  element.setAttribute('aria-label', cardLabel(card));
  return element;
}

function toggleCard(card) {
  if (!state.game || state.awaiting || isGamePaused(state.game) || autoSelectionFor(state.game)) return;
  if (isBuryTurn(state.game) && isPointCard(card)) return;
  const id = String(card.id);
  if (isTakeTurn(state.game)) {
    state.selected.clear();
    state.selected.add(id);
  } else if (state.selected.has(id)) {
    state.selected.delete(id);
  } else {
    if (isBuryTurn(state.game) && state.selected.size >= 6) {
      showToast('扣底需要正好 6 张');
      return;
    }
    state.selected.add(id);
  }
  renderGame(state.game);
}

function selectionSummary(game) {
  if (isTakeTurn(game)) return state.selected.size === 1 ? '已选退贡牌' : '请选 1 张退贡牌';
  if (isBuryTurn(game)) return `已选 ${state.selected.size}/6 张`;
  if (isPlayTurn(game)) {
    const auto = autoSelectionFor(game);
    if (auto) return auto.cardIds.length ? '请垫出全部分牌' : '本墩无分牌可垫';
    const matched = matchLegalPlay([...state.selected], game.legalPlays || []);
    if (matched) return '已选 ' + playOptionLabel(matched, game);
    if (state.recommended.size) return '推荐牌已标出';
    return state.selected.size ? `已选 ${state.selected.size} 张` : '';
  }
  if (game.phase === 'reveal') return isMyTurn(game) ? '选择亮牌或跳过' : '';
  return '';
}

function playOptionLabel(option, game) {
  if (option.dimension === 'four_clear') return '四清';
  const kong = (game.kongPlays || []).find((item) => sameIdSet(item.cardIds, option.cardIds));
  return kong?.label || dimensionLabel(option.dimension);
}

function renderGameActions(game) {
  const takeTurn = isTakeTurn(game);
  const buryTurn = isBuryTurn(game);
  const playTurn = isPlayTurn(game);
  const revealTurn = game.phase === 'reveal' && game.revealActor === game.me;
  const paused = isGamePaused(game);
  const auto = autoSelectionFor(game);
  const matched = playTurn ? matchLegalPlay([...state.selected], game.legalPlays || []) : null;
  const locked = state.awaiting || paused;

  $('btn-hint').hidden = game.phase === 'bury';
  $('btn-hint').disabled = !!auto || !playTurn || locked || !((game.legalPlays || []).length || (game.kongPlays || []).length || game.playHints?.auto);
  $('btn-clear').disabled = !!auto || locked || state.selected.size === 0;
  const playButton = $('btn-play');
  playButton.hidden = game.phase === 'bury';
  playButton.disabled = !playTurn || locked || (!auto && !matched);
  playButton.textContent = auto
    ? (auto.cardIds.length ? '垫出分牌' : '确认')
    : (matched ? '出牌 · ' + playOptionLabel(matched, game) : '出牌');

  $('btn-reveal-skip').hidden = !revealTurn;
  $('btn-reveal-skip').disabled = locked;
  const options = $('reveal-options');
  options.innerHTML = '';
  if (revealTurn) {
    (game.revealOptions || []).forEach((option, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost brass';
      button.dataset.revealIndex = String(index);
      button.textContent = option.level === 'wu' ? '亮五反' : '亮三反';
      button.disabled = locked;
      button.addEventListener('click', () => submit({ type: 'reveal', data: { cardIds: option.cardIds } }));
      options.appendChild(button);
    });
  }

  $('btn-tribute-take').hidden = !takeTurn;
  $('btn-tribute-take').disabled = locked || state.selected.size !== 1;
  $('btn-tribute-take').textContent = state.selected.size === 1 ? '退贡' : '选择 1 张';

  $('btn-bury').hidden = !buryTurn;
  $('btn-bury').disabled = locked || state.selected.size !== 6;
  $('btn-bury').textContent = state.selected.size === 6 ? '扣底并公开' : `扣底 ${state.selected.size}/6`;
}

function submit(message) {
  if (state.awaiting || (state.game && isGamePaused(state.game))) return;
  state.awaiting = true;
  state.submittedRects = [...state.selected].map((id) => {
    const card = document.querySelector(`#my-hand [data-card-id="${CSS.escape(id)}"]`);
    return card ? { id, rect: card.getBoundingClientRect().toJSON() } : null;
  }).filter(Boolean);
  const sent = send(message);
  if (!sent) {
    state.awaiting = false;
    if (state.game) renderGame(state.game);
    return;
  }
  if (state.game) renderGame(state.game);
}

function applyHint() {
  const game = state.game;
  if (!game || !isPlayTurn(game) || autoSelectionFor(game)) return;
  const ids = recommendedPlay({ legalPlays: game.legalPlays || [], kongPlays: game.kongPlays || [], playHints: game.playHints });
  if (!ids.length) { showToast('暂时没有可提示的牌'); return; }
  state.selected.clear();
  state.recommended = new Set(ids.map(String));
  renderGame(game);
}

function renderBottom(game) {
  const bottom = game.bottom || [];
  const hasBottom = bottom.length > 0;
  const toggle = $('btn-bottom-toggle');
  toggle.hidden = !hasBottom;
  toggle.textContent = hasAutoBurySnapshot(game) ? '底牌 · 自动扣底' : `底牌 ${bottom.length || 6}`;
  const drawer = $('bottom-drawer');
  if (!hasBottom) drawer.hidden = true;
  $('bottom-cards').innerHTML = '';
  for (const card of bottom) $('bottom-cards').appendChild(miniCard(card, { revealedIds: revealedIds(game) }));
}

function announceAutoBury(game) {
  if (game.phase !== 'trick' || !hasAutoBurySnapshot(game)) return;
  const key = `${number(game.roundNo)}:${game.buriedBy || 'auto'}`;
  if (state.lastAutoBuryKey === key) return;
  state.lastAutoBuryKey = key;
  showToast('分牌过多，已自动扣底');
}

function renderTributeNote(game) {
  const note = $('tribute-note');
  if (game.phase !== 'tribute') {
    note.hidden = true;
    note.innerHTML = '';
    return;
  }
  const give = game.lastGive;
  if (!give) { note.hidden = true; note.innerHTML = ''; return; }
  const mine = give.from === game.me || give.to === game.me;
  note.hidden = false;
  note.className = 'tribute-note' + (mine ? ' private' : '');
  note.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = `${nickAt(give.from)} → ${nickAt(give.to)} · 进贡 1 张`;
  note.appendChild(label);
  if (mine && give.card) note.appendChild(miniCard(give.card, { revealedIds: revealedIds(game) }));
  else note.appendChild(miniCard(null, { back: true }));
}

function renderReveal(game) {
  const stamp = $('reveal-stamp');
  const reveal = game.effectiveReveal;
  if (!reveal) {
    stamp.hidden = true;
    stamp.textContent = '';
    return;
  }
  const key = reveal.seat + ':' + reveal.level + ':' + (reveal.cardIds || []).join(',');
  stamp.hidden = false;
  stamp.textContent = reveal.level === 'wu' ? '五反' : '三反';
  if (key !== state.lastRevealKey) {
    state.lastRevealKey = key;
    stamp.classList.remove('show');
    void stamp.offsetWidth;
    stamp.classList.add('show');
  }
}

function renderTableNote(game) {
  const note = $('table-note');
  let text = '';
  if (game.phase === 'trick' && game.trick?.dimension) text = `${nickAt(game.trick.leaderSeat)} · ${dimensionLabel(game.trick.dimension)}`;
  else if (game.phase === 'reveal' && game.effectiveReveal) text = `${nickAt(game.effectiveReveal.seat)} 已亮${game.effectiveReveal.level === 'wu' ? '五反' : '三反'}`;
  else if (game.phase === 'tribute') text = game.tributeState?.step === 'give' ? '进贡中' : '请选择退贡牌';
  else if (game.phase === 'bury') text = '庄家整理底牌';
  note.textContent = text;
}

function gameStatus(game) {
  if (/已离线|等待重连/.test(game.message || '')) return game.message;
  if (game.phase === 'reveal') {
    if (isMyTurn(game)) return '请选择是否亮牌';
    return `等待 ${nickAt(game.revealActor)} 亮牌`;
  }
  if (game.phase === 'tribute') {
    if (isTakeTurn(game)) return '请选一张牌退还';
    const step = game.tributeState?.step;
    return step === 'take' ? `等待 ${nickAt(game.currentSeat)} 退贡` : '进贡中';
  }
  if (game.phase === 'bury') return isBuryTurn(game) ? '请选择 6 张扣底' : '等待庄家扣底';
  if (game.phase === 'trick') {
    if (game.trick?.winnerSeat != null) return `${nickAt(game.trick.winnerSeat)} 赢下本墩${game.trick.pointsWon ? ' · +' + game.trick.pointsWon : ''}`;
    if (isPlayTurn(game)) return '轮到你出牌';
    return `等待 ${nickAt(game.currentSeat)} 出牌`;
  }
  if (game.message) return game.message;
  return '牌桌同步中';
}

function renderSettle(game) {
  const result = game.result;
  if (!result) return;
  const dTeam = dealerTeam(game);
  const dealerSc = number(result.scores?.[dTeam]);
  const idleSc = number(result.scores?.[1 - dTeam]);
  const x = number(result.x, idleSc);
  const tiers = [
    { min: 0, max: 39, title: '< 40', line: '庄家守庄', detail: '无进贡' },
    { min: 40, max: 59, title: '40 – 59', line: '换庄', detail: '无进贡' },
    { min: 60, max: 79, title: '60 – 79', line: '换庄', detail: '单进贡' },
    { min: 80, max: 100, title: '80 – 100', line: '换庄', detail: '双进贡' },
  ];
  const active = tiers.findIndex((tier) => x >= tier.min && x <= tier.max);
  $('settle-round').textContent = `第 ${number(game.roundNo, 1)} 副结算 · 四人一副牌`;
  $('settle-stamp').textContent = result.dealerStay ? '守庄 · 连庄' : `换庄 · ${TRIBUTE_LABEL[result.tribute] || '无进贡'}`;
  $('settle-dealer-score').textContent = dealerSc;
  $('settle-idle-score').textContent = idleSc;
  const dealerNames = (game.seats || []).filter((seat, index) => seat && index % 2 === dTeam).map((seat) => seat.nickname).join(' · ');
  const idleNames = (game.seats || []).filter((seat, index) => seat && index % 2 !== dTeam).map((seat) => seat.nickname).join(' · ');
  $('settle-dealer-names').textContent = dealerNames || '—';
  $('settle-idle-names').textContent = idleNames || '—';
  $('settle-line').textContent = `闲家 ${x} 分 · ${tierText(x)}`;
  const tierContainer = $('settle-tiers');
  tierContainer.innerHTML = '';
  tiers.forEach((tier, index) => {
    const element = document.createElement('div');
    element.className = 'settle-tier' + (index === active ? ' active' : '');
    element.innerHTML = `<b>${tier.title}</b>${tier.line}<br>${tier.detail}`;
    tierContainer.appendChild(element);
  });
  $('settle-next-dealer').textContent = '下一副庄家';
  $('settle-next-note').textContent = nickAt(result.newDealerIndex);
  $('settle-tribute-title').textContent = '进贡';
  $('settle-tribute-note').textContent = result.rebellion ? '造反成立 · 本副免进贡' : '下一副：' + (TRIBUTE_LABEL[result.tribute] || '无进贡');
  $('settle-streak-title').textContent = '连庄';
  $('settle-streak-note').textContent = result.dealerStay ? `庄家连庄 ${number(result.streak)} 次` : '连庄清零';
  const bottom = $('settle-bottom');
  bottom.innerHTML = '';
  const cards = game.bottom || [];
  if (!cards.length) bottom.innerHTML = '<span class="muted">本副底牌未公开</span>';
  for (const card of cards) bottom.appendChild(miniCard(card, { revealedIds: revealedIds(game) }));
  $('btn-next-round').disabled = state.awaiting;
  setScreen('settle');
  updateMenu();
}

function captureTrickRects() {
  const result = {};
  document.querySelectorAll('#trick-zone .trick-slot').forEach((slot) => {
    result[slot.dataset.slot] = slot.getBoundingClientRect().toJSON();
  });
  return result;
}

function positionForSeat(seat, me) {
  const offset = (number(seat) - number(me) + 4) % 4;
  return ['me', 'left', 'top', 'right'][offset] || 'me';
}

function runGameAnimations(previous, game) {
  if (motionQuery.matches || document.documentElement.classList.contains('reduce-motion')) return;
  if (previous.roundNo !== game.roundNo) return;

  const oldTrick = previous.trick;
  if (oldTrick?.winnerSeat != null && oldTrick.plays?.length === 4 && state.trickRects) {
    animateCollection(oldTrick, state.trickRects, game);
  }

  const oldReveal = previous.effectiveReveal;
  const newReveal = game.effectiveReveal;
  const revealKey = (item) => item ? `${item.seat}:${item.level}:${(item.cardIds || []).join(',')}` : '';
  if (newReveal && revealKey(newReveal) !== revealKey(oldReveal)) {
    const from = document.getElementById('seat-' + newReveal.seat)?.getBoundingClientRect();
    const to = $('game-felt').getBoundingClientRect();
    if (from) {
      (newReveal.cardIds || []).slice(0, 5).forEach((id, index) => {
        const card = (previous.myHand || []).find((item) => String(item.id) === String(id)) || null;
        setTimeout(() => flyCard(card, from, to, { duration: 320, back: !card }), index * 50);
      });
    }
  }

  const oldKeys = new Set((oldTrick?.plays || []).map((play) => play.seat + ':' + (play.cardIds || []).join(',')));
  for (const play of game.trick?.plays || []) {
    const key = play.seat + ':' + (play.cardIds || []).join(',');
    if (oldKeys.has(key)) continue;
    const slot = document.querySelector(`#trick-zone .trick-slot[data-slot="${positionForSeat(play.seat, game.me)}"]`);
    const seat = document.getElementById('seat-' + play.seat);
    if (!slot || !seat) continue;
    const from = seat.getBoundingClientRect();
    const to = slot.getBoundingClientRect();
    (play.cards || []).slice(0, 6).forEach((card, index) => {
      const submitted = play.seat === game.me
        ? state.submittedRects?.find((item) => item.id === String(card.id))?.rect
        : null;
      setTimeout(() => flyCard(card, submitted || from, to, { duration: 300, scale: submitted ? 0.82 : 0.55 }), index * 40);
    });
  }
  state.submittedRects = null;

  const oldScore = number(previous.scores?.[0]) + number(previous.scores?.[1]);
  const newScore = number(game.scores?.[0]) + number(game.scores?.[1]);
  const delta = newScore - oldScore;
  if (delta > 0) {
    setTimeout(() => {
      $('dealer-score').parentElement.classList.add('bump');
      $('idle-score').parentElement.classList.add('bump');
      setTimeout(() => {
        $('dealer-score').parentElement.classList.remove('bump');
        $('idle-score').parentElement.classList.remove('bump');
      }, 650);
      const winnerSeat = game.trick?.winnerSeat ?? previous.trick?.winnerSeat;
      const anchor = winnerSeat != null ? document.getElementById('seat-' + winnerSeat) : $('game-felt');
      if (anchor) flyScore('+' + delta, anchor.getBoundingClientRect());
    }, 520);
  }

  const giveKey = game.lastGive ? `${game.lastGive.from}:${game.lastGive.to}:${game.lastGive.card?.id}` : '';
  if (giveKey && giveKey !== state.lastGiveKey) {
    state.lastGiveKey = giveKey;
    const from = document.getElementById('seat-' + game.lastGive.from)?.getBoundingClientRect();
    const to = document.getElementById('seat-' + game.lastGive.to)?.getBoundingClientRect();
    if (from && to) {
      const mine = game.lastGive.from === game.me || game.lastGive.to === game.me;
      setTimeout(() => flyCard(mine ? game.lastGive.card : null, from, to, { duration: 520, back: !mine }), 120);
    }
  }
}

function animateCollection(oldTrick, rects, game) {
  const targetSeat = oldTrick.winnerSeat;
  const target = document.getElementById('seat-' + targetSeat)?.getBoundingClientRect();
  if (!target) return;
  const cards = (oldTrick.plays || []).flatMap((play) => play.cards || []);
  const positions = Object.values(rects);
  if (!positions.length) return;
  cards.slice(0, 16).forEach((card, index) => {
    const from = positions[index % positions.length];
    setTimeout(() => flyCard(card, from, target, { duration: 380, scale: 0.35, fadeOut: true }), index * 40);
  });
}

function animateDeal(game) {
  if (motionQuery.matches || document.documentElement.classList.contains('reduce-motion')) return;
  state.dealAnimationRound = game.roundNo;
  const felt = $('game-felt').getBoundingClientRect();
  const center = { left: felt.left + felt.width / 2, top: felt.top + felt.height / 2, width: 38, height: 54 };
  const seats = [0, 1, 2, 3].map((index) => document.getElementById('seat-' + index)?.getBoundingClientRect()).filter(Boolean);
  if (!seats.length) return;
  for (let cardIndex = 0; cardIndex < 12; cardIndex += 1) {
    setTimeout(() => {
      seats.forEach((seat, seatIndex) => {
        setTimeout(() => flyCard(null, center, seat, { duration: 180, back: true, scale: 0.45, fadeOut: true }), seatIndex * 45);
      });
    }, cardIndex * 120);
  }
}

function makeFxCard(card, { back = false, width = 38, height = 54 } = {}) {
  const element = document.createElement('div');
  element.className = 'fx-card' + (back || !card ? ' back' : '') + (card && (card.suit === 'heart' || card.suit === 'diamond' || (card.suit === 'joker' && card.rank === 'big')) ? ' red' : '');
  element.style.width = width + 'px';
  element.style.height = height + 'px';
  if (card && !back) element.textContent = cardLabel(card);
  return element;
}

function flyCard(card, from, to, { duration = 280, back = !card, scale = 0.8, fadeOut = false } = {}) {
  if (motionQuery.matches || document.documentElement.classList.contains('reduce-motion')) return;
  const layer = $('fx-layer');
  const width = Math.max(28, Math.min(48, to.width ? to.width * 0.32 : 38));
  const height = width * 1.42;
  const element = makeFxCard(card, { back, width, height });
  element.style.left = (to.left + to.width / 2 - width / 2) + 'px';
  element.style.top = (to.top + to.height / 2 - height / 2) + 'px';
  layer.appendChild(element);
  const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
  const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
  const frames = [
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.1 },
    { transform: 'translate(0, 0) scale(1)', opacity: 1, offset: 0.82 },
  ];
  if (fadeOut) frames.push({ transform: 'translate(0, 0) scale(0.4)', opacity: 0 });
  const animation = element.animate(frames, { duration: motionMs(duration), easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
  animation.onfinish = () => element.remove();
}

function flyScore(text, from) {
  if (motionQuery.matches || document.documentElement.classList.contains('reduce-motion')) return;
  const element = document.createElement('div');
  element.className = 'fx-score';
  element.textContent = text;
  element.style.left = from.left + 'px';
  element.style.top = from.top + 'px';
  $('fx-layer').appendChild(element);
  const animation = element.animate([
    { transform: 'translate(-50%, -50%) scale(.8)', opacity: 0 },
    { transform: 'translate(-50%, -140%) scale(1)', opacity: 1, offset: 0.25 },
    { transform: 'translate(-50%, -260%) scale(1)', opacity: 0 },
  ], { duration: motionMs(900), easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
  animation.onfinish = () => element.remove();
}

function clearSessionAndLogin(message = '') {
  state.token = '';
  state.user = null;
  state.room = null;
  resetGameState();
  localStorage.removeItem(TOKEN_KEY);
  state.manualClose = true;
  if (state.ws) {
    try { state.ws.close(); } catch { /* ignore */ }
  }
  state.ws = null;
  showLogin(message);
  state.manualClose = false;
}

function leaveRoom({ logout = false } = {}) {
  closeMenu();
  if (state.room && state.ws?.readyState === WebSocket.OPEN) send({ type: 'leave_room' });
  if (logout) {
    setTimeout(() => clearSessionAndLogin(''), 40);
    return;
  }
  state.room = null;
  resetGameState();
  showLobby();
}

function bindEvents() {
  $('login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    if (!username || !password) { showLoginError('请输入账号和密码'); return; }
    beginLogin(username, password);
  });

  $('btn-create-room').addEventListener('click', () => send({ type: 'create_room' }));
  $('join-room-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const roomId = $('join-room-code').value.trim();
    if (!/^\d{6}$/.test(roomId)) {
      $('join-room-hint').textContent = '请输入 6 位房号';
      $('join-room-code').focus();
      return;
    }
    $('join-room-hint').textContent = '正在加入…';
    send({ type: 'join_room', data: { roomId } });
  });
  $('join-room-code').addEventListener('input', () => {
    $('join-room-code').value = $('join-room-code').value.replace(/\D/g, '').slice(0, 6);
  });

  $('btn-ready').addEventListener('click', () => send({ type: 'ready' }));
  $('btn-start-game').addEventListener('click', () => send({ type: 'start_game' }));
  $('btn-swap-seats').addEventListener('click', () => send({ type: 'swap_seats', data: { a: 2, b: 3 } }));
  $('btn-leave-room').addEventListener('click', () => leaveRoom());
  $('btn-back-lobby').addEventListener('click', () => leaveRoom());
  $('btn-copy-room').addEventListener('click', async () => {
    const code = state.room?.roomId;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showToast('房号已复制');
    } catch {
      showToast('复制失败，请手动记下 ' + code);
    }
  });

  $('btn-hint').addEventListener('click', applyHint);
  $('btn-clear').addEventListener('click', () => {
    if (state.game && autoSelectionFor(state.game)) return;
    state.selected.clear();
    state.recommended.clear();
    if (state.game) renderGame(state.game);
  });
  $('btn-play').addEventListener('click', () => {
    const game = state.game;
    if (!game) return;
    const option = matchLegalPlay([...state.selected], game.legalPlays || []);
    if (!option) return;
    submit({ type: 'play', data: { cardIds: option.cardIds.slice() } });
  });
  $('btn-reveal-skip').addEventListener('click', () => submit({ type: 'reveal', data: { cardIds: null } }));
  $('btn-tribute-take').addEventListener('click', () => {
    const id = [...state.selected][0];
    if (id) submit({ type: 'tribute_take', data: { cardId: id } });
  });
  $('btn-bury').addEventListener('click', () => {
    if (state.selected.size !== 6) return;
    submit({ type: 'bury', data: { cardIds: [...state.selected] } });
  });
  $('btn-next-round').addEventListener('click', () => {
    if (state.awaiting) return;
    state.awaiting = true;
    $('btn-next-round').disabled = true;
    if (!send({ type: 'next_round' })) state.awaiting = false;
  });

  $('btn-bottom-toggle').addEventListener('click', () => {
    $('bottom-drawer').hidden = !$('bottom-drawer').hidden;
  });
  $('btn-bottom-close').addEventListener('click', () => { $('bottom-drawer').hidden = true; });
  $('btn-game-back').addEventListener('click', () => showToast('对局进行中，可从菜单离开牌桌'));

  document.querySelectorAll('[data-menu-open]').forEach((button) => button.addEventListener('click', openMenu));
  $('btn-menu-close').addEventListener('click', closeMenu);
  $('menu-overlay').addEventListener('click', (event) => { if (event.target === $('menu-overlay')) closeMenu(); });
  document.querySelectorAll('[data-theme-choice]').forEach((button) => button.addEventListener('click', () => applyTheme(button.dataset.themeChoice)));
  $('toggle-motion').addEventListener('change', (event) => applyMotionPreference(event.target.checked));
  $('btn-menu-leave').addEventListener('click', () => leaveRoom());
  $('btn-menu-logout').addEventListener('click', () => leaveRoom({ logout: true }));
  $('btn-pause-menu').addEventListener('click', () => { hidePause(); openMenu(); });
  $('btn-reconnect').addEventListener('click', () => {
    if (!state.token) { state.manualClose = false; showLogin('请重新登录'); return; }
    state.reconnectAttempted = true;
    showPause('正在重新连接', '恢复后会回到当前牌局。', false);
    connect({ token: state.token }, { reconnect: true });
  });

  window.addEventListener('resize', () => {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      if (state.screen === 'game' && state.game) renderGame(state.game);
    }, 120);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      if (state.screen === 'login' || state.room) hidePause();
    }
  });
}

function init() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'green');
  const manualReduced = localStorage.getItem(MOTION_KEY) === '1';
  if (manualReduced) document.documentElement.classList.add('reduce-motion');
  bindEvents();
  updateMenu();
  if (state.token) {
    state.reconnectAttempted = true;
    showLogin('正在恢复登录…');
    connect({ token: state.token }, { reconnect: true });
  } else {
    showLogin();
  }
}

init();

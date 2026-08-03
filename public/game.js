// 红心对决 · M0 单机版前端 v2（交互优化版）
// 职责：仅渲染与交互。一切规则裁决由 game/game.mjs 引擎负责。
// 使用方式：node server.mjs 后访问 http://localhost:8080
import * as eng from '../game/game.mjs';

const $ = (id) => document.getElementById(id);

const SUIT_SYM = { spade: '♠', heart: '♥', club: '♣', diamond: '♦', joker: '★' };
const SUIT_CLS = { spade: 'black', heart: 'red', club: 'black', diamond: 'red', joker: 'joker' };
const PHASE_LABEL = { reveal: '亮牌', tribute: '进贡/退贡', bury: '埋底', trick: '打牌', round_end: '结算' };
const DIM_LABEL = { single: '单张', throw: '甩牌', fake_kong: '假杠', true_kong: '真杠', four_clear: '四清' };
const SEAT_PHASES = ['reveal', 'tribute', 'bury', 'trick'];

let engine = null;
let snap = null;
let names = ['玩家一', '玩家二', '玩家三', '玩家四'];
let selected = [];
let lastSeat = -1;
let prevPhase = null;
let buryPool = null;
let cardIndex = new Map();
let hints = null;
let toastTimer = null;

const METHODS = ['state', 'startRound', 'legalReveals', 'reveal', 'tributeGive', 'tributeTake', 'bury', 'legalPlays', 'play', 'roundResult', 'nextRound'];

/* ---------------- 引擎适配 ---------------- */
function initEngine(players) {
  engine = null;
  let g = null;
  try { g = typeof eng.newGame === 'function' ? eng.newGame(players) : null; } catch { /* 忽略 */ }
  if (g && typeof g.state === 'function') {
    engine = g;
  } else {
    engine = {};
    for (const m of METHODS) engine[m] = (...a) => eng[m](...a);
  }
}

function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }

/* ---------------- 基础工具 ---------------- */
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function buildIndex(s) {
  const idx = new Map();
  const add = (c) => { if (c && typeof c === 'object' && c.id != null) idx.set(String(c.id), c); };
  (s.hands || []).forEach((h) => (h || []).forEach(add));
  (s.bottom || []).forEach(add);
  (s.buried || []).forEach(add);
  (s.revealed || []).forEach(add);
  (s.trick && s.trick.plays || []).forEach((pl) => (pl.cards || []).forEach(add));
  return idx;
}

function phase() { return snap ? snap.phase : 'setup'; }
function currentSeat() { return (snap && snap.currentSeat != null) ? snap.currentSeat : 0; }
function seatName(i) {
  if (snap && snap.seats && snap.seats[i] && snap.seats[i].name) return snap.seats[i].name;
  return names[i] || '玩家' + (i + 1);
}
function isDealerSide(i) {
  if (!snap || snap.dealerIndex == null) return false;
  const d = snap.dealerIndex;
  return i === d || i === (d + 2) % 4;
}
function isMainCard(c) {
  if (!c) return false;
  if (snap && Array.isArray(snap.revealed)) {
    if (snap.revealed.some((x) => x && x.id === c.id)) return true;
  }
  if (c.suit === 'heart' || c.suit === 'joker') return true;
  if (c.suit === 'diamond' && String(c.rank) === '5') return true;
  if (c.suit === 'spade' && String(c.rank) === 'Q') return true;
  if (String(c.rank) === 'J' || String(c.rank) === '2') return true;
  return false;
}

/* ---------------- 渲染：牌 ---------------- */
function cardEl(c, opts = {}) {
  const div = document.createElement('div');
  if (opts.faceDown) { div.className = 'card back'; return div; }
  div.className = 'card ' + (SUIT_CLS[c.suit] || '');
  if (c.points > 0) { div.classList.add('scoring'); div.dataset.pts = c.points; }
  if (opts.selected) div.classList.add('selected');
  if (opts.main) div.classList.add('mainish');
  if (opts.hot) div.classList.add('hot');
  if (opts.dim) div.classList.add('dim');
  div.innerHTML = `<span class="cRank">${c.rank ?? '?'}</span><span class="cSuit">${SUIT_SYM[c.suit] || ''}</span>`;
  if (c.id != null) div.dataset.id = String(c.id);
  return div;
}

function renderOpponent(elId, seatIdx) {
  const el = $(elId);
  const count = (snap && snap.hands && snap.hands[seatIdx]) ? snap.hands[seatIdx].length : 0;
  const isCur = seatIdx === currentSeat();
  el.innerHTML = '';
  const nameEl = document.createElement('div');
  nameEl.className = 'seatName' + (isCur ? ' current' : '');
  nameEl.textContent = seatName(seatIdx) + (isCur ? '（轮到）' : '');
  const info = document.createElement('div');
  info.className = 'seatInfo';
  info.textContent = `${isDealerSide(seatIdx) ? '庄家方' : '闲家方'} · ${count} 张`;
  const backs = document.createElement('div');
  backs.className = 'backs';
  const shown = Math.min(count, 10);
  for (let i = 0; i < shown; i++) backs.appendChild(cardEl({}, { faceDown: true }));
  if (count > shown) {
    const more = document.createElement('span');
    more.className = 'more';
    more.textContent = '+' + (count - shown);
    backs.appendChild(more);
  }
  el.append(nameEl, info, backs);
}

function sortCards(cards) { return cards.slice().sort((a, b) => (b.power - a.power) || String(a.id).localeCompare(String(b.id))); }

function computeHints() {
  hints = phase() === 'trick' ? safe(() => engine.playHints(), null) : null;
}

/* ---------------- 交互：手牌点击 ---------------- */
function sameIds(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = a.map(String).sort(), sb = b.map(String).sort();
  return sa.every((v, i) => v === sb[i]);
}

function selectionPlay() {
  return (safe(() => engine.legalPlays(), []) || []).find((p) => sameIds(p.cardIds, selected)) || null;
}

function playReason(id) {
  const dim = snap && snap.trick ? snap.trick.dimension : null;
  if (dim === 'single') return '有同花色必须跟（无同花色可毙或垫）';
  if (dim === 'throw') return '跟牌张数/花色不符';
  if (dim === 'fake_kong') return '需出 4 张副牌（无副牌才可贴主牌）';
  if (dim === 'true_kong') return '需出 4 张（可垫任意 4 张）';
  if (dim === 'four_clear') return '需垫出手中全部分值牌';
  return '当前不可出这张牌';
}

function renderHand() {
  const el = $('handCards');
  const cur = currentSeat();
  const p = phase();
  let cards = [];
  if (p === 'bury' && buryPool) cards.push(...buryPool);
  else if (snap.hands && snap.hands[cur]) cards.push(...snap.hands[cur]);
  cards = sortCards(cards);

  const suggestedIds = new Set();
  if (p === 'reveal') {
    safe(() => engine.legalReveals(), []).forEach((o) => (o.cardIds || []).forEach((id) => suggestedIds.add(String(id))));
  }
  if (p === 'trick') {
    kongSuggestions().forEach((s) => (s.cardIds || []).forEach((id) => suggestedIds.add(String(id))));
  }

  const clickable = new Set();
  let mode = 'view';
  if (p === 'tribute') {
    const st = snap && snap.tributeState;
    if (st && st.step === 'take' && cur === st.pairs[st.pairIdx].taker) {
      mode = 'tribute';
      const mains = cards.filter((c) => isMainCard(c));
      const pool = mains.length > 0 ? mains : cards;
      pool.forEach((c) => clickable.add(String(c.id)));
    }
  } else if (p === 'bury' && cur === (snap && snap.dealerIndex)) {
    mode = 'bury';
    cards.filter((c) => c.points === 0).forEach((c) => clickable.add(String(c.id)));
  } else if (p === 'trick' && hints) {
    mode = 'trick';
    (hints.allowed || []).forEach((id) => clickable.add(String(id)));
  }

  el.innerHTML = '';
  cards.forEach((c) => {
    const cid = String(c.id);
    const opts = { main: isMainCard(c) };
    if (selected.includes(cid)) opts.selected = true;
    const node = cardEl(c, opts);
    if (suggestedIds.has(cid)) node.classList.add('suggested');
    if (mode !== 'view') {
      if (clickable.has(cid)) {
        node.classList.add('clickable');
        if (mode === 'trick' && hints && hints.count === 1) node.classList.add('hot');
      } else {
        node.classList.add('dim');
      }
      node.addEventListener('click', () => handleCardClick(c, mode));
    }
    el.appendChild(node);
  });

  let tip = '';
  if (mode === 'tribute') tip = '（点一张主牌即退贡）';
  else if (mode === 'bury') tip = `（选满 6 张自动扣底，已选 ${selected.length}/6）`;
  else if (mode === 'trick' && hints && hints.count === 1) tip = '（点合法牌即出）';
  $('handTitle').textContent =
    `${seatName(cur)} 的手牌（${isDealerSide(cur) ? '庄家方' : '闲家方'}）· ${cards.length} 张${tip}`;
}

function handleCardClick(c, mode) {
  const id = String(c.id);
  const p = phase();
  if (p === 'tribute') {
    act(() => engine.tributeTake(id));
    return;
  }
  if (p === 'bury') {
    if (c.points > 0) { toast('底牌不能扣分'); return; }
    toggleSelect(id, 6);
    if (selected.length === 6) act(() => engine.bury(selected));
    return;
  }
  if (p === 'trick') {
    if (!hints) return;
    if (hints.count === 1) {
      if ((hints.allowed || []).includes(id)) act(() => engine.play([id]));
      else toast(playReason(id));
      return;
    }
    if (selected.includes(id)) {
      selected = selected.filter((x) => x !== id);
    } else {
      if (!(hints.allowed || []).includes(id)) { toast(playReason(id)); return; }
      const max = hints.count || 12;
      if (selected.length >= max) { toast(`最多选 ${max} 张`); return; }
      selected.push(id);
    }
    renderHand();
    renderActionBar();
  }
}

function toggleSelect(id, maxSel) {
  const i = selected.indexOf(id);
  if (i >= 0) selected.splice(i, 1);
  else {
    if (selected.length >= maxSel) { toast(`最多选 ${maxSel} 张`); return; }
    selected.push(id);
  }
  renderHand();
  renderActionBar();
}
const RANK_VALUE = { '3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14,'2':15 };

// 智能提醒：当前可出的杠/四清组合（含响应时能压过对手的杠）
function sameRankByIds(ids) {
  if (!ids || ids.length < 2) return false;
  const r = cardIndex.get(String(ids[0])) && cardIndex.get(String(ids[0])).rank;
  return ids.every((id) => cardIndex.get(String(id)) && cardIndex.get(String(id)).rank === r);
}
function rankVal(id) { const c = cardIndex.get(String(id)); return c ? (RANK_VALUE[c.rank] || 0) : 0; }

function kongSuggestions() {
  const out = [];
  if (phase() !== 'trick' || !snap || !snap.trick) return out;
  const t = snap.trick;
  const plays = safe(() => engine.legalPlays(), []);
  if (t.plays.length === 0 || t.plays.length === 4) {
    for (const p of plays) {
      if (p.dimension === 'four_clear') out.push({ cardIds: p.cardIds, dimension: p.dimension, label: '🔥 四清（全场垫分值牌）' });
      else if (p.dimension === 'true_kong' && p.cardIds.length === 4 && sameRankByIds(p.cardIds)) {
        const c = cardIndex.get(String(p.cardIds[0]));
        out.push({ cardIds: p.cardIds, dimension: p.dimension, label: '🔥 真杠 ' + (c ? c.rank : '') });
      } else if (p.dimension === 'fake_kong') {
        out.push({ cardIds: p.cardIds, dimension: p.dimension, label: '🔥 假杠' });
      }
    }
    return out;
  }
  const dim = t.dimension;
  if (dim === 'fake_kong' || dim === 'true_kong') {
    const kongs = plays.filter((p) => p.cardIds.length === 4 && sameRankByIds(p.cardIds));
    if (!kongs.length) return out;
    const leaderRank = t.plays[0].cardIds.length ? rankVal(t.plays[0].cardIds[0]) : 0;
    kongs.sort((a, b) => rankVal(a.cardIds[0]) - rankVal(b.cardIds[0]));
    const best = kongs[kongs.length - 1];
    if (dim === 'fake_kong') {
      out.push({ cardIds: best.cardIds, dimension: 'true_kong', label: '🔥 真杠压假杠！' });
    } else if (rankVal(best.cardIds[0]) > leaderRank) {
      const c = cardIndex.get(String(best.cardIds[0]));
      out.push({ cardIds: best.cardIds, dimension: 'true_kong', label: '🔥 更大真杠（' + (c ? c.rank : '') + '）压过！' });
    }
  }
  return out;
}

/* ---------------- 渲染：牌桌 ---------------- */
function normalizePlays(t) {
  const out = [];
  const raw = t.plays;
  const toId = (c) => String(c && c.id != null ? c.id : c);
  if (Array.isArray(raw)) {
    raw.forEach((p, i) => {
      if (p && Array.isArray(p.cardIds)) out.push({ seat: p.seat != null ? p.seat : i, cardIds: p.cardIds.map(toId) });
      else if (Array.isArray(p)) out.push({ seat: i, cardIds: p.map(toId) });
    });
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) out.push({ seat: Number(k), cardIds: v.map(toId) });
    }
  }
  return out;
}

function renderBottom() {
  const el = $('bottomBar');
  const bottom = (snap && snap.bottom) || [];
  el.innerHTML = '';
  if (bottom.length === 0) return;
  const label = document.createElement('div');
  label.className = 'bottomLabel';
  label.textContent = '底牌（公开）';
  el.appendChild(label);
  const row = document.createElement('div');
  row.className = 'bottomCards';
  bottom.forEach((c) => row.appendChild(cardEl(c, { main: isMainCard(c) })));
  el.appendChild(row);
}

function renderTrick() {
  const infoEl = $('trickInfo'), cardsEl = $('trickCards'), resEl = $('trickResult');
  cardsEl.innerHTML = '';
  infoEl.textContent = '';
  resEl.textContent = '';
  const t = snap ? snap.trick : null;
  if (!t) return;
  if (t.leaderSeat != null) {
    infoEl.textContent = `领出：${seatName(t.leaderSeat)}${t.dimension ? ' · ' + (DIM_LABEL[t.dimension] || t.dimension) : ''}`;
  }
  normalizePlays(t).forEach((p) => {
    const wrap = document.createElement('div');
    wrap.className = 'play';
    const label = document.createElement('div');
    label.className = 'playSeat';
    label.textContent = seatName(p.seat);
    wrap.appendChild(label);
    const row = document.createElement('div');
    row.className = 'playCards';
    p.cardIds.forEach((id) => {
      const c = cardIndex.get(id);
      row.appendChild(c ? cardEl(c) : cardEl({ rank: '?', suit: 'spade' }));
    });
    wrap.appendChild(row);
    cardsEl.appendChild(wrap);
  });
  if (t.winnerSeat != null) {
    const pts = t.pointsWon || t.points || 0;
    resEl.textContent = `${seatName(t.winnerSeat)} 赢得本墩${pts ? '，得 ' + pts + ' 分' : ''}`;
    resEl.classList.add('flash');
    setTimeout(() => resEl.classList.remove('flash'), 500);
  }
}

/* ---------------- 渲染：操作区 ---------------- */
function makeBtn(label, fn, enabled = true) {
  const b = document.createElement('button');
  b.textContent = label;
  b.disabled = !enabled;
  b.addEventListener('click', fn);
  return b;
}

function revealLabel(o) {
  const ids = o.cardIds || [];
  const ranks = ids.map((id) => { const c = cardIndex.get(String(id)); return c ? String(c.rank) : ''; });
  if (ranks.length === 3 && ranks.every((r) => r === '5')) return '亮五反';
  if (ranks.length === 3 && ranks.every((r) => r === '3')) return '亮三反';
  return `亮出（${ids.length}张）`;
}

function renderActionBar() {
  const hint = $('hint'), btns = $('buttons');
  hint.textContent = '';
  btns.innerHTML = '';
  const p = phase();
  if (!snap) return;
  const cur = currentSeat();
  if (p === 'reveal') {
    hint.textContent = `${seatName(cur)}：可亮出三张3（三反）或三张5（五反）`;
    const opts = safe(() => engine.legalReveals(), []);
    (opts || []).forEach((o) => {
      const b = makeBtn('✨ ' + revealLabel(o), () => act(() => engine.reveal(o.cardIds)));
      b.classList.add('suggest');
      btns.appendChild(b);
    });
    btns.appendChild(makeBtn('不亮 / 跳过', () => act(() => engine.reveal(null))));
  } else if (p === 'tribute') {
    const st = snap.tributeState;
    if (!st) return;
    if (st.step === 'give' && cur === st.pairs[st.pairIdx].giver) {
      hint.textContent = `${seatName(cur)}（庄家方）进贡：自动给出手中最大的一张`;
      btns.appendChild(makeBtn('自动进贡', () => act(() => engine.tributeGive())));
    } else if (st.step === 'take') {
      hint.textContent = `${seatName(cur)}（闲家方）退贡：点一张主牌即退（无主牌可退任意牌）`;
    }
  } else if (p === 'bury') {
    hint.textContent = `庄家 ${seatName(cur)} 从 18 张中选 6 张扣底（已选 ${selected.length}/6，点选无分牌，满 6 张自动扣）`;
    if (selected.length > 0) btns.appendChild(makeBtn('清空选择', () => { selected = []; renderHand(); renderActionBar(); }));
  } else if (p === 'trick') {
    kongSuggestions().forEach((s) => {
      const b = makeBtn(s.label, () => act(() => engine.play(s.cardIds)));
      b.classList.add('suggest');
      btns.appendChild(b);
    });
    const dim = snap.trick && snap.trick.dimension;
    let msg = `${seatName(cur)} 出牌`;
    if (dim) msg += `（本墩：${DIM_LABEL[dim] || dim}）`;
    if (!hints) {
      hint.textContent = msg + ' · 本墩已结束';
    } else if (hints.auto) {
      const n = (hints.allowed || []).length;
      hint.textContent = msg + ` · 需垫出全部分值牌（${n} 张）`;
      btns.appendChild(makeBtn(`垫出全部分值牌（${n} 张）`, () => act(() => engine.play(hints.allowed))));
    } else if (hints.count === 1) {
      hint.textContent = msg + ' · 点合法牌即出';
    } else {
      if (hints.count) msg += ` · 选 ${hints.count} 张`;
      if (selected.length > 0) msg += `（已选 ${selected.length} 张）`;
      hint.textContent = msg;
      const sel = selectionPlay();
      btns.appendChild(makeBtn(
        sel ? `出牌：${DIM_LABEL[sel.dimension] || sel.dimension}（${sel.cardIds.length} 张）` : '出牌',
        () => act(() => engine.play(selected)),
        !!sel && selected.length > 0
      ));
      if (selected.length > 0) btns.appendChild(makeBtn('清空选择', () => { selected = []; renderHand(); renderActionBar(); }));
    }
  }
}

/* ---------------- 动作与流转 ---------------- */
function act(fn) {
  try {
    fn();
    refresh();
    maybeHandoff();
  } catch (e) {
    toast(e.message || String(e));
  }
}

function refreshBuryPool() {
  buryPool = null;
  if (phase() !== 'bury' || !snap) return;
  const d = snap.dealerIndex;
  if (d == null) return;
  const h = (snap.hands && snap.hands[d]) || [];
  const bottom = snap.bottom || [];
  if (h.length >= 18) buryPool = h;
  else if (h.length + bottom.length === 18) buryPool = [...h, ...bottom];
  else buryPool = h;
}

function refresh() {
  snap = safe(() => engine.state(), null);
  if (!snap) return;
  cardIndex = buildIndex(snap);
  refreshBuryPool();
  computeHints();
  // 进贡自动执行（进贡方自动给出最大牌）
  const st = snap.tributeState;
  if (snap.phase === 'tribute' && st && st.step === 'give' && snap.currentSeat === st.pairs[st.pairIdx].giver) {
    try {
      engine.tributeGive();
      snap = safe(() => engine.state(), null);
      if (!snap) return;
      cardIndex = buildIndex(snap);
      computeHints();
      toast(`进贡完成：${seatName(st.pairs[st.pairIdx].giver)} 给出最大牌`);
    } catch { /* 忽略 */ }
  }
  if (prevPhase !== snap.phase || lastSeat !== snap.currentSeat) selected = [];
  prevPhase = snap.phase;
  renderAll();
}

function renderAll() {
  renderTop();
  const cur = currentSeat();
  renderOpponent('seatTop', (cur + 2) % 4);
  renderOpponent('seatLeft', (cur + 3) % 4);
  renderOpponent('seatRight', (cur + 1) % 4);
  renderHand();
  renderTrick();
  renderBottom();
  renderActionBar();
}

function renderTop() {
  $('roundInfo').textContent = `第 ${snap.roundNo ?? 1} 副`;
  $('phaseInfo').textContent = snap ? (PHASE_LABEL[snap.phase] || snap.phase) : '准备中';
  const sc = snap && snap.scores && snap.scores.length >= 2 ? snap.scores : null;
  if (sc && snap.dealerIndex != null) {
    const t = snap.dealerIndex % 2;
    $('scoreInfo').textContent = `庄家方 ${sc[t]} : ${sc[1 - t]} 闲家方`;
  } else {
    $('scoreInfo').textContent = '—';
  }
}

function showPass(seat) {
  const n = seatName(seat);
  $('passName').textContent = n;
  $('passName2').textContent = `${n} · 请完成：${PHASE_LABEL[phase()] || phase()}`;
  $('passOverlay').classList.remove('hidden');
}

function maybeHandoff() {
  if (phase() !== 'round_end') $('resultOverlay').classList.add('hidden');
  if (phase() === 'round_end') {
    showResult();
    lastSeat = currentSeat();
    return;
  }
  if (SEAT_PHASES.includes(phase())) {
    const cur = currentSeat();
    if (lastSeat !== cur) showPass(cur);
    if (phase() === 'reveal' && safe(() => engine.legalReveals(), []).length > 0) toast('你手里有三反/五反，可以亮牌！');
    lastSeat = cur;
  } else {
    lastSeat = currentSeat();
  }
}

/* ---------------- 结算 ---------------- */
function showResult() {
  const sc = snap.scores || [];
  let r = null;
  try { r = engine.roundResult(); } catch { /* 忽略 */ }
  const d = snap.dealerIndex;
  const t = d % 2;
  const dealerScore = sc[t] != null ? sc[t] : 0;
  const idleScore = sc[1 - t] != null ? sc[1 - t] : (100 - dealerScore);
  const lines = [];
  lines.push(`庄家方得分：<b>${dealerScore}</b>　闲家方得分：<b>${idleScore}</b>`);
  if (r) {
    lines.push(r.dealerStay ? '庄家方守庄（连庄）' : '闲家得分 ≥ 40，换庄');
    lines.push(r.tribute ? `进贡：${r.tribute}` : '本副无进贡');
    if (r.streak != null) lines.push(`连庄计数：${r.streak}`);
    if (r.newDealerIndex != null) lines.push(`下一副庄家：${seatName(r.newDealerIndex)}`);
  } else {
    lines.push(dealerScore < 40 ? '庄家连庄' : '换庄');
  }
  $('resultContent').innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
  $('resultOverlay').classList.remove('hidden');
}

/* ---------------- 事件绑定 ---------------- */
$('startBtn').addEventListener('click', () => {
  names = [0, 1, 2, 3].map((i) => $('name' + i).value.trim() || '玩家' + (i + 1));
  try {
    initEngine(names);
    engine.startRound();
    $('setupOverlay').classList.add('hidden');
    lastSeat = -1;
    refresh();
    maybeHandoff();
  } catch (e) {
    toast(e.message || String(e));
  }
});
$('resetBtn').addEventListener('click', () => location.reload());
$('passConfirm').addEventListener('click', () => $('passOverlay').classList.add('hidden'));
$('nextRoundBtn').addEventListener('click', () => act(() => engine.nextRound()));
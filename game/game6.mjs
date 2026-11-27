// game/game6.mjs — 《红心对决》6 人两副牌规则引擎（按 2026-11-26 审阅稿与 TF-20261127-001 已确认规则）
// 与 game.mjs 共享牌力与组合工具；不改变四人产品行为。
//
// 座位映射（房间座位 0–5 固定，不随换庄重编号）：
//   房间座位按顺时针围坐：0→1→2→3→4→5→0。
//   出牌逆时针：下家 = (seat + 5) % 6。
//   产品座位 1–6：以本副庄家为产品座位 1，再按顺时针编号。
//     productSeat(roomSeat) = ((roomSeat - dealerIndex + 6) % 6) + 1
//     roomSeat(productSeat) = (dealerIndex + productSeat - 1) % 6
//   队伍：产品座位 1/3/5 对 2/4/6，等价于 roomSeat % 2（庄家方 = dealerIndex % 2）。
//   进贡配对（顺时针）：单进贡 1→2；三进贡 1↔2、3↔4、5↔6；退贡原路返回。
//   换庄：原庄家逆时针下家；(dealer+5)%6。连庄满 3 副：逆时针最近队友 (dealer+4)%6。

import {
  basePower,
  isChangZhu,
  isMain,
  followSuit,
  TRUE_KONG_RANK_VALUE,
  sameRank,
  combosOf,
  dedupe,
  shuffle,
} from './game.mjs';

const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['spade', 'heart', 'club', 'diamond'];
const POINT_MAP = { '5': 5, '10': 10, 'K': 10 };
const N = 6;
const HAND = 17;
const BOTTOM = 6;
const DECK_COUNT = 2;
const TRIBUTE_THRESHOLD_SINGLE = 120;
const TRIBUTE_THRESHOLD_TRIPLE = 160;
const STAY_THRESHOLD = 80;

export function createDecks() {
  const deck = [];
  for (let d = 0; d < DECK_COUNT; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({ id: `${suit}_${rank}_${d}`, suit, rank, power: basePower(suit, rank), points: POINT_MAP[rank] || 0 });
      }
    }
    deck.push({ id: `joker_big_${d}`, suit: 'joker', rank: 'big', power: 799, points: 0 });
    deck.push({ id: `joker_small_${d}`, suit: 'joker', rank: 'small', power: 798, points: 0 });
  }
  return deck;
}

export function ccw(seat) { return (seat + N - 1) % N; }
export function cw(seat) { return (seat + 1) % N; }
export function productSeatOf(roomSeat, dealerIndex) { return ((roomSeat - dealerIndex + N) % N) + 1; }
export function roomSeatOfProduct(productSeat, dealerIndex) { return (dealerIndex + productSeat - 1) % N; }

function revealOrderFrom(dealer) {
  const order = [dealer];
  let s = dealer;
  for (let i = 1; i < N; i++) { s = ccw(s); order.push(s); }
  return order;
}

function sameIdSet(cards, ids) {
  if (cards.length !== ids.length) return false;
  const have = new Set(cards.map((c) => c.id));
  return ids.every((id) => have.has(id));
}

/** 两副牌杠/四清判定：花色+点数，id 带副序号。未凑齐四门的四张 4 为真杠。 */
export function kongDimension6(cards) {
  if (cards.length !== 4) return null;
  if (sameRank(cards)) {
    if (cards[0].rank === '4') {
      const suits = new Set(cards.map((c) => c.suit));
      if (suits.size === 4) return 'four_clear';
    }
    return 'true_kong';
  }
  const q = cards.find((c) => c.suit === 'spade' && c.rank === 'Q');
  if (!q) return null;
  const rest = cards.filter((c) => c.id !== q.id);
  if (rest.length === 3 && sameRank(rest) && rest[0].rank !== 'Q') return 'fake_kong';
  return null;
}

export class Game6 {
  constructor(names, rng) {
    this.names = names.slice(0, N);
    this.rng = rng || Math.random;
    this.players = this.names.map((name, i) => ({ index: i, name, team: i % 2 }));
    this.cardMap = new Map(createDecks().map((c) => [c.id, c]));
    this.roundNo = 0;
    this.dealerIndex = null;
    this.streak = 0;
    this.phase = 'idle';
    this.hands = null;
    this.bottom = null;
    this.buriedBy = null;
    this.revealed = new Map();
    this.reveals = [];
    this.effectiveReveal = null;
    this.tributed = new Set(); // 本副进贡所得的牌（不含退贡牌）
    this.tributePlan = 'none';
    this.tributeState = null;
    this.scores = [0, 0];
    this.trick = null;
    this.currentSeat = null;
    this.revealOrder = null;
    this.revealIdx = 0;
    this.result = null;
    this.lastGive = null;
    this.autoBury = null;
    this.redealCount = 0;
  }

  startRound({ redeal = false } = {}) {
    if (!redeal) {
      if (this.roundNo === 0) {
        this.dealerIndex = Math.floor(this.rng() * N);
        this.streak = 0;
      } else if (this.result) {
        this.dealerIndex = this.result.newDealerIndex;
        this.streak = this.result.streak;
      }
      this.roundNo++;
      this.tributePlan = this.result ? this.result.tribute : 'none';
      this.redealCount = 0;
    } else {
      this.redealCount = (this.redealCount || 0) + 1;
    }
    const deck = shuffle([...this.cardMap.values()], this.rng);
    this.hands = [];
    for (let i = 0; i < N; i++) this.hands[i] = deck.slice(i * HAND, i * HAND + HAND);
    this.bottom = deck.slice(N * HAND, N * HAND + BOTTOM);
    this.revealed = new Map();
    this.reveals = [];
    this.effectiveReveal = null;
    this.tributed = new Set();
    this.tributeState = null;
    this.scores = [0, 0];
    this.trick = null;
    this.result = null;
    this.lastGive = null;
    this.autoBury = null;
    this.buriedBy = null;
    this.phase = 'reveal';
    this.revealOrder = revealOrderFrom(this.dealerIndex);
    this.revealIdx = 0;
    this.currentSeat = this.revealOrder[0];
  }

  nextRound() {
    if (this.phase !== 'round_end') throw new Error('NOT_ROUND_END');
    this.startRound();
  }

  roundResult() { return this.result; }

  /* ---------- 工具 ---------- */
  cardById(id) {
    const c = this.cardMap.get(id);
    if (!c) throw new Error('CARD_NOT_FOUND:' + id);
    return c;
  }
  powerOf(c) { return this.revealed.get(c.id) ?? c.power; }
  isRevealed(c) { return this.revealed.has(c.id); }
  isMainOrRevealed(c) { return isMain(c) || this.isRevealed(c); }
  // 已亮三五反按主牌走，不按原花色跟牌
  suitOf(c) { return (isChangZhu(c) || this.isRevealed(c)) ? null : followSuit(c); }
  handIds(seat) { return this.hands[seat].map((c) => c.id); }
  handMain(seat) { return this.hands[seat].filter((c) => this.isMainOrRevealed(c)); }
  handScoring(seat) { return this.hands[seat].filter((c) => c.points > 0); }
  handSub(seat) { return this.hands[seat].filter((c) => !this.isMainOrRevealed(c)); }
  handFollow(seat, cat) { return this.hands[seat].filter((c) => this.suitOf(c) === cat); }
  productSeat(roomSeat) { return productSeatOf(roomSeat, this.dealerIndex); }
  revealCount() { return new Set(this.reveals.map((r) => r.seat)).size; }
  hasTributed(cards) { return cards.some((c) => this.tributed.has(c.id)); }
  comboDimension(cards) {
    if (this.hasTributed(cards)) return null;
    return kongDimension6(cards);
  }

  /* ---------- 亮牌（三反与五反同时有效，互不覆盖；按亮出人数免贡） ---------- */
  legalReveals(seat) {
    if (seat == null) {
      if (this.phase === 'reveal') seat = this.revealOrder[this.revealIdx];
      else if (this.phase === 'bury') seat = this.dealerIndex;
      else return [];
    }
    if (this.phase === 'reveal') {
      if (this.revealOrder[this.revealIdx] !== seat) return [];
    } else if (this.phase === 'bury') {
      if (seat !== this.dealerIndex) return [];
    } else {
      return [];
    }
    const used = new Set();
    for (const r of this.reveals) if (r.seat === seat) for (const id of r.cardIds) used.add(id);
    const hand = this.hands[seat] || [];
    const byRank = {};
    for (const c of hand) {
      if (used.has(c.id)) continue;
      if (c.rank === '5' || c.rank === '3') (byRank[c.rank] ||= []).push(c);
    }
    const out = [];
    if ((byRank['5'] || []).length >= 3) out.push({ cardIds: byRank['5'].slice(0, 3).map((c) => c.id), level: 'wu' });
    if ((byRank['3'] || []).length >= 3) out.push({ cardIds: byRank['3'].slice(0, 3).map((c) => c.id), level: 'san' });
    return out;
  }

  _applyReveal(seat, cardIds) {
    if (!Array.isArray(cardIds) || cardIds.length !== 3) throw new Error('REVEAL_NEED_3');
    const handSet = new Set(this.handIds(seat));
    for (const id of cardIds) if (!handSet.has(id)) throw new Error('CARD_NOT_IN_HAND');
    const already = new Set();
    for (const r of this.reveals) for (const id of r.cardIds) already.add(id);
    for (const id of cardIds) if (already.has(id)) throw new Error('REVEAL_ALREADY_USED');
    const cards = cardIds.map((id) => this.cardById(id));
    if (!cards.every((c) => c.rank === cards[0].rank)) throw new Error('REVEAL_SAME_RANK');
    const level = cards[0].rank === '5' ? 'wu' : cards[0].rank === '3' ? 'san' : null;
    if (!level) throw new Error('REVEAL_RANK_35');
    for (const c of cards) {
      this.revealed.set(c.id, level === 'wu' ? (c.suit === 'diamond' && c.rank === '5' ? 1000 : 998) : 996);
    }
    const rec = { seat, level, cardIds: cardIds.slice() };
    this.reveals.push(rec);
    this.effectiveReveal = rec;
  }

  _afterRevealPhaseDone() {
    const n = this.revealCount();
    if (n >= 2) this.tributePlan = 'none';
    else if (n === 1 && this.tributePlan === 'single') this.tributePlan = 'none';
    if (this.tributePlan === 'none') this.enterBury();
    else this.enterTribute();
  }

  reveal(cardIds) {
    if (this.phase !== 'reveal') throw new Error('BAD_PHASE');
    const seat = this.revealOrder[this.revealIdx];
    if (cardIds !== null && cardIds !== undefined) {
      this._applyReveal(seat, cardIds);
      // 同一人若还能亮另一套（三反/五反），仍停留在该座位，可继续亮或跳过
      if (this.legalReveals(seat).length > 0) {
        this.currentSeat = seat;
        return;
      }
    }
    this.revealIdx++;
    if (this.revealIdx >= N) this._afterRevealPhaseDone();
    else this.currentSeat = this.revealOrder[this.revealIdx];
  }

  // 庄家埋底补亮：进贡之后发生；已完成的进贡结果保持不变，不作废或回溯
  buryReveal(cardIds) {
    if (this.phase !== 'bury') throw new Error('BAD_PHASE');
    const seat = this.dealerIndex;
    this._applyReveal(seat, cardIds);
  }

  /* ---------- 进贡 ---------- */
  tributePairs() {
    const d = this.dealerIndex;
    if (this.tributePlan === 'triple') {
      return [
        { giver: d, taker: cw(d) },
        { giver: cw(cw(d)), taker: cw(cw(cw(d))) },
        { giver: cw(cw(cw(cw(d)))), taker: cw(cw(cw(cw(cw(d))))) },
      ];
    }
    if (this.tributePlan === 'single') return [{ giver: d, taker: cw(d) }];
    return [];
  }

  enterTribute() {
    this.phase = 'tribute';
    const pairs = this.tributePairs();
    this.tributeState = { pairs, pairIdx: 0, step: 'give' };
    this.currentSeat = pairs[0].giver;
  }

  legalTributeGives(seat) {
    const hand = this.hands[seat] || [];
    const nonPoints = hand.filter((c) => c.points === 0);
    if (nonPoints.length === 0) return [];
    let max = this.powerOf(nonPoints[0]);
    for (const c of nonPoints) if (this.powerOf(c) > max) max = this.powerOf(c);
    return nonPoints.filter((c) => this.powerOf(c) === max);
  }

  tributeGive(cardId) {
    if (this.phase !== 'tribute' || !this.tributeState) throw new Error('BAD_PHASE');
    const st = this.tributeState;
    if (st.step !== 'give') throw new Error('NOT_GIVE_STEP');
    const p = st.pairs[st.pairIdx];
    if (this.currentSeat !== p.giver) throw new Error('NOT_YOUR_TURN');
    const legal = this.legalTributeGives(p.giver);
    if (legal.length === 0) throw new Error('TRIBUTE_NO_NON_POINT');
    let best;
    if (cardId != null && cardId !== '') {
      best = legal.find((c) => c.id === cardId);
      if (!best) throw new Error('TRIBUTE_GIVE_NOT_MAX_NON_POINT');
    } else if (legal.length === 1) {
      best = legal[0];
    } else {
      throw new Error('TRIBUTE_GIVE_NEED_CHOICE');
    }
    this.hands[p.giver] = this.hands[p.giver].filter((c) => c.id !== best.id);
    this.hands[p.taker].push(best);
    this.tributed.add(best.id); // 仅标记进贡所得
    this.lastGive = { from: p.giver, to: p.taker, cardId: best.id };
    st.step = 'take';
    this.currentSeat = p.taker;
  }

  legalTributeTakes(seat) {
    const hand = this.hands[seat] || [];
    const mains = this.handMain(seat);
    const nonScoringMains = mains.filter((c) => c.points === 0);
    if (mains.length > 0) return nonScoringMains.length > 0 ? nonScoringMains : mains.slice();
    const nonScoring = hand.filter((c) => c.points === 0);
    return nonScoring.length > 0 ? nonScoring : hand.slice();
  }

  tributeTake(cardId) {
    if (this.phase !== 'tribute' || !this.tributeState) throw new Error('BAD_PHASE');
    const st = this.tributeState;
    if (st.step !== 'take') throw new Error('NOT_TAKE_STEP');
    const p = st.pairs[st.pairIdx];
    if (this.currentSeat !== p.taker) throw new Error('NOT_YOUR_TURN');
    const card = this.cardById(cardId);
    if (this.hands[p.taker].indexOf(card) < 0) throw new Error('CARD_NOT_IN_HAND');
    const mains = this.handMain(p.taker);
    const legal = this.legalTributeTakes(p.taker);
    if (!legal.includes(card)) {
      if (mains.length > 0 && !this.isMainOrRevealed(card)) throw new Error('NEED_MAIN_CARD');
      throw new Error('TRIBUTE_NO_POINTS');
    }
    this.hands[p.taker] = this.hands[p.taker].filter((c) => c !== card);
    this.hands[p.giver].push(card);
    // 退贡牌不加入 tributed
    st.pairIdx++;
    if (st.pairIdx >= st.pairs.length) this.enterBury();
    else { st.step = 'give'; this.currentSeat = st.pairs[st.pairIdx].giver; }
  }

  /* ---------- 埋底：无自动埋底；凑不出 6 张无分牌才重开本副 ---------- */
  enterBury() {
    this.phase = 'bury';
    this.currentSeat = this.dealerIndex;
    this.hands[this.dealerIndex] = this.hands[this.dealerIndex].concat(this.bottom);
    this.bottom = [];
    const nonPoints = this.hands[this.dealerIndex].filter((c) => c.points === 0);
    if (nonPoints.length < BOTTOM) {
      this.startRound({ redeal: true });
    }
  }

  bury(cardIds) {
    if (this.phase !== 'bury') throw new Error('BAD_PHASE');
    if (this.currentSeat !== this.dealerIndex) throw new Error('NOT_YOUR_TURN');
    if (!Array.isArray(cardIds) || cardIds.length !== BOTTOM || new Set(cardIds).size !== BOTTOM) throw new Error('BURY_NEED_6');
    const cards = cardIds.map((id) => this.cardById(id));
    const handSet = new Set(this.handIds(this.dealerIndex));
    for (const id of cardIds) if (!handSet.has(id)) throw new Error('CARD_NOT_IN_HAND');
    if (cards.some((c) => c.points > 0)) throw new Error('BURY_NO_POINTS');
    this.bottom = cards;
    this.buriedBy = 'manual';
    const idSet = new Set(cardIds);
    this.hands[this.dealerIndex] = this.hands[this.dealerIndex].filter((c) => !idSet.has(c.id));
    this.startTrick(this.dealerIndex);
  }

  /* ---------- 打牌 ---------- */
  startTrick(leader) {
    this.phase = 'trick';
    this.trick = { leaderSeat: leader, dimension: null, plays: [], winnerSeat: null, pointsWon: 0 };
    this.currentSeat = leader;
  }

  isTopNofFollow(seat, cards, cat) {
    const sorted = this.handFollow(seat, cat).slice().sort((a, b) => (this.powerOf(b) - this.powerOf(a)) || a.id.localeCompare(b.id));
    const prefix = sorted.slice(0, cards.length).map((c) => c.id).sort();
    return JSON.stringify(cards.map((c) => c.id).sort()) === JSON.stringify(prefix);
  }

  isTopNofMain(seat, cards) {
    const sorted = this.handMain(seat).slice().sort((a, b) => (this.powerOf(b) - this.powerOf(a)) || a.id.localeCompare(b.id));
    const prefix = sorted.slice(0, cards.length).map((c) => c.id).sort();
    return JSON.stringify(cards.map((c) => c.id).sort()) === JSON.stringify(prefix);
  }

  leadLegal(cardIds) {
    const cards = cardIds.map((id) => this.cardById(id));
    const n = cards.length;
    if (n === 0) return { ok: false, reason: 'BAD_LEAD' };
    if (n === 1) return { ok: true, dimension: 'single' };
    if (n === 4) {
      const dimension = this.comboDimension(cards);
      if (dimension) return { ok: true, dimension };
    }
    // 六人甩牌张数不限，恰好 4 张也允许（非杠/四清时走甩牌）
    const follow = this.suitOf(cards[0]);
    if (follow !== null && cards.every((c) => this.suitOf(c) === follow)) {
      if (this.isTopNofFollow(this.currentSeat, cards, follow)) return { ok: true, dimension: 'throw' };
      return { ok: false, reason: 'THROW_NOT_TOP' };
    }
    if (cards.every((c) => this.isMainOrRevealed(c))) {
      if (this.isTopNofMain(this.currentSeat, cards)) return { ok: true, dimension: 'throw' };
      return { ok: false, reason: 'THROW_NOT_TOP' };
    }
    return { ok: false, reason: 'BAD_LEAD' };
  }

  singleResponseOk(card, lead) {
    const cat = (isChangZhu(lead) || this.isRevealed(lead)) ? 'main' : this.suitOf(lead);
    if (cat === 'main' || cat === null) {
      if (this.handMain(this.currentSeat).length > 0) return this.isMainOrRevealed(card);
      return true;
    }
    if (this.handFollow(this.currentSeat, cat).length > 0) return this.suitOf(card) === cat;
    return true;
  }

  throwResponseOk(cards) {
    const leadCards = this.trick.plays[0].cardIds.map((id) => this.cardById(id));
    const leadFollow = this.suitOf(leadCards[0]);
    const isSuitThrow = leadFollow !== null && leadCards.every((c) => this.suitOf(c) === leadFollow);
    const isMainThrow = !isSuitThrow && leadCards.every((c) => this.isMainOrRevealed(c));
    if (isMainThrow) {
      const need = Math.min(this.handMain(this.currentSeat).length, cards.length);
      const have = cards.filter((c) => this.isMainOrRevealed(c)).length;
      return have === need;
    }
    const need = Math.min(this.handFollow(this.currentSeat, leadFollow).length, cards.length);
    const have = cards.filter((c) => this.suitOf(c) === leadFollow).length;
    return have === need;
  }

  fourClearCombos(seat) {
    const hand = this.hands[seat];
    if (hand.length === 0) return [];
    if (hand.length < 4) return [hand.slice()];
    const scoring = this.handScoring(seat).slice().sort((a, b) => (b.points - a.points) || a.id.localeCompare(b.id));
    if (scoring.length >= 4) {
      const cutoff = scoring[3].points;
      const must = scoring.filter((c) => c.points > cutoff);
      const pool = scoring.filter((c) => c.points === cutoff);
      const need = 4 - must.length;
      return combosOf(pool, need).map((extra) => must.concat(extra));
    }
    const scoringIds = new Set(scoring.map((c) => c.id));
    const mains = this.handMain(seat).filter((c) => !scoringIds.has(c.id));
    const subs = this.handSub(seat).filter((c) => !scoringIds.has(c.id));
    const need = 4 - scoring.length;
    if (mains.length >= need) return combosOf(mains, need).map((extra) => scoring.concat(extra));
    const subNeed = need - mains.length;
    return combosOf(subs, subNeed).map((extra) => scoring.concat(mains, extra));
  }

  responseLegal(cardIds) {
    const t = this.trick;
    if (!t || !t.dimension || t.plays.length === 0) return false;
    if (cardIds.length === 0) return false;
    const cards = cardIds.map((id) => this.cardById(id));
    const handSet = new Set(this.handIds(this.currentSeat));
    if (cardIds.length !== new Set(cardIds).size) return false;
    for (const id of cardIds) if (!handSet.has(id)) return false;
    const dim = t.dimension;
    if (dim === 'single') {
      if (cards.length !== 1) return false;
      return this.singleResponseOk(cards[0], this.cardById(t.plays[0].cardIds[0]));
    }
    if (dim === 'throw') {
      const n = t.plays[0].cardIds.length;
      if (this.hands[this.currentSeat].length < n) return cards.length === this.hands[this.currentSeat].length;
      if (cards.length !== n) return false;
      return this.throwResponseOk(cards);
    }
    if (dim === 'fake_kong') {
      if (sameRank(cards) && cards.length === 4 && !this.hasTributed(cards)) return true;
      if (this.hands[this.currentSeat].length < 4) return cards.length === this.hands[this.currentSeat].length;
      if (cards.length !== 4) return false;
      const handSub = this.handSub(this.currentSeat).length;
      const respSub = cards.filter((c) => !this.isMainOrRevealed(c)).length;
      return handSub >= 4 ? respSub === 4 : respSub === handSub;
    }
    if (dim === 'true_kong') {
      if (cards.length !== Math.min(4, this.hands[this.currentSeat].length)) return false;
      if (cards.length === 4 && sameRank(cards) && this.hasTributed(cards)) return false;
      return true;
    }
    if (dim === 'four_clear') {
      return this.fourClearCombos(this.currentSeat).some((comb) => sameIdSet(cards, comb.map((c) => c.id)));
    }
    return false;
  }

  legalPlays() {
    if (this.phase !== 'trick' || !this.trick) return [];
    const t = this.trick;
    const seat = this.currentSeat;
    const hand = this.hands[seat];
    if (t.plays.length === 0 || t.plays.length === N) {
      const out = [];
      for (const c of hand) out.push({ cardIds: [c.id], dimension: 'single' });
      const qs = hand.filter((c) => c.suit === 'spade' && c.rank === 'Q');
      for (const q of qs) {
        const byRank = {};
        for (const c of hand) if (c.id !== q.id && c.rank !== 'Q') (byRank[c.rank] ||= []).push(c);
        for (const list of Object.values(byRank)) {
          if (list.length < 3) continue;
          for (const three of combosOf(list, 3)) {
            const cards = [q, ...three];
            if (this.hasTributed(cards)) continue;
            out.push({ cardIds: cards.map((c) => c.id), dimension: 'fake_kong' });
          }
        }
      }
      const byRank = {};
      for (const c of hand) (byRank[c.rank] ||= []).push(c);
      for (const list of Object.values(byRank)) {
        if (list.length < 4) continue;
        for (const four of combosOf(list, 4)) {
          if (this.hasTributed(four)) continue;
          const dim = kongDimension6(four);
          if (dim) out.push({ cardIds: four.map((c) => c.id), dimension: dim });
        }
      }
      const cats = {};
      for (const c of hand) { const f = this.suitOf(c); if (f) (cats[f] ||= []).push(c); }
      for (const list of Object.values(cats)) {
        list.sort((a, b) => (this.powerOf(b) - this.powerOf(a)) || a.id.localeCompare(b.id));
        for (let n = 2; n <= list.length; n++) out.push({ cardIds: list.slice(0, n).map((c) => c.id), dimension: 'throw' });
      }
      const mains = this.handMain(seat).slice().sort((a, b) => (this.powerOf(b) - this.powerOf(a)) || a.id.localeCompare(b.id));
      for (let n = 2; n <= mains.length; n++) out.push({ cardIds: mains.slice(0, n).map((c) => c.id), dimension: 'throw' });
      return dedupe(out);
    }
    const dim = t.dimension;
    const out = [];
    if (dim === 'single') {
      const lead = this.cardById(t.plays[0].cardIds[0]);
      for (const c of hand) if (this.singleResponseOk(c, lead)) out.push({ cardIds: [c.id], dimension: 'single' });
    } else if (dim === 'throw') {
      const n = t.plays[0].cardIds.length;
      if (hand.length < n) out.push({ cardIds: hand.map((c) => c.id), dimension: 'throw' });
      else for (const comb of combosOf(hand, n)) if (this.throwResponseOk(comb)) out.push({ cardIds: comb.map((c) => c.id), dimension: 'throw' });
    } else if (dim === 'fake_kong') {
      if (hand.length < 4) out.push({ cardIds: hand.map((c) => c.id), dimension: 'fake_kong' });
      else for (const comb of combosOf(hand, 4)) if (this.responseLegal(comb.map((c) => c.id))) out.push({ cardIds: comb.map((c) => c.id), dimension: 'fake_kong' });
    } else if (dim === 'true_kong') {
      if (hand.length < 4) out.push({ cardIds: hand.map((c) => c.id), dimension: 'true_kong' });
      else {
        for (const comb of combosOf(hand, 4)) {
          const ids = comb.map((c) => c.id);
          if (this.responseLegal(ids)) out.push({ cardIds: ids, dimension: 'true_kong' });
        }
      }
    } else if (dim === 'four_clear') {
      for (const comb of this.fourClearCombos(seat)) out.push({ cardIds: comb.map((c) => c.id), dimension: 'four_clear' });
    }
    return dedupe(out);
  }

  playHints() {
    if (this.phase !== 'trick' || !this.trick) return null;
    const t = this.trick;
    const seat = this.currentSeat;
    if (t.plays.length === 0 || t.plays.length === N) {
      const allowed = new Set();
      for (const p of this.legalPlays()) for (const id of p.cardIds) allowed.add(id);
      return { count: null, allowed: [...allowed], dimension: 'lead' };
    }
    const dim = t.dimension;
    if (dim === 'single') return { count: 1, allowed: this.legalPlays().map((p) => p.cardIds[0]), dimension: 'single' };
    if (dim === 'throw') return { count: t.plays[0].cardIds.length, allowed: [...new Set(this.legalPlays().flatMap((p) => p.cardIds))], dimension: 'throw' };
    if (dim === 'fake_kong') return { count: 4, allowed: [...new Set(this.legalPlays().flatMap((p) => p.cardIds))], dimension: 'fake_kong' };
    if (dim === 'true_kong') return { count: 4, allowed: this.handIds(seat), dimension: 'true_kong' };
    if (dim === 'four_clear') {
      const plays = this.legalPlays();
      return {
        count: Math.min(4, this.hands[seat].length),
        allowed: [...new Set(plays.flatMap((p) => p.cardIds))],
        dimension: 'four_clear',
        auto: plays.length === 1,
      };
    }
    return null;
  }

  _lowestPowerPlayFrom(ids, asLead) {
    const selected = [...new Set(ids)].map((id) => this.cardById(id));
    const compareCards = (a, b) => (this.powerOf(a) - this.powerOf(b)) || a.id.localeCompare(b.id);
    if (asLead) {
      const forced = selected.slice().sort(compareCards)[0];
      return [forced.id];
    }
    const n = Math.min(this.trick.plays[0].cardIds.length, this.hands[this.currentSeat].length);
    let best = null;
    if (selected.length >= n) {
      for (const comb of combosOf(selected, n)) {
        const sorted = comb.slice().sort(compareCards);
        if (!this.responseLegal(sorted.map((c) => c.id))) continue;
        if (!best) { best = sorted; continue; }
        for (let i = 0; i < n; i++) {
          const diff = compareCards(sorted[i], best[i]);
          if (diff < 0) { best = sorted; break; }
          if (diff > 0) break;
        }
      }
    }
    if (best) return best.map((c) => c.id);
    // 跟甩无法从所选牌凑出合法 n 张组合时：在所选牌能组成的合法出法中取牌力最小者
    let bestPlay = null;
    for (const p of this.legalPlays()) {
      if (!p.cardIds.every((id) => ids.includes(id))) continue;
      const cards = p.cardIds.map((id) => this.cardById(id)).sort(compareCards);
      if (!bestPlay) { bestPlay = cards; continue; }
      const m = Math.min(cards.length, bestPlay.length);
      let better = false;
      for (let i = 0; i < m; i++) {
        const diff = compareCards(cards[i], bestPlay[i]);
        if (diff < 0) { better = true; break; }
        if (diff > 0) { better = false; break; }
      }
      if (better || (cards.length === bestPlay.length && false)) bestPlay = cards;
      else if (cards.length < bestPlay.length && cards.every((c, i) => i >= m || compareCards(c, bestPlay[i]) === 0)) bestPlay = cards;
    }
    return bestPlay ? bestPlay.map((c) => c.id) : null;
  }

  play(cardIds) {
    if (this.phase !== 'trick' || !this.trick) throw new Error('BAD_PHASE');
    if (this.trick.plays.length === N) {
      this.trick = { leaderSeat: this.currentSeat, dimension: null, plays: [], winnerSeat: null, pointsWon: 0 };
    }
    const seat = this.currentSeat;
    const ids = cardIds.slice();
    if (!ids.length) throw new Error('请重新选择要出的牌');
    const handSet = new Set(this.handIds(seat));
    for (const id of ids) if (!handSet.has(id)) throw new Error('CARD_NOT_IN_HAND');
    if (this.trick.plays.length === 0) {
      const r = this.leadLegal(ids);
      if (!r.ok) {
        if (r.reason === 'THROW_NOT_TOP' && ids.length > 1) {
          const forced = this._lowestPowerPlayFrom(ids, true);
          this.trick.dimension = 'single';
          this.trick.plays.push({ seat, cardIds: forced });
          this.advance();
          return;
        }
        throw new Error(r.reason || 'BAD_LEAD');
      }
      this.trick.dimension = r.dimension;
    } else {
      if (!this.responseLegal(ids)) {
        if (this.trick.dimension === 'throw' && this.trick.plays[0].cardIds.length > 1) {
          const fallback = this._lowestPowerPlayFrom(ids, false);
          if (fallback) {
            this.trick.plays.push({ seat, cardIds: fallback });
            this.advance();
            return;
          }
          throw new Error('请重新选择要出的牌');
        }
        throw new Error('ILLEGAL_RESPONSE');
      }
    }
    this.trick.plays.push({ seat, cardIds: ids });
    this.advance();
  }

  advance() {
    while (this.trick.plays.length < N) {
      const last = this.trick.plays[this.trick.plays.length - 1];
      const next = ccw(last.seat);
      if (this.hands[next].length === 0) this.trick.plays.push({ seat: next, cardIds: [] });
      else { this.currentSeat = next; return; }
    }
    this.resolveTrick();
  }

  resolveTrick() {
    const t = this.trick;
    const dim = t.dimension;
    const plays = t.plays;
    let winnerSeat;
    if (dim === 'four_clear') winnerSeat = plays[0].seat;
    else if (dim === 'fake_kong' || dim === 'true_kong') winnerSeat = this.resolveKong(plays);
    else if (dim === 'throw') winnerSeat = this.resolveThrow(plays);
    else winnerSeat = this.resolveSingle(plays);
    let pts = 0;
    for (const p of plays) for (const id of p.cardIds) pts += this.cardById(id).points;
    this.scores[this.players[winnerSeat].team] += pts;
    t.winnerSeat = winnerSeat;
    t.pointsWon = pts;
    for (const p of plays) this.hands[p.seat] = this.hands[p.seat].filter((c) => !p.cardIds.includes(c.id));
    this.currentSeat = winnerSeat;
    if (this.hands.every((h) => h.length === 0)) {
      this.finishRound();
      return;
    }
    if (this.hands[winnerSeat].length === 0) {
      let next = ccw(winnerSeat);
      for (let i = 0; i < N && this.hands[next].length === 0; i++) next = ccw(next);
      if (this.hands[next].length > 0) this.currentSeat = next;
    }
  }

  resolveSingle(plays) {
    const lead = this.cardById(plays[0].cardIds[0]);
    const cat = (isChangZhu(lead) || this.isRevealed(lead)) ? 'main' : this.suitOf(lead);
    let best = null;
    plays.forEach((p, i) => {
      if (p.cardIds.length === 0) return;
      const c = this.cardById(p.cardIds[0]);
      let key;
      if (this.isMainOrRevealed(c)) key = 2;
      else if (cat !== 'main' && cat !== null && this.suitOf(c) === cat) key = 1;
      else key = 0;
      const pw = this.powerOf(c);
      if (!best || key > best.key || (key === best.key && pw > best.pw)) best = { i, key, pw };
    });
    return plays[best.i].seat;
  }

  resolveThrow(plays) {
    let best = null;
    plays.forEach((p, i) => {
      if (p.cardIds.length === 0) return;
      let mx = -1;
      for (const id of p.cardIds) mx = Math.max(mx, this.powerOf(this.cardById(id)));
      if (!best || mx > best.mx) best = { i, mx };
    });
    return plays[best.i].seat;
  }

  resolveKong(plays) {
    const kongs = plays.map((p, i) => {
      const cards = p.cardIds.map((id) => this.cardById(id));
      return sameRank(cards) && cards.length === 4 && !this.hasTributed(cards) ? { i, rank: cards[0].rank } : null;
    }).filter(Boolean);
    if (kongs.length === 0) return plays[0].seat;
    let best = kongs[0];
    for (const k of kongs) if (TRUE_KONG_RANK_VALUE[k.rank] > TRUE_KONG_RANK_VALUE[best.rank]) best = k;
    return plays[best.i].seat;
  }

  finishRound() {
    const dealerTeam = this.dealerIndex % 2;
    const x = this.scores[1 - dealerTeam];
    let dealerStay, newDealerIndex, tribute, streak;
    if (x < STAY_THRESHOLD) {
      dealerStay = true;
      streak = this.streak + 1;
      newDealerIndex = streak >= 3 ? (this.dealerIndex + 4) % N : this.dealerIndex;
      if (newDealerIndex !== this.dealerIndex) streak = 0;
      tribute = 'none';
    } else {
      dealerStay = false;
      streak = 0;
      newDealerIndex = ccw(this.dealerIndex);
      tribute = x >= TRIBUTE_THRESHOLD_TRIPLE ? 'triple' : x >= TRIBUTE_THRESHOLD_SINGLE ? 'single' : 'none';
    }
    this.result = {
      scores: this.scores.slice(),
      x,
      dealerStay,
      newDealerIndex,
      tribute,
      streak,
      revealCount: this.revealCount(),
      rebellion: this.revealCount() > 0,
    };
    this.phase = 'round_end';
  }

  state() {
    const hands = this.hands ? this.hands.map((h) => h.slice()) : [];
    const revealCount = this.revealCount();
    return {
      mode: 'p6',
      phase: this.phase,
      roundNo: this.roundNo,
      dealerIndex: this.dealerIndex,
      currentSeat: this.currentSeat,
      streak: this.streak,
      rebellion: revealCount > 0,
      revealCount,
      rebellionLevel: revealCount,
      players: this.players.map((p) => ({ ...p })),
      seats: this.players.map((p) => ({ ...p })),
      productSeats: this.dealerIndex == null ? null : this.players.map((p) => productSeatOf(p.index, this.dealerIndex)),
      hands,
      handCounts: hands.map((h) => h.length),
      bottom: this.bottom ? this.bottom.map((c) => ({ ...c })) : [],
      buriedBy: this.buriedBy,
      autoBury: this.autoBury ? { ...this.autoBury } : null,
      revealed: [...this.revealed.entries()].map(([id, power]) => ({ id, power })),
      reveals: this.reveals.map((r) => ({ ...r, cardIds: r.cardIds.slice() })),
      effectiveReveal: this.effectiveReveal ? { ...this.effectiveReveal, cardIds: this.effectiveReveal.cardIds.slice() } : null,
      tributed: [...this.tributed],
      tributePlan: this.tributePlan,
      tributeState: this.tributeState ? JSON.parse(JSON.stringify(this.tributeState)) : null,
      lastGive: this.lastGive ? { ...this.lastGive } : null,
      scores: this.scores.slice(),
      redealCount: this.redealCount,
      trick: this.trick ? {
        leaderSeat: this.trick.leaderSeat,
        dimension: this.trick.dimension,
        plays: this.trick.plays.map((p) => ({
          seat: p.seat,
          cardIds: p.cardIds.slice(),
          cards: p.cardIds.map((id) => ({ ...this.cardById(id) })),
        })),
        winnerSeat: this.trick.winnerSeat,
        pointsWon: this.trick.pointsWon || 0,
      } : null,
      result: this.result ? { ...this.result, scores: this.result.scores.slice() } : null,
      revealOrder: this.revealOrder ? this.revealOrder.slice() : null,
      revealIdx: this.revealIdx,
    };
  }
}

export function newGame6(names, rng) { return new Game6(names, rng); }

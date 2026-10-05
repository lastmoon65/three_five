// game/game.mjs — 《红心对决》规则引擎 V8.3 单机版实现
// 纯 ES Module，无 DOM、无 Node 内置模块依赖，浏览器与 Node 均可 import。

const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const SUITS = ['spade','heart','club','diamond'];
const POINT_MAP = { '5':5, '10':10, 'K':10 };
export const RANK_VALUE = { '3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14,'2':15 };
const HEART_MAIN_POWER = { A:214,K:213,Q:212,'10':210,'9':209,'8':208,'7':207,'6':206,'5':205,'4':204,'3':203 };
const SUB_POWER = { A:114,K:113,Q:112,'10':110,'9':109,'8':108,'7':107,'6':106,'5':105,'4':104,'3':103 };

export function basePower(suit, rank) {
  if (suit === 'joker') return rank === 'big' ? 799 : 798;
  if (suit === 'diamond' && rank === '5') return 1000;
  if (suit === 'spade' && rank === 'Q') return 699;
  if (rank === 'J') return suit === 'heart' ? 599 : 598;
  if (rank === '2') return suit === 'heart' ? 589 : 588;
  if (suit === 'heart') return HEART_MAIN_POWER[rank];
  return SUB_POWER[rank];
}

export function createDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ id:`${suit}_${rank}`, suit, rank, power:basePower(suit, rank), points:POINT_MAP[rank] || 0 });
  deck.push({ id:'joker_big', suit:'joker', rank:'big', power:799, points:0 });
  deck.push({ id:'joker_small', suit:'joker', rank:'small', power:798, points:0 });
  return deck;
}

export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// 常主：方块5、大小王、黑桃Q、四个J、四个2
export function isChangZhu(c) {
  if (c.suit === 'joker') return true;
  if (c.suit === 'diamond' && c.rank === '5') return true;
  if (c.suit === 'spade' && c.rank === 'Q') return true;
  if (c.rank === 'J' || c.rank === '2') return true;
  return false;
}

// 主牌 = 常主 + 红桃（含亮出的三五反）
export function isMain(c) { return isChangZhu(c) || c.suit === 'heart'; }

// 按花色走的牌：红桃主花色（非常主）与各花色副牌（非常主）；常主返回 null
export function followSuit(c) {
  if (isChangZhu(c)) return null;
  if (c.suit === 'heart') return 'heart';
  return c.suit;
}

export function sameRank(cards) { return cards.length > 0 && cards.every(c => c.rank === cards[0].rank); }

export function newGame(names, rng) { return new Game(names, rng); }

export class Game {
  constructor(names, rng) {
    this.names = names.slice(0, 4);
    this.rng = rng || Math.random;
    this.players = this.names.map((name, i) => ({ index:i, name, team:i % 2 }));
    this.cardMap = new Map(createDeck().map(c => [c.id, c]));
    this.roundNo = 0;
    this.dealerIndex = null;
    this.streak = 0;
    this.phase = 'idle';
    this.hands = null;
    this.bottom = null;
    this.buriedBy = null;
    this.revealed = new Map();
    this.effectiveReveal = null;
    this.tributePlan = 'none';
    this.tributeState = null;
    this.scores = [0, 0];
    this.trick = null;
    this.currentSeat = null;
    this.revealOrder = null;
    this.revealDone = null;
    this.revealCards = new Map();
    this.revealIdx = 0;
    this.result = null;
    this.rebellion = false;
    this.lastGive = null;
    this.tributed = new Set();
    this.autoBury = null;
  }

  startRound() {
    if (this.roundNo === 0) {
      this.dealerIndex = Math.floor(this.rng() * 4);
      this.streak = 0;
    } else if (this.result) {
      this.dealerIndex = this.result.newDealerIndex;
      this.streak = this.result.streak;
    }
    this.roundNo++;
    this.tributePlan = this.result ? this.result.tribute : 'none';
    const deck = shuffle([...this.cardMap.values()], this.rng);
    this.hands = [[], [], [], []];
    for (let i = 0; i < 4; i++) this.hands[i] = deck.slice(i * 12, i * 12 + 12);
    this.bottom = deck.slice(48, 54);
    this.revealed = new Map();
    this.effectiveReveal = null;
    this.tributeState = null;
    this.scores = [0, 0];
    this.trick = null;
    this.result = null;
    this.rebellion = false;
    this.lastGive = null;
    this.tributed = new Set();
    this.autoBury = null;
    this.buriedBy = null;
    this.phase = 'reveal';
    this.revealDone = [false, false, false, false];
    this.revealOrder = null;
    this.revealIdx = 0;
    this.currentSeat = this.dealerIndex;
  }

  nextRound() {
    if (this.phase !== 'round_end') throw new Error('NOT_ROUND_END');
    this.startRound();
  }

  roundResult() { return this.result; }

  // ---------- 工具 ----------
  cardById(id) {
    const c = this.cardMap.get(id);
    if (!c) throw new Error('CARD_NOT_FOUND:' + id);
    return c;
  }
  powerOf(c) { return this.revealed.get(c.id) ?? c.power; }
  isRevealed(c) { return this.revealed.has(c.id); }
  handIds(seat) { return this.hands[seat].map(c => c.id); }
  handMain(seat) { return this.hands[seat].filter(c => isMain(c) || this.isRevealed(c)); }
  handScoring(seat) { return this.hands[seat].filter(c => c.points > 0); }
  handSub(seat) { return this.hands[seat].filter(c => !(isMain(c) || this.isRevealed(c))); }
  // 有效花色：常主与已亮番的三五反都按主牌走（不按原花色），其余按花色
  suitOf(c) { return (isChangZhu(c) || this.isRevealed(c)) ? null : followSuit(c); }
  handFollow(seat, cat) { return this.hands[seat].filter(c => this.suitOf(c) === cat); }

  // 贡牌（进贡/退贡交换的牌）不得组成真杠/假杠/四清
  isKongable(cards) {
    return cards.length === 4 && sameRank(cards) && !cards.some(c => this.tributed.has(c.id));
  }

  // ---------- 亮牌（同时进行：每人可同时亮/不亮，全部提交后结算；庄家可在无人亮牌时于埋底补亮） ----------
  legalReveals(seat) {
    if (seat == null) seat = this.dealerIndex;
    const allow = (this.phase === 'reveal' && !this.revealDone[seat])
      || (this.phase === 'bury' && seat === this.dealerIndex && !this.effectiveReveal);
    if (!allow) return [];
    const hand = this.hands[seat];
    const byRank = {};
    for (const c of hand) (byRank[c.rank] ||= []).push(c);
    const out = [];
    if ((byRank['5'] || []).length >= 3) out.push({ cardIds: byRank['5'].slice(0, 3).map(c => c.id), level: 'wu' });
    if ((byRank['3'] || []).length >= 3) out.push({ cardIds: byRank['3'].slice(0, 3).map(c => c.id), level: 'san' });
    return out;
  }

  reveal(seat, cardIds) {
    if (this.phase !== 'reveal') throw new Error('BAD_PHASE');
    if (this.revealDone[seat]) throw new Error('REVEAL_ALREADY_DONE');
    if (cardIds !== null && cardIds !== undefined) {
      if (!Array.isArray(cardIds) || cardIds.length !== 3) throw new Error('REVEAL_NEED_3');
      const handSet = new Set(this.handIds(seat));
      for (const id of cardIds) if (!handSet.has(id)) throw new Error('CARD_NOT_IN_HAND');
      const cards = cardIds.map(id => this.cardById(id));
      if (!cards.every(c => c.rank === cards[0].rank)) throw new Error('REVEAL_SAME_RANK');
      const level = cards[0].rank === '5' ? 'wu' : cards[0].rank === '3' ? 'san' : null;
      if (!level) throw new Error('REVEAL_RANK_35');
      if (level === 'wu') {
        if (this.effectiveReveal && this.effectiveReveal.level === 'wu') throw new Error('REVEAL_WU_TAKEN');
        this.effectiveReveal = { seat, level, cardIds: cardIds.slice() };
        for (const c of cards) this.revealed.set(c.id, c.rank === '5' && c.suit === 'diamond' ? 1000 : 998);
      } else {
        if (this.effectiveReveal) throw new Error('REVEAL_SAN_BLOCKED');
        this.effectiveReveal = { seat, level, cardIds: cardIds.slice() };
        for (const c of cards) this.revealed.set(c.id, 996);
      }
      this.revealCards.set(seat, cardIds.slice());
    }
    this.revealDone[seat] = true;
    if (this.revealDone.every(Boolean)) {
      this.rebellion = !!(this.effectiveReveal && this.players[this.effectiveReveal.seat].team !== this.players[this.dealerIndex].team);
      if (this.rebellion) this.tributePlan = 'none';
      if (this.tributePlan === 'none') this.enterBury();
      else this.enterTribute();
    }
  }

  // 庄家埋底补亮：仅当亮牌阶段无人亮牌（含庄家）时可用；庄家方亮番无造反效果
  buryReveal(cardIds) {
    if (this.phase !== 'bury') throw new Error('BAD_PHASE');
    const seat = this.dealerIndex;
    if (this.effectiveReveal) throw new Error('REVEAL_AFTER_OTHERS');
    if (!Array.isArray(cardIds) || cardIds.length !== 3) throw new Error('REVEAL_NEED_3');
    const handSet = new Set(this.handIds(seat));
    for (const id of cardIds) if (!handSet.has(id)) throw new Error('CARD_NOT_IN_HAND');
    const cards = cardIds.map(id => this.cardById(id));
    if (!cards.every(c => c.rank === cards[0].rank)) throw new Error('REVEAL_SAME_RANK');
    const level = cards[0].rank === '5' ? 'wu' : cards[0].rank === '3' ? 'san' : null;
    if (!level) throw new Error('REVEAL_RANK_35');
    if (level === 'wu') {
      this.effectiveReveal = { seat, level, cardIds: cardIds.slice() };
      for (const c of cards) this.revealed.set(c.id, c.rank === '5' && c.suit === 'diamond' ? 1000 : 998);
    } else {
      this.effectiveReveal = { seat, level, cardIds: cardIds.slice() };
      for (const c of cards) this.revealed.set(c.id, 996);
    }
    this.revealCards.set(seat, cardIds.slice());
    // 庄家方亮番不造反，阶段停留在埋底，由庄家继续选牌扣底
  }
  enterTribute() {
    this.phase = 'tribute';
    const d = this.dealerIndex;
    const mate = (d + 2) % 4;
    const takerOrder = [0, 1, 2, 3].filter(s => this.players[s].team !== this.players[d].team)
      .sort((a, b) => ((d - a + 4) % 4) - ((d - b + 4) % 4));
    const pairs = this.tributePlan === 'double'
      ? [{ giver:d, taker:takerOrder[0] }, { giver:mate, taker:takerOrder[1] }]
      : [{ giver:d, taker:takerOrder[0] }];
    this.tributeState = { pairs, pairIdx: 0, step: 'give' };
    this.currentSeat = pairs[0].giver;
  }

  tributeGive() {
    if (this.phase !== 'tribute' || !this.tributeState) throw new Error('BAD_PHASE');
    const st = this.tributeState;
    if (st.step !== 'give') throw new Error('NOT_GIVE_STEP');
    const p = st.pairs[st.pairIdx];
    if (this.currentSeat !== p.giver) throw new Error('NOT_YOUR_TURN');
    const hand = this.hands[p.giver];
    let best = hand[0];
    for (const c of hand) if (this.powerOf(c) > this.powerOf(best)) best = c;
    this.hands[p.giver] = hand.filter(c => c !== best);
    this.hands[p.taker].push(best);
    this.tributed.add(best.id);
    this.lastGive = { from: p.giver, to: p.taker, cardId: best.id };
    st.step = 'take';
    this.currentSeat = p.taker;
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
    if (mains.length > 0 && !(isMain(card) || this.isRevealed(card))) throw new Error('NEED_MAIN_CARD');
    this.hands[p.taker] = this.hands[p.taker].filter(c => c !== card);
    this.hands[p.giver].push(card);
    this.tributed.add(card.id);
    st.pairIdx++;
    if (st.pairIdx >= st.pairs.length) this.enterBury();
    else { st.step = 'give'; this.currentSeat = st.pairs[st.pairIdx].giver; }
  }

  // ---------- 埋底 ----------
  enterBury() {
    this.phase = 'bury';
    this.currentSeat = this.dealerIndex;
    this.hands[this.dealerIndex] = this.hands[this.dealerIndex].concat(this.bottom);
    this.bottom = [];
    const scoring = this.handScoring(this.dealerIndex);
    if (scoring.length >= 7) {
      const sorted = this.hands[this.dealerIndex].slice().sort((a, b) => (a.points - b.points) || (this.powerOf(a) - this.powerOf(b)) || a.id.localeCompare(b.id));
      const pick = sorted.slice(0, 6);
      const bottomPts = pick.reduce((s, c) => s + c.points, 0);
      this.bottom = pick;
      this.buriedBy = 'auto';
      this.hands[this.dealerIndex] = this.hands[this.dealerIndex].filter(c => !pick.includes(c));
      this.scores[this.dealerIndex % 2] += bottomPts;
      this.autoBury = { cardIds: pick.map(c => c.id), points: bottomPts };
      this.startTrick(this.dealerIndex);
    }
  }

  bury(cardIds) {
    if (this.phase !== 'bury') throw new Error('BAD_PHASE');
    if (this.currentSeat !== this.dealerIndex) throw new Error('NOT_YOUR_TURN');
    if (!Array.isArray(cardIds) || cardIds.length !== 6 || new Set(cardIds).size !== 6) throw new Error('BURY_NEED_6');
    const cards = cardIds.map(id => this.cardById(id));
    if (cards.some(c => c.points > 0)) throw new Error('BURY_NO_POINTS');
    this.bottom = cards;
    this.buriedBy = 'manual';
    this.hands[this.dealerIndex] = this.hands[this.dealerIndex].filter(c => !cards.includes(c));
    this.startTrick(this.dealerIndex);
  }

  // ---------- 打牌 ----------
  startTrick(leader) {
    this.phase = 'trick';
    this.trick = { leaderSeat: leader, dimension: null, plays: [], winnerSeat: null, pointsWon: 0 };
    this.currentSeat = leader;
  }

  leadLegal(cardIds) {
    const cards = cardIds.map(id => this.cardById(id));
    const n = cards.length;
    if (n === 1) return { ok: true, dimension: 'single' };
    if (n === 4 && this.isKongable(cards)) return { ok: true, dimension: cards[0].rank === '4' ? 'four_clear' : 'true_kong' };
    if (n === 4) {
      const q = cards.find(c => c.id === 'spade_Q');
      if (q && !this.tributed.has(q.id)) {
        const rest = cards.filter(c => c.id !== 'spade_Q');
        if (rest.length === 3 && sameRank(rest) && !rest.some(c => this.tributed.has(c.id))) return { ok: true, dimension: 'fake_kong' };
      }
      return { ok: false, reason: 'BAD_LEAD' };
    }
    const follow = this.suitOf(cards[0]);
    if (follow !== null && cards.every(c => this.suitOf(c) === follow)) {
      if (this.isTopNofFollow(this.currentSeat, cards, follow)) return { ok: true, dimension: 'throw' };
      return { ok: false, reason: 'THROW_NOT_TOP' };
    }
    if (cards.every(c => isMain(c) || this.isRevealed(c))) {
      if (this.isTopNofMain(this.currentSeat, cards)) return { ok: true, dimension: 'throw' };
      return { ok: false, reason: 'THROW_NOT_TOP' };
    }
    return { ok: false, reason: 'BAD_LEAD' };
  }

  isTopNofFollow(seat, cards, cat) {
    const sorted = this.handFollow(seat, cat).slice().sort((a, b) => (this.powerOf(b) - this.powerOf(a)) || a.id.localeCompare(b.id));
    const prefix = sorted.slice(0, cards.length).map(c => c.id).sort();
    return JSON.stringify(cards.map(c => c.id).sort()) === JSON.stringify(prefix);
  }

  isTopNofMain(seat, cards) {
    const sorted = this.handMain(seat).slice().sort((a, b) => (this.powerOf(b) - this.powerOf(a)) || a.id.localeCompare(b.id));
    const prefix = sorted.slice(0, cards.length).map(c => c.id).sort();
    return JSON.stringify(cards.map(c => c.id).sort()) === JSON.stringify(prefix);
  }
  responseLegal(cardIds) {
    const t = this.trick;
    if (!t || !t.dimension || t.plays.length === 0) return false;
    if (cardIds.length === 0) return false;
    const cards = cardIds.map(id => this.cardById(id));
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
      if (sameRank(cards) && !cards.some(c => this.tributed.has(c.id))) return true;
      if (this.hands[this.currentSeat].length < 4) return cards.length === this.hands[this.currentSeat].length;
      if (cards.length !== 4) return false;
      const handSub = this.handSub(this.currentSeat).length;
      const respSub = cards.filter(c => !(isMain(c) || this.isRevealed(c))).length;
      return handSub >= 4 ? respSub === 4 : respSub === handSub;
    }
    if (dim === 'true_kong') return cards.length === Math.min(4, this.hands[this.currentSeat].length);
    if (dim === 'four_clear') {
      // 四清响应固定 4 张（手牌不足则全出），必须包含分值最高的牌（10/K 先于 5）
      const need = Math.min(4, this.hands[this.currentSeat].length);
      if (cards.length !== need) return false;
      const scoring = this.handScoring(this.currentSeat).slice().sort((a, b) => (b.points - a.points) || (b.power - a.power) || a.id.localeCompare(b.id));
      const required = scoring.slice(0, Math.min(4, scoring.length)).map((c) => c.id);
      return required.every((id) => cardIds.includes(id));
    }
    return false;
  }

  singleResponseOk(card, lead) {
    const cat = (isMain(lead) || this.isRevealed(lead)) ? 'main' : followSuit(lead); // 红桃主花色/已亮番：按主牌处理
    if (cat === 'main') {
      if (this.handMain(this.currentSeat).length > 0) return isMain(card) || this.isRevealed(card);
      return true;
    }
    if (this.handFollow(this.currentSeat, cat).length > 0) return this.suitOf(card) === cat;
    return true;
  }

  throwResponseOk(cards) {
    const leadCards = this.trick.plays[0].cardIds.map(id => this.cardById(id));
    const leadFollow = this.suitOf(leadCards[0]);
    const isSuitThrow = leadFollow !== null && leadCards.every(c => this.suitOf(c) === leadFollow);
    const isMainThrow = !isSuitThrow && leadCards.every(c => isMain(c) || this.isRevealed(c));
    if (isMainThrow) {
      const need = Math.min(this.handMain(this.currentSeat).length, cards.length);
      const have = cards.filter(c => isMain(c) || this.isRevealed(c)).length;
      return have === need;
    }
    const need = Math.min(this.handFollow(this.currentSeat, leadFollow).length, cards.length);
    const have = cards.filter(c => this.suitOf(c) === leadFollow).length;
    return have === need;
  }

  legalPlays() {
    if (this.phase !== 'trick' || !this.trick) return [];
    const t = this.trick;
    const seat = this.currentSeat;
    const hand = this.hands[seat];
    if (t.plays.length === 0 || t.plays.length === 4) {
      const out = [];
      for (const c of hand) out.push({ cardIds: [c.id], dimension: 'single' });
      const cats = {};
      for (const c of hand) { const f = this.suitOf(c); if (f) (cats[f] ||= []).push(c); }
      for (const list of Object.values(cats)) {
        list.sort((a, b) => (this.powerOf(b) - this.powerOf(a)) || a.id.localeCompare(b.id));
        for (let n = 2; n <= list.length; n++) out.push({ cardIds: list.slice(0, n).map(c => c.id), dimension: 'throw' });
      }
      const mains = this.handMain(seat).slice().sort((a, b) => (this.powerOf(b) - this.powerOf(a)) || a.id.localeCompare(b.id));
      for (let n = 2; n <= mains.length; n++) out.push({ cardIds: mains.slice(0, n).map(c => c.id), dimension: 'throw' });
      const q = hand.find(c => c.id === 'spade_Q');
      if (q && !this.tributed.has(q.id)) {
        const byRank = {};
        for (const c of hand) if (c.id !== 'spade_Q' && !this.tributed.has(c.id)) (byRank[c.rank] ||= []).push(c);
        for (const list of Object.values(byRank)) {
          if (list.length < 3) continue;
          for (const three of combosOf(list, 3)) out.push({ cardIds: [q.id, ...three.map(c => c.id)], dimension: 'fake_kong' });
        }
      }
      const byRank = {};
      for (const c of hand) (byRank[c.rank] ||= []).push(c);
      for (const list of Object.values(byRank)) {
        if (list.length === 4 && !list.some(c => this.tributed.has(c.id))) out.push({ cardIds: list.map(c => c.id), dimension: list[0].rank === '4' ? 'four_clear' : 'true_kong' });
      }
      return dedupe(out);
    }
    const dim = t.dimension;
    const out = [];
    if (dim === 'single') {
      const lead = this.cardById(t.plays[0].cardIds[0]);
      for (const c of hand) if (this.singleResponseOk(c, lead)) out.push({ cardIds: [c.id], dimension: 'single' });
    } else if (dim === 'throw') {
      const n = t.plays[0].cardIds.length;
      if (hand.length < n) out.push({ cardIds: hand.map(c => c.id), dimension: 'throw' });
      else for (const comb of combosOf(hand, n)) if (this.throwResponseOk(comb)) out.push({ cardIds: comb.map(c => c.id), dimension: 'throw' });
    } else if (dim === 'fake_kong') {
      if (hand.length < 4) out.push({ cardIds: hand.map(c => c.id), dimension: 'fake_kong' });
      else for (const comb of combosOf(hand, 4)) if (this.responseLegal(comb.map(c => c.id))) out.push({ cardIds: comb.map(c => c.id), dimension: 'fake_kong' });
    } else if (dim === 'true_kong') {
      if (hand.length < 4) out.push({ cardIds: hand.map(c => c.id), dimension: 'true_kong' });
      else for (const comb of combosOf(hand, 4)) out.push({ cardIds: comb.map(c => c.id), dimension: 'true_kong' });
    } else if (dim === 'four_clear') {
      const hand = this.hands[seat];
      const scoring = this.handScoring(seat).slice().sort((a, b) => (b.points - a.points) || (b.power - a.power) || a.id.localeCompare(b.id));
      const need = Math.min(4, hand.length);
      const ids = scoring.slice(0, Math.min(4, scoring.length)).map((c) => c.id);
      for (const c of hand) { if (ids.length >= need) break; if (!ids.includes(c.id)) ids.push(c.id); }
      out.push({ cardIds: ids, dimension: 'four_clear' });
    }
    return dedupe(out);
  }

  playHints() {
    if (this.phase !== 'trick' || !this.trick) return null;
    const t = this.trick;
    const seat = this.currentSeat;
    if (t.plays.length === 0 || t.plays.length === 4) {
      const allowed = new Set();
      for (const p of this.legalPlays()) for (const id of p.cardIds) allowed.add(id);
      return { count: null, allowed: [...allowed], dimension: 'lead' };
    }
    const dim = t.dimension;
    if (dim === 'single') return { count: 1, allowed: this.legalPlays().map(p => p.cardIds[0]), dimension: 'single' };
    if (dim === 'throw') return { count: t.plays[0].cardIds.length, allowed: [...new Set(this.legalPlays().flatMap(p => p.cardIds))], dimension: 'throw' };
    if (dim === 'fake_kong') return { count: 4, allowed: [...new Set(this.legalPlays().flatMap(p => p.cardIds))], dimension: 'fake_kong' };
    if (dim === 'true_kong') return { count: 4, allowed: this.handIds(seat), dimension: 'true_kong' };
    if (dim === 'four_clear') {
      const hand = this.hands[seat];
      const scoring = this.handScoring(seat).slice().sort((a, b) => (b.points - a.points) || (b.power - a.power) || a.id.localeCompare(b.id));
      const need = Math.min(4, hand.length);
      const ids = scoring.slice(0, Math.min(4, scoring.length)).map((c) => c.id);
      for (const c of hand) { if (ids.length >= need) break; if (!ids.includes(c.id)) ids.push(c.id); }
      return { count: 4, allowed: ids, dimension: 'four_clear', auto: true };
    }
    return null;
  }

  play(cardIds) {
    if (this.phase !== 'trick' || !this.trick) throw new Error('BAD_PHASE');
    if (!Array.isArray(cardIds) || cardIds.length === 0) throw new Error('BAD_PLAY');
    if (this.trick.plays.length === 4) {
      this.trick = { leaderSeat: this.currentSeat, dimension: null, plays: [], winnerSeat: null, pointsWon: 0 };
    }
    const seat = this.currentSeat;
    const ids = cardIds.slice();
    const handSet = new Set(this.handIds(seat));
    for (const id of ids) if (!handSet.has(id)) throw new Error('CARD_NOT_IN_HAND');
    if (this.trick.plays.length === 0) {
      const r = this.leadLegal(ids);
      if (!r.ok) throw new Error(r.reason || 'BAD_LEAD');
      this.trick.dimension = r.dimension;
    } else {
      if (!this.responseLegal(ids)) throw new Error('ILLEGAL_RESPONSE');
    }
    this.trick.plays.push({ seat, cardIds: ids });
    this.advance();
  }

  advance() {
    while (this.trick.plays.length < 4) {
      const last = this.trick.plays[this.trick.plays.length - 1];
      const next = (last.seat + 3) % 4;
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
    this.scores[winnerSeat % 2] += pts;
    t.winnerSeat = winnerSeat;
    t.pointsWon = pts;
    for (const p of plays) this.hands[p.seat] = this.hands[p.seat].filter(c => !p.cardIds.includes(c.id));
    this.currentSeat = winnerSeat;
    if (this.hands.every(h => h.length === 0)) this.finishRound();
  }

  resolveSingle(plays) {
    const lead = this.cardById(plays[0].cardIds[0]);
    const cat = (isMain(lead) || this.isRevealed(lead)) ? 'main' : followSuit(lead); // 红桃主花色/已亮番：按主牌处理
    let best = null;
    plays.forEach((p, i) => {
      if (p.cardIds.length === 0) return;
      const c = this.cardById(p.cardIds[0]);
      let key;
      if (isMain(c) || this.isRevealed(c)) key = 2;
      else if (cat !== 'main' && this.suitOf(c) === cat) key = 1;
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
      const cards = p.cardIds.map(id => this.cardById(id));
      return this.isKongable(cards) ? { i, rank: cards[0].rank } : null;
    }).filter(Boolean);
    if (kongs.length === 0) return plays[0].seat;
    let best = kongs[0];
    for (const k of kongs) if (RANK_VALUE[k.rank] > RANK_VALUE[best.rank]) best = k;
    return plays[best.i].seat;
  }

  finishRound() {
    const dealerTeam = this.dealerIndex % 2;
    const x = this.scores[1 - dealerTeam];
    let dealerStay, newDealerIndex, tribute, streak;
    if (x < 40) {
      dealerStay = true;
      streak = this.streak + 1;
      newDealerIndex = streak >= 3 ? (this.dealerIndex + 2) % 4 : this.dealerIndex;
      if (newDealerIndex !== this.dealerIndex) streak = 0;
      tribute = 'none';
    } else {
      dealerStay = false;
      streak = 0;
      newDealerIndex = (this.dealerIndex + 3) % 4;
      tribute = x >= 80 ? 'double' : x >= 60 ? 'single' : 'none';
    }
    this.result = {
      scores: this.scores.slice(),
      x,
      dealerStay,
      newDealerIndex,
      tribute,
      streak,
      rebellion: this.rebellion,
    };
    this.phase = 'round_end';
  }

  state() {
    const hands = this.hands.map(h => h.slice());
    return {
      phase: this.phase,
      roundNo: this.roundNo,
      dealerIndex: this.dealerIndex,
      currentSeat: this.currentSeat,
      streak: this.streak,
      rebellion: this.rebellion,
      players: this.players.map(p => ({ ...p })),
      seats: this.players.map(p => ({ ...p })),
      hands,
      handCounts: hands.map(h => h.length),
      bottom: this.bottom ? this.bottom.map(c => ({ ...c })) : [],
      buriedBy: this.buriedBy,
      autoBury: this.autoBury ? { ...this.autoBury } : null,
      revealed: [...this.revealed.entries()].map(([id, power]) => ({ id, power })),
      effectiveReveal: this.effectiveReveal ? { ...this.effectiveReveal, cardIds: this.effectiveReveal.cardIds.slice() } : null,
      tributePlan: this.tributePlan,
      tributeState: this.tributeState ? JSON.parse(JSON.stringify(this.tributeState)) : null,
      lastGive: this.lastGive ? { ...this.lastGive } : null,
      scores: this.scores.slice(),
      trick: this.trick ? {
        leaderSeat: this.trick.leaderSeat,
        dimension: this.trick.dimension,
        plays: this.trick.plays.map(p => ({ seat: p.seat, cardIds: p.cardIds.slice(), cards: p.cardIds.map(id => ({ ...this.cardById(id) })) })),
        winnerSeat: this.trick.winnerSeat,
        pointsWon: this.trick.pointsWon || 0,
      } : null,
      result: this.result ? { ...this.result, scores: this.result.scores.slice() } : null,
      revealOrder: this.revealOrder ? this.revealOrder.slice() : null,
      revealIdx: this.revealIdx,
      revealDone: this.revealDone ? this.revealDone.slice() : null,
      revealCards: Object.fromEntries(this.revealCards),
    };
  }
}

export function combosOf(arr, k) {
  const out = [];
  if (k < 0 || k > arr.length) return out;
  const idx = [];
  for (let i = 0; i < k; i++) idx.push(i);
  while (true) {
    out.push(idx.map(i => arr[i]));
    let p = k - 1;
    while (p >= 0 && idx[p] === arr.length - k + p) p--;
    if (p < 0) break;
    idx[p]++;
    for (let q = p + 1; q < k; q++) idx[q] = idx[q - 1] + 1;
  }
  return out;
}

export function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.cardIds.slice().sort().join(',');
    if (!seen.has(key)) { seen.add(key); out.push(item); }
  }
  return out;
}
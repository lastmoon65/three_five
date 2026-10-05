// test/reveal-suit.test.mjs — 亮番后的花色归属（规则 V8.3 §4.2：亮出后本副视为主牌）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../game/game.mjs';

function rngOf(seed) { return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648; }

function craft(seed = 7) {
  const g = new Game(['甲', '乙', '丙', '丁'], rngOf(seed));
  g.startRound();
  return g;
}

function setHands(g, hands) {
  g.hands = hands.map((ids) => ids.map((id) => g.cardById(id)));
  g.bottom = [];
}

// 座位 seat 亮五反（♣5 ♠5 ♥5）
function revealWu(g, seat) {
  for (const id of ['club_5', 'spade_5', 'heart_5']) g.revealed.set(id, 998);
  g.effectiveReveal = { seat, level: 'wu', cardIds: ['club_5', 'spade_5', 'heart_5'] };
}

function startTrick(g, { lead, leadCards, current, dimension }) {
  g.phase = 'trick';
  g.trick = { leaderSeat: lead, dimension: dimension || (leadCards.length > 1 ? 'throw' : 'single'), plays: [{ seat: lead, cardIds: leadCards }], winnerSeat: null, pointsWon: 0 };
  g.currentSeat = current;
}

const key = (ids) => [...ids].sort().join(',');

test('亮五反后 ♣5 视为主牌：别人领梅花时不再被强制出 ♣5', () => {
  const g = craft();
  setHands(g, [['club_9', 'club_8'], ['club_5', 'spade_K', 'diamond_7'], ['club_A', 'club_K'], ['club_J', 'heart_3']]);
  revealWu(g, 1);
  startTrick(g, { lead: 0, leadCards: ['club_9'], current: 1 });
  const legal = g.legalPlays().map((p) => p.cardIds[0]);
  assert.deepEqual(legal.slice().sort(), ['club_5', 'diamond_7', 'spade_K'].sort(), '手里没有其他梅花时，三张都可以出');
  assert.ok(legal.includes('spade_K'), '可以出非梅花（亮番的 ♣5 已算主牌，不构成梅花）');
});

test('手里还有真梅花时仍必须跟梅花，亮番的 ♣5 不能顶替', () => {
  const g = craft();
  setHands(g, [['club_9', 'club_8'], ['club_5', 'club_K', 'spade_7'], ['club_A', 'club_K'], ['club_J', 'heart_3']]);
  revealWu(g, 1);
  startTrick(g, { lead: 0, leadCards: ['club_9'], current: 1 });
  const legal = g.legalPlays().map((p) => p.cardIds[0]);
  assert.deepEqual(legal, ['club_K'], '只能出真正的梅花 ♣K');
  assert.equal(g.responseLegal(['club_5']), false, '亮番的 ♣5 不能用来跟梅花');
  assert.equal(g.responseLegal(['club_K']), true);
});

test('梅花甩牌响应：亮番的 ♣5 不计入梅花张数', () => {
  const g = craft();
  setHands(g, [['club_9', 'club_8'], ['club_5', 'spade_7', 'diamond_3'], ['club_A', 'club_K'], ['club_J', 'heart_3']]);
  revealWu(g, 1);
  startTrick(g, { lead: 0, leadCards: ['club_9', 'club_8'], current: 1 });
  const legal = g.legalPlays().map((p) => key(p.cardIds));
  assert.ok(legal.includes(key(['spade_7', 'diamond_3'])), '手里没有梅花（♣5 已算主牌），可以随便出两张');
  assert.equal(g.responseLegal(['spade_7', 'diamond_3']), true);
});

test('已亮番的牌不能组成花色甩，只能作为主牌甩', () => {
  const g = craft();
  revealWu(g, 0);
  setHands(g, [['club_5', 'club_K', 'heart_9', 'spade_7'], ['club_A', 'club_K'], ['club_J', 'heart_3'], ['club_Q', 'heart_4']]);
  g.phase = 'trick';
  g.trick = { leaderSeat: 0, dimension: null, plays: [], winnerSeat: null, pointsWon: 0 };
  g.currentSeat = 0;
  assert.equal(g.leadLegal(['club_5', 'club_K']).ok, false, '♣5 是主牌、♣K 是梅花 → 混合甩牌非法');
  const r = g.leadLegal(['club_5', 'heart_9']);
  assert.equal(r.ok, true, '两张主牌可以甩');
  assert.equal(r.dimension, 'throw');
});

test('6 人模式同样规则：亮番后不按原花色跟随', async () => {
  const { Game6 } = await import('../game/game6.mjs');
  const g = new Game6(['甲', '乙', '丙', '丁', '戊', '己'], rngOf(11));
  g.startRound();
  g.hands = [[], [], [], [], [], []];
  g.hands[1] = [g.cardById('club_5_1'), g.cardById('spade_K_1'), g.cardById('diamond_7_1')];
  g.revealed.set(g.hands[1][0].id, 998);
  g.phase = 'trick';
  g.trick = { leaderSeat: 0, dimension: 'single', plays: [{ seat: 0, cardIds: [g.cardById('club_9_1').id] }], winnerSeat: null, pointsWon: 0 };
  g.currentSeat = 1;
  const legal = g.legalPlays().map((p) => p.cardIds[0]);
  assert.equal(legal.length, 3, '没有其他梅花时三张都能出（亮番的 ♣5 算主牌）');
});
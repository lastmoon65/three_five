// test/throw-reveal.test.mjs — 甩牌"最大性"校验 + 每副亮牌记录重置
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../game/game.mjs';

function rngOf(seed) { return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648; }
function craft(seed = 3) {
  const g = new Game(['甲', '乙', '丙', '丁'], rngOf(seed));
  g.startRound();
  return g;
}
function setHands(g, hands) { g.hands = hands.map((ids) => ids.map((id) => g.cardById(id))); g.bottom = []; }
function leadAt(g, seat) {
  g.phase = 'trick';
  g.trick = { leaderSeat: seat, dimension: null, plays: [], winnerSeat: null, pointsWon: 0 };
  g.currentSeat = seat;
}

test('甩牌：别家同花色有大牌时甩不出去', () => {
  const g = craft();
  setHands(g, [['club_K', 'club_Q', 'club_10'], ['club_A', 'spade_7', 'diamond_3'], ['club_9', 'heart_4'], ['club_8', 'heart_6']]);
  leadAt(g, 0);
  const r = g.leadLegal(['club_K', 'club_Q']);
  assert.equal(r.ok, false, '别家手里有 ♣A，甩 ♣K♣Q 必须失败');
  assert.equal(r.reason, 'THROW_NOT_BIGGEST');
});

test('甩牌：别家都没有更大牌时可以甩', () => {
  const g = craft();
  setHands(g, [['club_A', 'club_K', 'club_10'], ['club_9', 'spade_7', 'diamond_3'], ['club_8', 'heart_4'], ['club_Q', 'heart_6']]);
  leadAt(g, 0);
  // 别家最大只有 ♣Q(112)，甩 ♣A(114)♣K(113) 合法
  assert.equal(g.leadLegal(['club_A', 'club_K']).ok, true);
  // 只甩 ♣A 是单张；甩 ♣A♣K♣10 的最小牌是 10（比别家 ♣Q 小）→ 失败
  assert.equal(g.leadLegal(['club_A', 'club_K', 'club_10']).ok, false);
});

test('甩牌：真正没人能压过时可以甩', () => {
  const g = craft();
  setHands(g, [['club_A', 'club_K', 'club_10'], ['club_9', 'spade_7', 'diamond_3'], ['club_8', 'heart_4'], ['heart_Q', 'spade_6']]);
  leadAt(g, 0);
  const r = g.leadLegal(['club_A', 'club_K']);
  assert.equal(r.ok, true, '别家最大只有 ♣9，甩 ♣A♣K 合法');
  assert.equal(r.dimension, 'throw');
});

test('甩牌：主牌甩要求别家没有更大的主牌', () => {
  const g = craft();
  setHands(g, [['heart_A', 'heart_K', 'club_7'], ['joker_big', 'spade_8', 'club_3'], ['heart_9', 'spade_5'], ['club_6', 'diamond_9']]);
  leadAt(g, 0);
  const r = g.leadLegal(['heart_A', 'heart_K']);
  assert.equal(r.ok, false, '别家有大小王，♥A♥K 甩不出去');
  assert.equal(r.reason, 'THROW_NOT_BIGGEST');
  // 把大王换走 → 可以甩
  setHands(g, [['heart_A', 'heart_K', 'club_7'], ['heart_4', 'spade_8', 'club_3'], ['heart_9', 'spade_5'], ['club_6', 'diamond_9']]);
  assert.equal(g.leadLegal(['heart_A', 'heart_K']).ok, true);
});

test('非法甩牌不会出现在可出牌提示里', () => {
  const g = craft();
  setHands(g, [['club_K', 'club_Q', 'club_10'], ['club_A', 'spade_7', 'diamond_3'], ['club_9', 'heart_4'], ['club_8', 'heart_6']]);
  leadAt(g, 0);
  const throws = g.legalPlays().filter((p) => p.dimension === 'throw').map((p) => [...p.cardIds].sort().join(','));
  assert.ok(!throws.includes(['club_K', 'club_Q'].sort().join(',')), '有 ♣A 在外，不能给出 ♣K♣Q 的甩牌建议');
});

test('每副重置亮牌记录：上一副的亮牌不会串到别人座位', () => {
  const g = craft();
  setHands(g, [['club_5', 'spade_5', 'heart_5', 'club_9', 'spade_8', 'heart_7', 'club_6', 'spade_4', 'heart_3', 'club_2', 'spade_A', 'diamond_K'],
               ['club_4', 'spade_3', 'heart_2', 'club_10', 'spade_J', 'heart_J', 'club_J', 'spade_9', 'heart_8', 'club_7', 'spade_6', 'diamond_A'],
               ['club_Q', 'spade_Q', 'heart_Q', 'club_3', 'spade_2', 'heart_10', 'club_8', 'spade_7', 'heart_6', 'club_5', 'spade_5', 'diamond_2'],
               ['club_A', 'spade_K', 'heart_4', 'diamond_5', 'diamond_4', 'diamond_3', 'diamond_6', 'diamond_7', 'diamond_8', 'diamond_9', 'diamond_10', 'joker_big']]);
  g.reveal(0, ['club_5', 'spade_5', 'heart_5']); // 甲 亮五反
  g.reveal(1, null);
  g.reveal(2, null);
  g.reveal(3, null);
  assert.deepEqual(Object.keys(g.state().revealCards), ['0']);
  // 直接结束本副 → 下一副
  g.result = { scores: [60, 40], x: 40, dealerStay: false, newDealerIndex: 1, tribute: 'none', streak: 0 };
  g.phase = 'round_end';
  g.nextRound();
  assert.deepEqual(g.state().revealCards, {}, '新一副不应残留上一副的亮牌记录');
  assert.deepEqual(g.state().revealed, [], '新一副不应残留亮牌加成');
  // 新的一副里，乙拿到同样几张 5 并亮出 → 甲的座位不应再显示
  const ids = ['club_5', 'spade_5', 'heart_5'];
  g.hands[1] = ids.map((id) => g.cardById(id));
  g.reveal(1, ids);
  assert.deepEqual(Object.keys(g.state().revealCards), ['1'], '只有乙亮牌，甲的旧记录必须已被清掉');
});

test('6 人模式同样：甩牌要最大、亮牌记录每副重置', async () => {
  const { Game6 } = await import('../game/game6.mjs');
  const g = new Game6(['甲', '乙', '丙', '丁', '戊', '己'], rngOf(21));
  g.startRound();
  g.hands = [[], [], [], [], [], []];
  g.hands[0] = [g.cardById('club_K_1'), g.cardById('club_Q_1'), g.cardById('spade_7_1')];
  g.hands[1] = [g.cardById('club_A_1'), g.cardById('spade_8_1')];
  g.phase = 'trick';
  g.trick = { leaderSeat: 0, dimension: null, plays: [], winnerSeat: null, pointsWon: 0 };
  g.currentSeat = 0;
  const r = g.leadLegal([g.cardById('club_K_1').id, g.cardById('club_Q_1').id]);
  assert.equal(r.ok, false, '别家有 ♣A，甩牌必须失败');
  assert.equal(g.state().revealCards && Object.keys(g.state().revealCards).length, 0);
});
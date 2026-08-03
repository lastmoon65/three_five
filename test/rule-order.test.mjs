// test/rule-order.test.mjs — 亮牌与进贡/埋底时序约束 + 贡牌规则（产品逻辑回归）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../game/game.mjs';

function newGameAtTrick(seatCards) {
  const g = new Game(['a', 'b', 'c', 'd']);
  g.startRound();
  g.hands[0] = seatCards.slice();
  g.startTrick(0);
  return g;
}

test('亮牌只用发牌后的原始手牌：底牌中的 3/5 不计入三五反', () => {
  const g = new Game(['a', 'b', 'c', 'd']);
  g.startRound();
  const deck = [...g.cardMap.values()];
  const threes = deck.filter((c) => c.rank === '3');
  const others = deck.filter((c) => c.rank !== '3');
  g.hands[g.dealerIndex] = [threes[0], threes[1], ...others.slice(0, 10)];
  g.bottom = [threes[2], ...others.slice(10, 15)];
  assert.equal(g.hands[g.dealerIndex].filter((c) => c.rank === '3').length, 2);
  assert.equal(g.bottom.filter((c) => c.rank === '3').length, 1);
  assert.equal(g.legalReveals().length, 0, '底牌不能凑出三反');
});

test('进贡局：全部亮牌完成后才进入进贡（亮牌先于进贡）', () => {
  const g = new Game(['a', 'b', 'c', 'd']);
  g.startRound();
  g.tributePlan = 'single';
  const phases = [];
  for (let i = 0; i < 4; i++) {
    g.reveal(i, null);
    phases.push(g.phase);
  }
  assert.deepEqual(phases.slice(0, 3), ['reveal', 'reveal', 'reveal'], '前三人亮牌时仍在亮牌阶段');
  assert.equal(phases[3], 'tribute', '四人全部亮牌后才进入进贡');
  assert.equal(g.tributePlan, 'single', '进贡计划未被提前取消');
});

test('造反在进贡执行前判定：闲家亮三反成功则跳过进贡（无兜底时停在埋底选择）', () => {
  const g = new Game(['a', 'b', 'c', 'd']);
  g.startRound();
  g.tributePlan = 'single';
  const revSeat = (g.dealerIndex + 1) % 4;
  const deck = [...g.cardMap.values()];
  const threes = deck.filter((c) => c.rank === '3');
  const rest = deck.filter((c) => c.rank !== '3');
  const noPts = rest.filter((c) => c.points === 0);
  g.hands[g.dealerIndex] = noPts.slice(0, 12);
  const revPool = rest.filter((c) => !g.hands[g.dealerIndex].includes(c));
  g.hands[revSeat] = [threes[0], threes[1], threes[2], ...revPool.slice(0, 9)];
  let finalPhase = null;
  for (let seat = 0; seat < 4; seat++) {
    if (seat === revSeat) {
      const san = g.legalReveals(seat).find((o) => o.level === 'san');
      g.reveal(seat, san ? san.cardIds : null);
    } else {
      g.reveal(seat, null);
    }
    finalPhase = g.phase;
  }
  assert.equal(g.rebellion, true, '闲家亮番成立造反');
  assert.equal(g.tributePlan, 'none', '造反取消进贡计划');
  assert.equal(finalPhase, 'bury', '造反后跳过进贡直接进入埋底');
});

test('贡牌（进贡/退贡交换的牌）不能组成假杠', () => {
  const deck = [...new Game(['a', 'b', 'c', 'd']).cardMap.values()];
  const q = deck.find((c) => c.id === 'spade_Q');
  const tens = deck.filter((c) => c.rank === '10').slice(0, 3);
  const fill = deck.filter((c) => c.id !== 'spade_Q' && c.rank !== '10').slice(0, 8);
  const hand = [q, ...tens, ...fill];
  // 黑桃 Q 是贡牌 → 不能组假杠
  const g1 = newGameAtTrick(hand);
  g1.tributed.add('spade_Q');
  const fakes1 = g1.legalPlays().filter((p) => p.dimension === 'fake_kong');
  assert.equal(fakes1.length, 0, '贡牌黑桃 Q 不能组成假杠');
  assert.equal(g1.leadLegal([q.id, ...tens.map((c) => c.id)]).ok, false, '领出贡牌假杠被拒');
  // 黑桃 Q 未标记 → 可以组假杠（正向对照）
  const g2 = newGameAtTrick(hand);
  const fakes2 = g2.legalPlays().filter((p) => p.dimension === 'fake_kong');
  assert.ok(fakes2.length > 0, '未标记的黑桃 Q 可以组假杠');
  // 贡牌仍可作为单牌出
  assert.ok(g1.legalPlays().some((p) => p.dimension === 'single' && p.cardIds[0] === 'spade_Q'), '贡牌仍可单出');
});

test('贡牌不能组成真杠/四清；仍可垫牌响应', () => {
  const deck = [...new Game(['a', 'b', 'c', 'd']).cardMap.values()];
  const sevens = deck.filter((c) => c.rank === '7').slice(0, 4);
  const fill = deck.filter((c) => c.rank !== '7').slice(0, 8);
  // 其中一张 7 是贡牌 → 不能组成真杠
  const g1 = newGameAtTrick([...sevens, ...fill]);
  g1.tributed.add(sevens[0].id);
  assert.equal(g1.legalPlays().filter((p) => p.dimension === 'true_kong').length, 0, '贡牌不能组成真杠');
  assert.equal(g1.leadLegal(sevens.map((c) => c.id)).ok, false, '领出含贡牌的四张被拒');
  // 四清同样受限
  const fours = deck.filter((c) => c.rank === '4').slice(0, 4);
  const fill2 = deck.filter((c) => c.rank !== '4').slice(0, 8);
  const g3 = newGameAtTrick([...fours, ...fill2]);
  g3.tributed.add(fours[0].id);
  assert.equal(g3.legalPlays().filter((p) => p.dimension === 'four_clear').length, 0, '贡牌不能组成四清');
  // 未标记时正向对照
  const g2 = newGameAtTrick([...sevens, ...fill]);
  assert.ok(g2.legalPlays().some((p) => p.dimension === 'true_kong'), '未标记的 4 张 7 可组真杠');
});

test('真实进贡流程：进贡给出与退贡收回的牌都被标记为贡牌', () => {
  const g = new Game(['a', 'b', 'c', 'd']);
  g.startRound();
  g.tributePlan = 'single';
  for (let i = 0; i < 4; i++) g.reveal(i, null); // 全部不亮 → 进入进贡
  assert.equal(g.phase, 'tribute', '进入进贡阶段');
  g.tributeGive(); // 庄家自动进最大牌
  const giveId = g.lastGive.cardId;
  const taker = g.tributeState.pairs[0].taker;
  const mains = g.handMain(taker);
  const takeId = (mains[0] || g.hands[taker][0]).id;
  g.tributeTake(takeId);
  assert.ok(g.tributed.has(giveId), '进贡给出的牌被标记');
  assert.ok(g.tributed.has(takeId), '退贡收回的牌被标记');
});

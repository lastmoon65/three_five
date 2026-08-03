// test/reveal-sim.test.mjs — 亮牌同时进行 + 庄家埋底补亮（产品逻辑 V8.4/V9）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../game/game.mjs';
import { Game6 } from '../game/game6.mjs';

test('同时亮牌：任意顺序提交、重复提交被拒、全部提交后才推进', () => {
  const g = new Game(['a', 'b', 'c', 'd']);
  g.startRound();
  g.reveal(3, null); // 座位 3 先提交（跳过）
  assert.equal(g.state().phase, 'reveal', '未全部提交前停留在亮牌阶段');
  assert.throws(() => g.reveal(3, null), /REVEAL_ALREADY_DONE/);
  g.reveal(0, null);
  g.reveal(1, null);
  g.reveal(2, null);
  assert.ok(['bury', 'trick'].includes(g.state().phase), '全部提交后离开亮牌阶段（埋底或兜底自动埋底）');
});

test('庄家埋底补亮：无人亮牌时可用，基于 23 张手牌（含底牌），庄家方不造反', () => {
  const g = new Game(['a', 'b', 'c', 'd']);
  g.startRound();
  const deck = [...g.cardMap.values()];
  const threes = deck.filter((c) => c.rank === '3');
  const others = deck.filter((c) => c.rank !== '3' && c.points === 0); // 无分替补，避免兜底自动埋底
  // 庄家手牌 2 张 3 + 底牌 1 张 3 → 补亮可凑三反
  g.hands[g.dealerIndex] = [threes[0], threes[1], ...others.slice(0, 10)];
  g.bottom = [threes[2], ...others.slice(10, 15)];
  for (let i = 0; i < 4; i++) g.reveal(i, null); // 全部不亮 → 扣底
  assert.equal(g.state().phase, 'bury');
  assert.equal(g.hands[g.dealerIndex].length, 18, '庄家已拿底牌（12+6）');
  const opts = g.legalReveals(g.dealerIndex);
  assert.ok(opts.some((o) => o.level === 'san'), '埋底阶段可选三反（含底牌 3）');
  const san = opts.find((o) => o.level === 'san');
  g.buryReveal(san.cardIds);
  assert.equal(g.state().effectiveReveal.level, 'san');
  assert.equal(g.state().rebellion, false, '庄家方亮番不造反');
  assert.equal(g.state().phase, 'bury', '补亮后仍停留在埋底，继续选牌扣底');
  assert.equal(g.powerOf(g.cardById(threes[0].id)), 996);
});

test('已有人亮牌时，庄家不可埋底补亮', () => {
  const g = new Game(['a', 'b', 'c', 'd']);
  g.startRound();
  const deck = [...g.cardMap.values()];
  const fives = deck.filter((c) => c.rank === '5');
  const others = deck.filter((c) => c.rank !== '5');
  const noPts = deck.filter((c) => c.rank !== '5' && c.points === 0);
  g.hands[3] = [fives[0], fives[1], fives[2], ...noPts.slice(0, 9)];
  g.reveal(3, [fives[0].id, fives[1].id, fives[2].id]); // 座位 3 亮五反
  g.reveal(0, null);
  g.reveal(1, null);
  g.reveal(2, null);
  assert.ok(g.state().effectiveReveal, '有人已亮牌');
  assert.throws(() => g.buryReveal([fives[0].id, fives[1].id, fives[2].id]), /BAD_PHASE|REVEAL_AFTER_OTHERS/);
});

test('6 人版：庄家埋底补亮可用，造反等级不变', () => {
  const g = new Game6(['a', 'b', 'c', 'd', 'e', 'f']);
  g.startRound();
  const deck = [...g.cardMap.values()];
  const threes = deck.filter((c) => c.rank === '3');
  const others = deck.filter((c) => c.rank !== '3' && c.points === 0); // 无分替补，避免兜底自动埋底
  g.hands[g.dealerIndex] = [threes[0], threes[1], ...others.slice(0, 15)];
  g.bottom = [threes[2], ...others.slice(15, 20)];
  for (let i = 0; i < 6; i++) g.reveal(i, null);
  assert.equal(g.state().phase, 'bury');
  const opts = g.legalReveals(g.dealerIndex);
  assert.ok(opts.some((o) => o.level === 'san'));
  g.buryReveal(opts.find((o) => o.level === 'san').cardIds);
  assert.equal(g.state().effectiveReveal.level, 'san');
  assert.equal(g.state().rebellionLevel, 0, '庄家方亮番不造反');
  assert.equal(g.state().phase, 'bury');
});

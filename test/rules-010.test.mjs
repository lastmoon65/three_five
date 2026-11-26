// test/rules-010.test.mjs — TF-20261126-010 / J1 跟甩子集回归
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../game/game.mjs';

function rngOf(seed) { return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648; }

function craft(seed = 1) {
  const g = new Game(['甲', '乙', '丙', '丁'], rngOf(seed));
  g.startRound();
  return g;
}

function startTrickAt(g, leader, handsByIds) {
  g.hands = handsByIds.map(arr => arr.map(id => g.cardById(id)));
  g.bottom = [];
  g.startTrick(leader);
}

test('跟甩从所选牌中自动打出最小合法子集，不扩大到未选手牌', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_9', 'spade_8', 'spade_7'],
    ['club_6'],
    ['diamond_7'],
    ['club_3', 'spade_K', 'spade_A', 'spade_3'],
  ]);
  g.play(['spade_9', 'spade_8']);
  assert.equal(g.state().trick.dimension, 'throw');

  g.play(['club_3', 'spade_K', 'spade_A']);
  const state = g.state();
  assert.deepEqual(state.trick.plays[1].cardIds, ['spade_K', 'spade_A']);
  assert.equal(state.trick.plays.length, 2);
  assert.equal(state.currentSeat, 2);
  assert.ok(g.hands[3].some(c => c.id === 'club_3'));
  assert.ok(g.hands[3].some(c => c.id === 'spade_3'));
});

test('跟甩多套合法子集时按牌力与 id 序列字典序选最小', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_7', 'spade_6', 'spade_5'],
    ['club_6'],
    ['diamond_7'],
    ['club_3', 'spade_10', 'spade_9', 'spade_8', 'spade_3'],
  ]);
  g.play(['spade_7', 'spade_6']);

  g.play(['club_3', 'spade_10', 'spade_9', 'spade_8']);
  assert.deepEqual(g.state().trick.plays[1].cardIds, ['spade_8', 'spade_9']);
  assert.ok(g.hands[3].some(c => c.id === 'club_3'));
  assert.ok(g.hands[3].some(c => c.id === 'spade_10'));
  assert.ok(g.hands[3].some(c => c.id === 'spade_3'));
});

// test/rules-006.test.mjs — TF-20261126-006 规则回归
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, basePower, kongDimension } from '../game/game.mjs';

function rngOf(seed) { return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648; }

function craft(seed = 1) {
  const g = new Game(['甲', '乙', '丙', '丁'], rngOf(seed));
  g.startRound();
  return g;
}

function setHands(g, handsByIds) {
  g.hands = handsByIds.map(arr => arr.map(id => g.cardById(id)));
  g.bottom = [];
}

function startTrickAt(g, leader, handsByIds) {
  setHands(g, handsByIds);
  g.startTrick(leader);
}

function ids(...cards) { return cards.map(c => c.id).sort(); }

test('真杠比大小：2 最小，AAAA 与 3333 都能压 2222；单张 2 牌力不变', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_2', 'club_2', 'diamond_2', 'heart_2'],
    ['spade_A', 'club_A', 'diamond_A', 'heart_A'],
    [],
    [],
  ]);
  g.play(['spade_2', 'club_2', 'diamond_2', 'heart_2']);
  g.play(['spade_A', 'club_A', 'diamond_A', 'heart_A']);
  assert.equal(g.state().trick.winnerSeat, 1);

  const h = craft();
  startTrickAt(h, 0, [
    ['spade_2', 'club_2', 'diamond_2', 'heart_2'],
    ['spade_3', 'club_3', 'diamond_3', 'heart_3'],
    [],
    [],
  ]);
  h.play(['spade_2', 'club_2', 'diamond_2', 'heart_2']);
  h.play(['spade_3', 'club_3', 'diamond_3', 'heart_3']);
  assert.equal(h.state().trick.winnerSeat, 1);

  assert.equal(basePower('heart', '2'), 589);
  assert.equal(basePower('club', '2'), 588);
  assert.ok(basePower('heart', '2') > basePower('heart', 'A'));
  assert.ok(basePower('club', '2') > basePower('club', 'A'));
  assert.ok(basePower('club', '2') > basePower('club', 'K'));
});

test('四清跟牌：手牌不足 4 张必须全出，残局不空过并能结算', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_4', 'club_4', 'diamond_4', 'heart_4'],
    [],
    [],
    ['spade_3', 'club_A'],
  ]);
  g.play(['spade_4', 'club_4', 'diamond_4', 'heart_4']);
  assert.equal(g.state().currentSeat, 3);
  assert.deepEqual(g.legalPlays().map(p => p.cardIds), [['spade_3', 'club_A']]);
  assert.deepEqual(g.playHints(), { count: 2, allowed: ['spade_3', 'club_A'], dimension: 'four_clear', auto: true });
  assert.throws(() => g.play([]), /ILLEGAL_RESPONSE/);
  g.play(['spade_3', 'club_A']);
  assert.equal(g.state().phase, 'round_end');
  assert.deepEqual(g.state().handCounts, [0, 0, 0, 0]);
});

test('四清跟牌：赢家已空手时，下一墩交给逆时针下一家仍有牌的人', () => {
  const g = craft();
  startTrickAt(g, 1, [
    ['spade_3', 'club_3', 'diamond_3', 'spade_6', 'club_6', 'diamond_6'],
    ['spade_4', 'club_4', 'diamond_4', 'heart_4'],
    [],
    [],
  ]);
  g.play(['spade_4', 'club_4', 'diamond_4', 'heart_4']);
  const response = g.legalPlays()[0].cardIds;
  assert.equal(response.length, 4);
  g.play(response);
  assert.equal(g.state().phase, 'trick');
  assert.equal(g.state().currentSeat, 0);
  assert.equal(g.state().handCounts[0], 2);

  let guard = 0;
  while (g.state().phase === 'trick' && guard < 20) {
    const plays = g.legalPlays();
    assert.ok(plays.length > 0, '仍有手牌的座位必须能领出');
    g.play(plays[0].cardIds);
    guard++;
  }
  assert.equal(g.state().phase, 'round_end');
});

test('甩牌失败：领出强制最小单张，跟甩无合法组合时提示重选', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_A', 'spade_K', 'spade_10', 'spade_9'],
    ['club_K'],
    ['club_A'],
    ['spade_3'],
  ]);
  g.play(['spade_A', 'spade_10']);
  assert.equal(g.state().trick.dimension, 'single');
  assert.deepEqual(g.state().trick.plays[0].cardIds, ['spade_10']);
  assert.equal(g.state().currentSeat, 3);

  const h = craft();
  startTrickAt(h, 0, [
    ['spade_A', 'spade_K', 'spade_10'],
    [],
    [],
    ['spade_3', 'spade_5', 'spade_4', 'heart_A'],
  ]);
  h.play(['spade_A', 'spade_K']);
  const before = JSON.stringify(h.state());
  // 按 TF-20261126-010 / J1：构不成合法跟牌时保持局面不变，并给出中文重选提示。
  assert.throws(
    () => h.play(['spade_3', 'heart_A']),
    (error) => {
      assert.match(error.message, /请重新选择要出的牌/);
      assert.doesNotMatch(error.message, /FAILED_THROW_UNRESOLVED/);
      return true;
    },
  );
  assert.equal(JSON.stringify(h.state()), before);
  assert.equal(h.hands[3].length, 4);
  assert.equal(h.state().trick.plays.length, 1);

  h.play(['spade_3', 'heart_A', 'spade_4']);
  assert.deepEqual(h.state().trick.plays[1].cardIds, ['spade_3', 'spade_4']);
  assert.ok(h.hands[3].some(c => c.id === 'heart_A'));
});

function tributeAt(takerIds, giverIds = ['spade_A', 'spade_K', 'club_A', 'club_K']) {
  const g = craft();
  setHands(g, [giverIds, [], [], takerIds]);
  g.phase = 'tribute';
  g.tributeState = { pairs: [{ giver: 0, taker: 3 }], pairIdx: 0, step: 'take' };
  g.currentSeat = 3;
  return g;
}

test('退贡：有非分主牌不得退分主牌，主牌全分时才可退分主牌', () => {
  const g = tributeAt(['heart_K', 'heart_A', 'club_A']);
  assert.deepEqual(g.legalTributeTakes(3).map(c => c.id), ['heart_A']);
  assert.throws(() => g.tributeTake('heart_K'), /TRIBUTE_NO_POINTS/);
  g.tributeTake('heart_A');
  assert.equal(g.state().phase, 'bury');

  const h = tributeAt(['heart_K', 'diamond_5', 'club_A']);
  assert.deepEqual(ids(...h.legalTributeTakes(3)), ['diamond_5', 'heart_K']);
  assert.throws(() => h.tributeTake('club_A'), /NEED_MAIN_CARD/);
  h.tributeTake('heart_K');
  assert.equal(h.state().phase, 'bury');
});

test('退贡：无主牌时只能退非分牌，全部剩余牌都是分牌才允许退分牌', () => {
  const g = tributeAt(['diamond_K', 'club_A']);
  assert.deepEqual(g.legalTributeTakes(3).map(c => c.id), ['club_A']);
  assert.throws(() => g.tributeTake('diamond_K'), /TRIBUTE_NO_POINTS/);
  g.tributeTake('club_A');

  const h = tributeAt(['diamond_K', 'club_10']);
  assert.deepEqual(ids(...h.legalTributeTakes(3)), ['club_10', 'diamond_K']);
  h.tributeTake('diamond_K');
  assert.equal(h.state().phase, 'bury');
});

test('杠牌分类：非法四张不进入领出杠牌，合法真杠/假杠必须出现', () => {
  const g = craft();
  setHands(g, [
    ['spade_Q', 'spade_A', 'club_A', 'diamond_A', 'spade_2', 'club_2', 'diamond_2', 'heart_2', 'spade_K', 'club_K', 'diamond_K'],
    [], [], [],
  ]);
  g.startTrick(0);
  const plays = g.legalPlays();
  const kongPlays = plays.filter(p => ['fake_kong', 'true_kong', 'four_clear'].includes(p.dimension));
  for (const p of kongPlays) {
    assert.equal(kongDimension(p.cardIds.map(id => g.cardById(id))), p.dimension);
  }
  assert.ok(kongPlays.some(p => p.dimension === 'fake_kong' && ids(...p.cardIds.map(id => g.cardById(id))).join(',') === ['club_A', 'diamond_A', 'spade_A', 'spade_Q'].sort().join(',')));
  assert.ok(kongPlays.some(p => p.dimension === 'true_kong' && ids(...p.cardIds.map(id => g.cardById(id))).join(',') === ['club_2', 'diamond_2', 'heart_2', 'spade_2'].sort().join(',')));
  assert.equal(kongPlays.some(p => p.cardIds.length === 4 && !kongDimension(p.cardIds.map(id => g.cardById(id)))), false);
  assert.equal(kongDimension(['spade_Q', 'spade_A', 'spade_K', 'spade_10'].map(id => g.cardById(id))), null);
  assert.equal(kongDimension(['spade_Q', 'spade_A', 'club_K', 'diamond_J'].map(id => g.cardById(id))), null);
});

test('跟真杠：任意四张可垫，但四张杂牌不分类为真杠或假杠', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_7', 'club_7', 'diamond_7', 'heart_7'],
    [],
    [],
    ['spade_A', 'club_K', 'diamond_J', 'spade_3', 'club_4'],
  ]);
  g.play(['spade_7', 'club_7', 'diamond_7', 'heart_7']);
  const mixed = ['spade_A', 'club_K', 'diamond_J', 'spade_3'];
  assert.ok(g.legalPlays().some(p => ids(...p.cardIds.map(id => g.cardById(id))).join(',') === mixed.slice().sort().join(',')));
  assert.equal(kongDimension(mixed.map(id => g.cardById(id))), null);
  g.play(mixed);
  assert.equal(g.state().trick.winnerSeat, 0);
});

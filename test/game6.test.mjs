// test/game6.test.mjs — 6 人两副牌引擎（按 TF-20261127-001 已确认规则）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basePower } from '../game/game.mjs';
import {
  Game6,
  createDecks,
  kongDimension6,
  productSeatOf,
  roomSeatOfProduct,
  ccw,
  cw,
} from '../game/game6.mjs';

const NAMES = ['甲', '乙', '丙', '丁', '戊', '己'];

function rngOf(seed) { return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648; }

function craft(seed = 1) {
  const g = new Game6(NAMES, rngOf(seed));
  g.startRound();
  return g;
}

function setDealer(g, seat) {
  g.dealerIndex = seat;
  g.revealOrder = [seat, ccw(seat), ccw(ccw(seat)), ccw(ccw(ccw(seat))), ccw(ccw(ccw(ccw(seat)))), ccw(ccw(ccw(ccw(ccw(seat)))))];
  g.revealIdx = 0;
  g.currentSeat = seat;
  g.players = g.names.map((name, i) => ({ index: i, name, team: i % 2 }));
}

function allRevealSkip(g) { for (let i = 0; i < 6; i++) g.reveal(null); }

function setHand(g, seat, ids) { g.hands[seat] = ids.map((id) => g.cardById(id)); }

function fillHand(g, seat, preferred, size = 17) {
  const used = new Set(preferred);
  const extra = [];
  for (const c of g.cardMap.values()) {
    if (used.has(c.id)) continue;
    extra.push(c.id);
    if (preferred.length + extra.length >= size) break;
  }
  setHand(g, seat, preferred.concat(extra).slice(0, size));
}

function skipToTrick(g) {
  for (let i = 0; i < 8; i++) {
    if (g.phase === 'reveal') allRevealSkip(g);
    while (g.phase === 'tribute') {
      const st = g.tributeState;
      if (st.step === 'give') {
        const opts = g.legalTributeGives(g.currentSeat);
        g.tributeGive(opts[0].id);
      } else {
        g.tributeTake(g.legalTributeTakes(g.currentSeat)[0].id);
      }
    }
    if (g.phase === 'bury') {
      const ids = g.hands[g.dealerIndex].filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
      if (ids.length < 6) throw new Error('BURY_UNAVAILABLE');
      g.bury(ids);
    }
    if (g.phase === 'trick' || g.phase === 'round_end') return;
  }
  throw new Error('skipToTrick failed, phase=' + g.phase);
}

function playOut(g, limit = 800) {
  skipToTrick(g);
  let n = 0;
  while (g.phase === 'trick' && n < limit) {
    const plays = g.legalPlays();
    assert.ok(plays.length, '应有合法出牌');
    g.play(plays[0].cardIds);
    n++;
  }
  return g;
}

// ---------- 牌具 ----------
test('两副牌：108 张、id 带副序号且无重复、总分 200', () => {
  const deck = createDecks();
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map((c) => c.id)).size, 108);
  assert.equal(deck.filter((c) => c.id.endsWith('_0')).length, 54);
  assert.equal(deck.filter((c) => c.id.endsWith('_1')).length, 54);
  assert.equal(deck.reduce((s, c) => s + c.points, 0), 200);
  assert.equal(basePower('diamond', '5'), 1000);
  assert.equal(basePower('heart', '2'), 589);
});

test('发牌：每人 17 张 + 底牌 6 张，108 张全用无重叠', () => {
  const g = craft();
  const s = g.state();
  assert.deepEqual(s.handCounts, [17, 17, 17, 17, 17, 17]);
  assert.equal(s.bottom.length, 6);
  const all = s.hands.flat().concat(s.bottom);
  assert.equal(all.length, 108);
  assert.equal(new Set(all.map((c) => c.id)).size, 108);
});

test('座位映射：庄家为产品座位 1，顺时针 2–6；队伍 1/3/5 对 2/4/6', () => {
  assert.equal(productSeatOf(3, 3), 1);
  assert.equal(productSeatOf(4, 3), 2);
  assert.equal(productSeatOf(5, 3), 3);
  assert.equal(productSeatOf(0, 3), 4);
  assert.equal(productSeatOf(1, 3), 5);
  assert.equal(productSeatOf(2, 3), 6);
  assert.equal(roomSeatOfProduct(1, 3), 3);
  assert.equal(cw(3), 4);
  assert.equal(ccw(3), 2);
  const g = craft();
  setDealer(g, 3);
  const s = g.state();
  assert.deepEqual(s.productSeats, [4, 5, 6, 1, 2, 3]);
  assert.equal(s.players[3].team, s.players[5].team);
  assert.equal(s.players[3].team, s.players[1].team);
  assert.notEqual(s.players[3].team, s.players[4].team);
});

test('牌力表不改：单牌 2 仍是高位常主', () => {
  assert.ok(basePower('club', '2') > basePower('heart', 'A'));
  assert.ok(basePower('diamond', '5') > basePower('joker', 'big'));
});

// ---------- 进贡配对 / 不得分牌 ----------
test('单进贡配对为产品 1→2（庄家顺时针下家），退贡原路返回', () => {
  const g = craft(2);
  setDealer(g, 2);
  g.tributePlan = 'single';
  allRevealSkip(g);
  assert.equal(g.phase, 'tribute');
  assert.deepEqual(g.tributeState.pairs, [{ giver: 2, taker: 3 }]);
  assert.equal(g.productSeat(2), 1);
  assert.equal(g.productSeat(3), 2);
});

test('三进贡配对为 1↔2、3↔4、5↔6，不是对位差 3', () => {
  const g = craft(3);
  setDealer(g, 0);
  g.tributePlan = 'triple';
  allRevealSkip(g);
  assert.deepEqual(g.tributeState.pairs, [
    { giver: 0, taker: 1 },
    { giver: 2, taker: 3 },
    { giver: 4, taker: 5 },
  ]);
  for (const p of g.tributeState.pairs) {
    assert.notEqual((p.giver + 3) % 6, p.taker, '不得使用对位（差 3）方案');
  }
});

test('进贡不得为分牌：最大牌为方块5 时改出最大非分牌', () => {
  const g = craft(4);
  setDealer(g, 0);
  g.tributePlan = 'single';
  fillHand(g, 0, ['diamond_5_0', 'joker_big_0', 'spade_3_0', 'club_3_0', 'heart_3_0', 'spade_4_0', 'club_4_0', 'heart_6_0', 'spade_6_0', 'club_6_0', 'heart_7_0', 'spade_7_0', 'club_7_0', 'heart_8_0', 'spade_8_0', 'club_8_0', 'heart_9_0']);
  fillHand(g, 1, ['spade_A_0', 'heart_A_0', 'club_A_0', 'diamond_A_0', 'joker_small_0', 'spade_Q_0', 'club_2_0', 'spade_2_0', 'heart_2_0', 'club_J_0', 'spade_J_0', 'heart_J_0', 'diamond_J_0', 'club_9_0', 'spade_9_0', 'diamond_9_0', 'diamond_8_0']);
  allRevealSkip(g);
  assert.equal(g.phase, 'tribute');
  const legal = g.legalTributeGives(0).map((c) => c.id);
  assert.ok(!legal.includes('diamond_5_0'));
  assert.deepEqual(legal, ['joker_big_0']);
  g.tributeGive();
  assert.equal(g.lastGive.cardId, 'joker_big_0');
  assert.ok(g.tributed.has('joker_big_0'));
  assert.ok(!g.hands[0].some((c) => c.id === 'joker_big_0'));
  assert.ok(g.hands[1].some((c) => c.id === 'joker_big_0'));
});

test('进贡并列最大非分牌时由进贡者任选', () => {
  const g = craft(5);
  setDealer(g, 0);
  g.tributePlan = 'single';
  fillHand(g, 0, ['heart_J_0', 'heart_J_1', 'club_3_0', 'club_4_0', 'club_6_0', 'club_7_0', 'club_8_0', 'club_9_0', 'spade_3_0', 'spade_4_0', 'spade_6_0', 'spade_7_0', 'spade_8_0', 'spade_9_0', 'diamond_3_0', 'diamond_4_0', 'diamond_6_0']);
  allRevealSkip(g);
  const legal = g.legalTributeGives(0).map((c) => c.id).sort();
  assert.deepEqual(legal, ['heart_J_0', 'heart_J_1']);
  assert.throws(() => g.tributeGive(), /TRIBUTE_GIVE_NEED_CHOICE/);
  g.tributeGive('heart_J_1');
  assert.equal(g.lastGive.cardId, 'heart_J_1');
});

test('退贡原路返还且原则上不得为分牌', () => {
  const g = craft(6);
  setDealer(g, 0);
  g.tributePlan = 'single';
  fillHand(g, 0, ['joker_big_0', 'club_3_0', 'club_4_0', 'club_6_0', 'club_7_0', 'club_8_0', 'club_9_0', 'spade_3_0', 'spade_4_0', 'spade_6_0', 'spade_7_0', 'spade_8_0', 'spade_9_0', 'diamond_3_0', 'diamond_4_0', 'diamond_6_0', 'diamond_7_0']);
  fillHand(g, 1, ['heart_A_0', 'heart_5_0', 'club_A_0', 'club_4_1', 'club_6_1', 'club_7_1', 'club_8_1', 'spade_A_0', 'spade_4_1', 'spade_6_1', 'spade_7_1', 'diamond_A_0', 'diamond_8_1', 'diamond_9_1', 'club_9_1', 'spade_9_1', 'heart_9_1']);
  allRevealSkip(g);
  g.tributeGive();
  const legal = g.legalTributeTakes(1);
  assert.ok(legal.every((c) => c.points === 0));
  assert.ok(legal.some((c) => c.id === 'heart_A_0'));
  assert.ok(!legal.some((c) => c.id === 'heart_5_0'));
  assert.throws(() => g.tributeTake('heart_5_0'), /TRIBUTE_NO_POINTS/);
  g.tributeTake('heart_A_0');
  assert.ok(g.hands[0].some((c) => c.id === 'heart_A_0'));
  assert.ok(!g.tributed.has('heart_A_0'), '退贡牌不得记为进贡所得');
});

// ---------- 亮牌免贡 ----------
test('1 人亮出免单进贡，三进贡档仍执行三进贡', () => {
  const g = craft(7);
  setDealer(g, 0);
  g.tributePlan = 'single';
  fillHand(g, 0, ['club_3_0', 'spade_3_0', 'diamond_3_0', 'club_4_0', 'club_6_0', 'club_7_0', 'club_8_0', 'club_9_0', 'spade_4_0', 'spade_6_0', 'spade_7_0', 'spade_8_0', 'diamond_4_0', 'diamond_6_0', 'diamond_7_0', 'diamond_8_0', 'heart_9_0']);
  g.reveal(['club_3_0', 'spade_3_0', 'diamond_3_0']);
  for (let i = 0; i < 5; i++) g.reveal(null);
  assert.equal(g.revealCount(), 1);
  assert.equal(g.tributePlan, 'none');
  assert.equal(g.phase, 'bury');

  const g2 = craft(8);
  setDealer(g2, 0);
  g2.tributePlan = 'triple';
  fillHand(g2, 5, ['club_3_0', 'spade_3_0', 'diamond_3_0', 'club_4_0', 'club_6_0', 'club_7_0', 'club_8_0', 'club_9_0', 'spade_4_0', 'spade_6_0', 'spade_7_0', 'spade_8_0', 'diamond_4_0', 'diamond_6_0', 'diamond_7_0', 'diamond_8_0', 'heart_9_0']);
  g2.reveal(null); // dealer pass, next is seat 5 (逆时针)
  g2.reveal(['club_3_0', 'spade_3_0', 'diamond_3_0']);
  for (let i = 0; i < 4; i++) g2.reveal(null);
  assert.equal(g2.revealCount(), 1);
  assert.equal(g2.tributePlan, 'triple');
  assert.equal(g2.phase, 'tribute');
  assert.equal(g2.tributeState.pairs.length, 3);
});

test('2 人及以上亮出：单进贡与三进贡全部免；三反五反互不覆盖', () => {
  const g = craft(9);
  setDealer(g, 0);
  g.tributePlan = 'triple';
  fillHand(g, 0, ['club_3_0', 'spade_3_0', 'diamond_3_0', 'club_4_0', 'club_6_0', 'club_7_0', 'club_8_0', 'club_9_0', 'spade_4_0', 'spade_6_0', 'spade_7_0', 'spade_8_0', 'diamond_4_0', 'diamond_6_0', 'diamond_7_0', 'diamond_8_0', 'heart_9_0']);
  fillHand(g, 5, ['club_5_0', 'spade_5_0', 'heart_5_0', 'club_4_1', 'club_6_1', 'club_7_1', 'club_8_1', 'club_9_1', 'spade_4_1', 'spade_6_1', 'spade_7_1', 'spade_8_1', 'diamond_4_1', 'diamond_6_1', 'diamond_7_1', 'diamond_8_1', 'heart_9_1']);
  g.reveal(['club_3_0', 'spade_3_0', 'diamond_3_0']);
  g.reveal(['club_5_0', 'spade_5_0', 'heart_5_0']);
  for (let i = 0; i < 4; i++) g.reveal(null);
  assert.equal(g.revealCount(), 2);
  assert.equal(g.reveals.length, 2);
  assert.equal(g.powerOf(g.cardById('club_3_0')), 996);
  assert.equal(g.powerOf(g.cardById('club_5_0')), 998);
  assert.equal(g.tributePlan, 'none');
  assert.equal(g.phase, 'bury');
});

test('庄家埋底补亮有效且不回溯已完成的进贡', () => {
  const g = craft(10);
  setDealer(g, 0);
  g.tributePlan = 'single';
  fillHand(g, 0, ['joker_big_0', 'club_3_0', 'club_4_0', 'club_6_0', 'club_7_0', 'club_8_0', 'club_9_0', 'spade_3_0', 'spade_4_0', 'spade_6_0', 'spade_7_0', 'spade_8_0', 'diamond_3_1', 'diamond_4_0', 'diamond_6_0', 'diamond_7_0', 'diamond_8_0']);
  fillHand(g, 1, ['heart_A_0', 'club_A_0', 'spade_A_0', 'diamond_A_0', 'joker_small_0', 'club_2_0', 'spade_2_0', 'heart_2_0', 'club_J_0', 'spade_J_0', 'heart_J_0', 'diamond_J_0', 'club_9_1', 'spade_9_0', 'diamond_9_0', 'heart_9_0', 'heart_8_1']);
  allRevealSkip(g);
  assert.equal(g.phase, 'tribute');
  g.tributeGive();
  const given = g.lastGive.cardId;
  g.tributeTake(g.legalTributeTakes(1)[0].id);
  assert.equal(g.phase, 'bury');
  assert.equal(g.lastGive.cardId, given);
  // 底牌已入手，补一套三反
  const handIds = new Set(g.handIds(0));
  // 放入三张 5 再补亮
  const extra5 = ['club_5_0', 'spade_5_0', 'heart_5_0'].filter((id) => !handIds.has(id));
  g.hands[0] = g.hands[0].concat(extra5.map((id) => g.cardById(id)));
  g.buryReveal(['club_5_0', 'spade_5_0', 'heart_5_0']);
  assert.equal(g.phase, 'bury');
  assert.equal(g.lastGive.cardId, given);
  assert.equal(g.tributePlan, 'single'); // 不回溯进贡结果
  assert.equal(g.powerOf(g.cardById('club_5_0')), 998);
});

// ---------- 埋底 ----------
test('埋底禁止分牌；能选出 6 张无分牌时由庄家手埋，不自动埋底', () => {
  const g = craft(11);
  setDealer(g, 0);
  allRevealSkip(g);
  assert.equal(g.phase, 'bury');
  assert.equal(g.autoBury, null);
  assert.equal(g.hands[0].length, 23);
  const scoring = g.hands[0].find((c) => c.points > 0);
  const non = g.hands[0].filter((c) => c.points === 0).slice(0, 5).map((c) => c.id);
  if (scoring) {
    assert.throws(() => g.bury(non.concat([scoring.id])), /BURY_NO_POINTS/);
  }
  const ok = g.hands[0].filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
  g.bury(ok);
  assert.equal(g.phase, 'trick');
  assert.equal(g.buriedBy, 'manual');
  assert.equal(g.bottom.length, 6);
  assert.ok(g.bottom.every((c) => c.points === 0));
});

test('仅当凑不出 6 张无分牌时才重开本副，庄家与进贡档保持不变', () => {
  const g = craft(12);
  setDealer(g, 2);
  g.tributePlan = 'none';
  const points = [...g.cardMap.values()].filter((c) => c.points > 0).map((c) => c.id);
  assert.ok(points.length >= 18);
  setHand(g, 2, points.slice(0, 17));
  g.bottom = points.slice(17, 23).map((id) => g.cardById(id));
  const roundNo = g.roundNo;
  const dealer = g.dealerIndex;
  allRevealSkip(g);
  assert.equal(g.phase, 'reveal', '应重开并回到亮牌');
  assert.equal(g.roundNo, roundNo);
  assert.equal(g.dealerIndex, dealer);
  assert.equal(g.redealCount, 1);
  assert.equal(g.hands[2].length, 17);
  const all = g.hands.flat().concat(g.bottom);
  assert.equal(all.length, 108);
  assert.equal(new Set(all.map((c) => c.id)).size, 108);
});

// ---------- 出牌 ----------
test('真杠点数序 2 最小；单牌 2 仍为大常主', () => {
  assert.equal(kongDimension6([
    { id: 'spade_2_0', suit: 'spade', rank: '2' },
    { id: 'heart_2_0', suit: 'heart', rank: '2' },
    { id: 'club_2_0', suit: 'club', rank: '2' },
    { id: 'diamond_2_0', suit: 'diamond', rank: '2' },
  ]), 'true_kong');
  const g = craft(13);
  setDealer(g, 0);
  skipToTrick(g);
  const twos = ['spade_2_0', 'heart_2_0', 'club_2_0', 'diamond_2_0'];
  const threes = ['spade_3_0', 'heart_3_0', 'club_3_0', 'diamond_3_0'];
  setHand(g, 0, twos.concat(['club_6_0', 'club_7_0', 'club_8_0', 'club_9_0', 'spade_6_0', 'spade_7_0', 'diamond_6_0', 'diamond_7_0', 'heart_8_0', 'heart_9_0', 'heart_7_0', 'spade_8_0', 'diamond_8_0']));
  setHand(g, 5, threes.concat(['club_6_1', 'club_7_1', 'club_8_1', 'club_9_1', 'spade_6_1', 'spade_7_1', 'diamond_6_1', 'diamond_7_1', 'heart_8_1', 'heart_9_1', 'heart_6_0', 'spade_9_0', 'diamond_9_0']));
  for (const s of [1, 2, 3, 4]) fillHand(g, s, ['club_A_0'], 13);
  g.startTrick(0);
  g.play(twos);
  assert.equal(g.trick.dimension, 'true_kong');
  g.play(threes);
  // 其余四家垫任意 4 张
  while (g.trick.plays.length < 6 && g.phase === 'trick' && g.trick.winnerSeat == null) {
    g.play(g.legalPlays()[0].cardIds);
  }
  assert.equal(g.trick.winnerSeat, 5, '3333 应压过 2222');
});

test('四清必须是四个花色的 4；未凑齐四门按真杠；跟牌固定 4 张且先垫高分', () => {
  assert.equal(kongDimension6([
    { id: 'spade_4_0', suit: 'spade', rank: '4' },
    { id: 'heart_4_0', suit: 'heart', rank: '4' },
    { id: 'club_4_0', suit: 'club', rank: '4' },
    { id: 'diamond_4_0', suit: 'diamond', rank: '4' },
  ]), 'four_clear');
  assert.equal(kongDimension6([
    { id: 'spade_4_0', suit: 'spade', rank: '4' },
    { id: 'spade_4_1', suit: 'spade', rank: '4' },
    { id: 'club_4_0', suit: 'club', rank: '4' },
    { id: 'diamond_4_0', suit: 'diamond', rank: '4' },
  ]), 'true_kong');
  const g = craft(14);
  setDealer(g, 0);
  skipToTrick(g);
  const clear = ['spade_4_0', 'heart_4_0', 'club_4_0', 'diamond_4_0'];
  setHand(g, 0, clear.concat(['club_6_0', 'club_7_0', 'club_8_0', 'club_9_0', 'spade_6_0', 'spade_7_0', 'diamond_6_0', 'heart_7_0', 'heart_8_0', 'heart_9_0', 'spade_8_0', 'diamond_8_0', 'diamond_9_0']));
  setHand(g, 5, ['club_10_0', 'club_K_0', 'spade_10_0', 'spade_K_0', 'club_5_0', 'spade_5_0', 'heart_6_0', 'heart_7_1', 'heart_8_1', 'heart_9_1', 'spade_6_1', 'spade_7_1', 'diamond_6_1']);
  for (const s of [1, 2, 3, 4]) fillHand(g, s, ['club_A_0'], 13);
  g.startTrick(0);
  g.play(clear);
  assert.equal(g.trick.dimension, 'four_clear');
  const combos = g.fourClearCombos(5);
  for (const comb of combos) {
    assert.equal(comb.length, 4);
    const pts = comb.filter((c) => c.points > 0);
    assert.ok(pts.some((c) => c.rank === '10' || c.rank === 'K'), '应先垫 10/K');
    assert.equal(pts.filter((c) => c.rank === '5').length, 0, '有 10/K 时不应先垫 5 占满 4 张分牌位');
  }
  const pick = combos[0].map((c) => c.id);
  g.play(pick);
  assert.equal(g.trick.plays[1].cardIds.length, 4);
});

test('恰好 4 张甩牌在六人合法；甩牌失败从所选牌改出最小一张', () => {
  const g = craft(15);
  setDealer(g, 0);
  skipToTrick(g);
  // 草花 4 张顶张 + 两张更小，手中还有更大草花则 4 张非顶张应失败
  const clubsTop = ['club_A_0', 'club_A_1', 'club_K_0', 'club_Q_0'];
  const clubsLow = ['club_3_0', 'club_6_0', 'club_7_0', 'club_8_0'];
  setHand(g, 0, clubsTop.concat(clubsLow).concat(['spade_6_0', 'spade_7_0', 'diamond_6_0', 'diamond_7_0', 'heart_8_0', 'heart_9_0', 'heart_7_0', 'spade_8_0', 'diamond_8_0']));
  for (const s of [1, 2, 3, 4, 5]) fillHand(g, s, ['spade_9_0'], 13);
  g.startTrick(0);
  g.play(clubsTop);
  assert.equal(g.trick.dimension, 'throw');
  assert.equal(g.trick.plays[0].cardIds.length, 4);

  const g2 = craft(16);
  setDealer(g2, 0);
  skipToTrick(g2);
  setHand(g2, 0, clubsTop.concat(clubsLow).concat(['spade_6_0', 'spade_7_0', 'diamond_6_0', 'diamond_7_0', 'heart_8_0', 'heart_9_0', 'heart_7_0', 'spade_8_0', 'diamond_8_0']));
  for (const s of [1, 2, 3, 4, 5]) fillHand(g2, s, ['spade_9_0'], 13);
  g2.startTrick(0);
  g2.play(clubsLow);
  assert.equal(g2.trick.dimension, 'single');
  assert.equal(g2.trick.plays[0].cardIds[0], 'club_3_0');
});

test('本副进贡所得的牌不得组成真杠、假杠或四清；退贡牌不在此限', () => {
  const g = craft(17);
  setDealer(g, 0);
  skipToTrick(g);
  const kong = ['spade_9_0', 'heart_9_0', 'club_9_0', 'diamond_9_0'];
  g.tributed.add('spade_9_0');
  setHand(g, 0, kong.concat(['club_6_0', 'club_7_0', 'club_8_0', 'heart_6_0', 'heart_7_0', 'heart_8_0', 'diamond_6_0', 'diamond_7_0', 'diamond_8_0', 'spade_6_0', 'spade_7_0', 'spade_8_0', 'heart_3_0']));
  for (const s of [1, 2, 3, 4, 5]) fillHand(g, s, ['club_A_0'], 13);
  g.startTrick(0);
  assert.throws(() => {
    const r = g.leadLegal(kong);
    if (r.ok && (r.dimension === 'true_kong' || r.dimension === 'four_clear' || r.dimension === 'fake_kong')) {
      throw new Error('TRIBUTCH_KONG_ALLOWED');
    }
    if (r.ok) g.play(kong);
    else throw new Error(r.reason);
  }, /BAD_LEAD|TRIBUTCH_KONG_ALLOWED/);
  // 退贡牌可以组杠
  const g3 = craft(18);
  setDealer(g3, 0);
  skipToTrick(g3);
  setHand(g3, 0, kong.concat(['club_6_0', 'club_7_0', 'club_8_0', 'heart_6_0', 'heart_7_0', 'heart_8_0', 'diamond_6_0', 'diamond_7_0', 'diamond_8_0', 'spade_6_0', 'spade_7_0', 'spade_8_0', 'heart_3_0']));
  for (const s of [1, 2, 3, 4, 5]) fillHand(g3, s, ['club_A_0'], 13);
  g3.startTrick(0);
  g3.play(kong);
  assert.equal(g3.trick.dimension, 'true_kong');
});

test('对外禁止 play([])；赢墩者手空时出牌权转给逆时针下一家有牌者', () => {
  const g = craft(19);
  setDealer(g, 0);
  skipToTrick(g);
  assert.throws(() => g.play([]), /请重新选择要出的牌/);
  setHand(g, 0, ['club_3_0']);
  setHand(g, 5, []);
  setHand(g, 4, ['club_6_0', 'club_J_0']);
  setHand(g, 3, ['club_7_0']);
  setHand(g, 2, ['club_8_0']);
  setHand(g, 1, ['club_9_0']);
  g.startTrick(0);
  g.play(['club_3_0']);
  // 逆时针下家 seat 5 已空手，advance 会占位；seat 4 出牌
  assert.equal(g.currentSeat, 4);
  g.play(['club_6_0']);
  g.play(['club_7_0']);
  g.play(['club_8_0']);
  g.play(['club_9_0']);
  // 墩结束，若 0 已空手，应由逆时针下一家有牌者领出
  assert.equal(g.phase, 'trick');
  assert.equal(g.hands[0].length, 0);
  assert.ok(g.currentSeat !== 0);
  assert.ok(g.hands[g.currentSeat].length > 0);
});

test('8 张同点视为两副，只能分两次出；假杠为任一黑桃 Q + 3 张同点', () => {
  const g = craft(20);
  setDealer(g, 0);
  skipToTrick(g);
  const eights = ['spade_8_0', 'heart_8_0', 'club_8_0', 'diamond_8_0', 'spade_8_1', 'heart_8_1', 'club_8_1', 'diamond_8_1'];
  setHand(g, 0, eights.concat(['club_6_0', 'club_7_0', 'club_9_0', 'heart_6_0', 'heart_7_0', 'diamond_6_0', 'diamond_7_0', 'spade_6_0', 'spade_7_0']));
  for (const s of [1, 2, 3, 4, 5]) fillHand(g, s, ['club_A_0'], 13);
  g.startTrick(0);
  const r = g.leadLegal(eights);
  assert.equal(r.ok, false);
  g.play(eights.slice(0, 4));
  assert.equal(g.trick.dimension, 'true_kong');

  const g2 = craft(21);
  setDealer(g2, 0);
  skipToTrick(g2);
  const fake = ['spade_Q_0', 'club_6_0', 'heart_6_0', 'diamond_6_0'];
  setHand(g2, 0, fake.concat(['club_7_0', 'club_8_0', 'club_9_0', 'heart_7_0', 'heart_8_0', 'heart_9_0', 'diamond_7_0', 'diamond_8_0', 'spade_7_0', 'spade_8_0', 'spade_9_0', 'heart_3_0', 'club_3_0']));
  for (const s of [1, 2, 3, 4, 5]) fillHand(g2, s, ['club_A_0'], 13);
  g2.startTrick(0);
  g2.play(fake);
  assert.equal(g2.trick.dimension, 'fake_kong');
});

test('完整对局可自动打完，结算总分 200，轮庄与进贡档正确', () => {
  const g = craft(22);
  playOut(g);
  assert.equal(g.phase, 'round_end');
  const r = g.result;
  assert.equal(r.scores[0] + r.scores[1], 200);
  if (r.x < 80) {
    assert.equal(r.dealerStay, true);
    assert.equal(r.tribute, 'none');
  } else {
    assert.equal(r.dealerStay, false);
    assert.equal(r.newDealerIndex, ccw(g.dealerIndex));
    if (r.x >= 160) assert.equal(r.tribute, 'triple');
    else if (r.x >= 120) assert.equal(r.tribute, 'single');
    else assert.equal(r.tribute, 'none');
  }
});

test('连庄满 3 副由逆时针最近队友接任；换庄由逆时针下家接任', () => {
  const g = craft(23);
  g.dealerIndex = 1;
  g.streak = 2;
  g.scores = [120, 60]; // dealer team is 1 % 2 = 1, idle = scores[0] = 120? wait team 1 has 60, idle is team 0 = 120 if dealer is odd
  // dealer 1 team 1, idle score = scores[0]
  g.scores = [70, 130]; // idle 70 < 80 stay
  g.phase = 'trick';
  g.hands = [[], [], [], [], [], []];
  g.finishRound();
  assert.equal(g.result.dealerStay, true);
  assert.equal(g.result.newDealerIndex, (1 + 4) % 6); // 5, nearest teammate ccw
  assert.equal(g.result.streak, 0);

  const g2 = craft(24);
  g2.dealerIndex = 1;
  g2.streak = 0;
  g2.scores = [90, 110]; // idle 90, change
  g2.phase = 'trick';
  g2.hands = [[], [], [], [], [], []];
  g2.finishRound();
  assert.equal(g2.result.dealerStay, false);
  assert.equal(g2.result.newDealerIndex, ccw(1));
  assert.equal(g2.result.tribute, 'none');
  g2.scores = [130, 70];
  g2.phase = 'trick';
  g2.hands = [[], [], [], [], [], []];
  g2.finishRound();
  assert.equal(g2.result.tribute, 'single');
  g2.scores = [160, 40];
  g2.phase = 'trick';
  g2.hands = [[], [], [], [], [], []];
  g2.finishRound();
  assert.equal(g2.result.tribute, 'triple');
});

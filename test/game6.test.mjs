// test/game6.test.mjs — 6 人两副牌引擎（V9）单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game6 } from '../game/game6.mjs';
import { isChangZhu, isMain } from '../game/game.mjs';

function game() { return new Game6(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']); }
function deckOf(g) { return [...g.cardMap.values()]; }
function skipReveals(g) { for (let i = 0; i < 6; i++) g.reveal(i, null); }

test('两副牌：108 张、id 无重复、每张两副、总分 200', () => {
  const g = game();
  const deck = deckOf(g);
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map((c) => c.id)).size, 108);
  for (const suit of ['spade', 'heart', 'club', 'diamond']) {
    assert.equal(deck.filter((c) => c.suit === suit).length, 26, suit);
  }
  assert.equal(deck.filter((c) => c.suit === 'joker').length, 4);
  assert.equal(deck.filter(isChangZhu).length, 24, '常主 24 张');
  assert.equal(deck.filter(isMain).length, 46, '主牌 46 张（占 42.6%）');
  assert.equal(deck.reduce((s, c) => s + c.points, 0), 200, '每副总分 200');
});

test('发牌：每人 17 张 + 底牌 6 张，108 张全用无重叠', () => {
  const g = game();
  g.startRound();
  const all = g.hands.flat().concat(g.bottom);
  assert.equal(all.length, 108);
  assert.equal(new Set(all.map((c) => c.id)).size, 108);
  assert.deepEqual(g.hands.map((h) => h.length), [17, 17, 17, 17, 17, 17]);
  assert.equal(g.bottom.length, 6);
  assert.equal(g.phase, 'reveal');
  assert.deepEqual(g.revealDone, [false, false, false, false, false, false], '同时亮牌：初始无人提交');
  assert.equal(g.currentSeat, g.dealerIndex);
});

function craftRevealRound(plan, setup) {
  const g = game();
  g.startRound();
  g.tributePlan = plan;
  const cfg = setup(g) || {};
  const d = g.dealerIndex;
  const order = [d, (d + 5) % 6, (d + 4) % 6, (d + 3) % 6, (d + 2) % 6, (d + 1) % 6];
  let lastErr = null;
  for (let i = 0; i < 6; i++) {
    const seat = order[i];
    const want = cfg.actions && cfg.actions[seat];
    try {
      if (want === 'san') {
        const san = g.legalReveals(seat).find((o) => o.level === 'san');
        g.reveal(seat, san ? san.cardIds : null);
      } else if (want === 'wu') {
        const wu = g.legalReveals(seat).find((o) => o.level === 'wu');
        g.reveal(seat, wu ? wu.cardIds : null);
      } else {
        g.reveal(seat, null);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  return { g, lastErr };
}

test('造反分层：1 名闲家亮三反 → level 1，单进贡计划取消', () => {
  const deck = deckOf(game());
  const threes = deck.filter((c) => c.rank === '3');
  const rest = deck.filter((c) => c.rank !== '3');
  const r = craftRevealRound('single', (g) => {
    const revSeat = (g.dealerIndex + 1) % 6;
    g.hands[revSeat] = [threes[0], threes[1], threes[2], ...rest.slice(0, 14)];
    return { actions: { [revSeat]: 'san' } };
  });
  assert.equal(r.g.rebellionLevel, 1);
  assert.equal(r.g.tributePlan, 'none', '单进贡被造反取消');
  assert.ok(['bury', 'trick'].includes(r.g.phase));
});

test('造反分层：2 名闲家亮三反 → level 2，三进贡计划取消', () => {
  const deck = deckOf(game());
  const threes = deck.filter((c) => c.rank === '3');
  const rest = deck.filter((c) => c.rank !== '3');
  const r = craftRevealRound('triple', (g) => {
    const a = (g.dealerIndex + 1) % 6;
    const b = (g.dealerIndex + 3) % 6;
    g.hands[a] = [threes[0], threes[1], threes[2], ...rest.slice(0, 14)];
    g.hands[b] = [threes[3], threes[4], threes[5], ...rest.slice(14, 28)];
    return { actions: { [a]: 'san', [b]: 'san' } };
  });
  assert.equal(r.g.rebellionLevel, 2, '两名闲家各亮三反');
  assert.equal(r.g.tributePlan, 'none', '三进贡被取消');
});

test('庄家方先亮同级别三反 → 闲家后亮被拒（先亮者有效）', () => {
  const deck = deckOf(game());
  const threes = deck.filter((c) => c.rank === '3');
  const rest = deck.filter((c) => c.rank !== '3');
  const r = craftRevealRound('single', (g) => {
    const d = g.dealerIndex;
    const idle = (d + 1) % 6;
    g.hands[d] = [threes[0], threes[1], threes[2], ...rest.slice(0, 14)];
    g.hands[idle] = [threes[3], threes[4], threes[5], ...rest.slice(14, 28)];
    return { actions: { [d]: 'san', [idle]: 'san' } };
  });
  assert.ok(r.lastErr && /TAKEN/.test(r.lastErr.message), '闲家三反被拒');
  assert.equal(r.g.rebellionLevel, 0, '庄家方亮番不造反');
});

test('庄家方后亮五反覆盖闲家三反 → 造反被阻止', () => {
  const deck = deckOf(game());
  const threes = deck.filter((c) => c.rank === '3');
  const fives = deck.filter((c) => c.rank === '5');
  const rest = deck.filter((c) => c.rank !== '3' && c.rank !== '5');
  const r = craftRevealRound('single', (g) => {
    const idle = (g.dealerIndex + 5) % 6;   // 闲家，顺序靠前先亮三反
    const mate = (g.dealerIndex + 2) % 6;   // 庄家方，顺序靠后亮五反覆盖
    g.hands[idle] = [threes[0], threes[1], threes[2], ...rest.slice(0, 14)];
    g.hands[mate] = [fives[0], fives[1], fives[2], ...rest.slice(14, 28)];
    return { actions: { [idle]: 'san', [mate]: 'wu' } };
  });
  assert.equal(r.g.rebellionLevel, 0, '闲家三反被庄家方五反覆盖');
  assert.equal(r.g.tributePlan, 'single', '进贡不被取消');
});

test('进贡：单进贡 1 组对位；三进贡 3 组 (seat+3)%6；交换的牌标记贡牌', () => {
  const g1 = game();
  g1.startRound();
  g1.tributePlan = 'single';
  skipReveals(g1);
  assert.equal(g1.phase, 'tribute');
  const p1 = g1.tributeState.pairs;
  assert.equal(p1.length, 1);
  assert.equal(p1[0].giver, g1.dealerIndex);
  assert.equal(p1[0].taker, (g1.dealerIndex + 3) % 6);

  const g3 = game();
  g3.startRound();
  g3.tributePlan = 'triple';
  skipReveals(g3);
  const p3 = g3.tributeState.pairs;
  assert.equal(p3.length, 3);
  const expectGivers = [g3.dealerIndex, (g3.dealerIndex + 4) % 6, (g3.dealerIndex + 2) % 6];
  p3.forEach((p, i) => {
    assert.equal(p.giver, expectGivers[i]);
    assert.equal(p.taker, (p.giver + 3) % 6);
  });

  // 贡牌标记
  g1.tributeGive();
  const giveId = g1.lastGive.cardId;
  const taker = g1.tributeState.pairs[0].taker;
  const mains = g1.handMain(taker);
  const takeId = (mains[0] || g1.hands[taker][0]).id;
  g1.tributeTake(takeId);
  assert.ok(g1.tributed.has(giveId), '进贡给出的牌标记');
  assert.ok(g1.tributed.has(takeId), '退贡收回的牌标记');
});

test('埋底：庄家 23 张选 6 张无分；分牌 ≥12 自动兜底', () => {
  // 手动埋底
  const g = game();
  g.startRound();
  const deck = deckOf(g);
  const noPts = deck.filter((c) => c.points === 0);
  g.hands[g.dealerIndex] = noPts.slice(0, 17); // 庄家无分牌，避免兜底
  skipReveals(g);
  assert.equal(g.phase, 'bury');
  assert.equal(g.hands[g.dealerIndex].length, 23);
  const buryIds = g.hands[g.dealerIndex].filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
  g.bury(buryIds);
  assert.equal(g.phase, 'trick');
  assert.equal(g.bottom.length, 6);
  assert.ok(g.bottom.every((c) => c.points === 0));

  // 兜底：庄家分牌 ≥12 → 自动扣最小 6 张，分归庄家方
  const g2 = game();
  g2.startRound();
  const pts = deck.filter((c) => c.points > 0);
  const noPts2 = deck.filter((c) => c.points === 0);
  g2.hands[g2.dealerIndex] = pts.slice(0, 17);
  g2.bottom = pts.slice(17, 23); // 底牌 6 张也全是分牌 → 兜底必带分
  skipReveals(g2);
  assert.equal(g2.phase, 'trick', '兜底自动埋底并进入打牌');
  assert.equal(g2.buriedBy, 'auto');
  assert.ok(g2.autoBury && g2.autoBury.cardIds.length === 6);
  assert.ok(g2.autoBury.points > 0, '兜底扣分计入庄家方');
});

test('打牌：8 张同点拆两副、单次最多 4 张、同牌力先出者大', () => {
  const g = game();
  g.startRound();
  const deck = deckOf(g);
  const sevens = deck.filter((c) => c.rank === '7'); // 8 张
  const fill = deck.filter((c) => c.rank !== '7').slice(0, 9);
  g.hands[0] = [...sevens, ...fill];
  g.startTrick(0);
  // 4 张上限：8 张一次出不合法
  assert.equal(g.leadLegal(sevens.map((c) => c.id)).ok, false, '8 张同点不能一次出');
  // 任意 4 张合法
  assert.equal(g.leadLegal(sevens.slice(0, 4).map((c) => c.id)).ok, true);
  const kongs = g.legalPlays().filter((p) => p.dimension === 'true_kong');
  assert.ok(kongs.length > 0, '可拆出真杠');
  assert.ok(kongs.every((k) => k.cardIds.length === 4), '每副真杠固定 4 张');

  // 同牌力先出者大：两张方块 5
  const g2 = game();
  g2.startRound();
  const d5 = deck.filter((c) => c.suit === 'diamond' && c.rank === '5');
  assert.equal(d5.length, 2);
  const winner = g2.resolveSingle([
    { seat: 0, cardIds: [d5[0].id] },
    { seat: 1, cardIds: [d5[1].id] },
  ]);
  assert.equal(winner, 0, '同牌力先出者大');
});

test('完整对局：自动打完一副 → 结算 200 分 → 轮庄/进贡计划正确', () => {
  const g = game();
  g.startRound();
  skipReveals(g);
  if (g.phase === 'tribute') {
    g.tributeGive();
    const p = g.tributeState.pairs[0];
    const mains = g.handMain(p.taker);
    g.tributeTake((mains[0] || g.hands[p.taker][0]).id);
  }
  if (g.phase === 'bury') {
    const d = g.dealerIndex;
    const ids = g.hands[d].filter((c) => c.points === 0).slice(0, 6).map((c) => c.id);
    if (ids.length === 6) g.bury(ids);
  }
  if (g.phase === 'trick') {
    let guard = 0;
    while (g.phase === 'trick' && guard < 300) {
      const plays = g.legalPlays();
      assert.ok(plays.length > 0, '必有可出牌');
      g.play(plays[0].cardIds);
      guard++;
    }
  }
  assert.equal(g.phase, 'round_end');
  assert.equal(g.result.scores[0] + g.result.scores[1], 200, '每副总分 200');
  assert.ok(g.result.newDealerIndex >= 0 && g.result.newDealerIndex < 6);
  assert.ok(['none', 'single', 'triple'].includes(g.result.tribute));
});

test('轮庄：<80 守庄（满 3 副队友接任）；≥80 换庄下家；进贡计划 120/160 分档', () => {
  const g1 = game();
  g1.startRound();
  g1.dealerIndex = 0;
  g1.scores = [150, 50];
  g1.finishRound();
  assert.equal(g1.result.dealerStay, true);
  assert.equal(g1.result.newDealerIndex, 0, '第一副守庄');
  assert.equal(g1.result.tribute, 'none');

  const g2 = game();
  g2.startRound();
  g2.dealerIndex = 0;
  g2.streak = 2;
  g2.scores = [150, 50];
  g2.finishRound();
  assert.equal(g2.result.newDealerIndex, 4, '连庄 3 副由逆时针最近队友接任 (0+4)%6');
  assert.equal(g2.result.streak, 0);

  const g3 = game();
  g3.startRound();
  g3.dealerIndex = 0;
  g3.scores = [100, 100];
  g3.finishRound();
  assert.equal(g3.result.dealerStay, false);
  assert.equal(g3.result.newDealerIndex, 5, '换庄下家 (0+5)%6');
  assert.equal(g3.result.tribute, 'none', '80~119 换庄无进贡');

  const g4 = game();
  g4.startRound();
  g4.dealerIndex = 0;
  g4.scores = [50, 150];
  g4.finishRound();
  assert.equal(g4.result.tribute, 'single', '120~159 单进贡');

  const g5 = game();
  g5.startRound();
  g5.dealerIndex = 0;
  g5.scores = [40, 160];
  g5.finishRound();
  assert.equal(g5.result.tribute, 'triple', '160~200 三进贡');
});

// test/engine.test.mjs — 《红心对决》规则引擎测试（对应规则 V8.3）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, createDeck, basePower } from '../game/game.mjs';

function rngOf(seed) { return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648; }

function craft(seed = 1) {
  const g = new Game(['甲', '乙', '丙', '丁'], rngOf(seed));
  g.startRound();
  return g;
}

// 固定庄家与亮牌顺序（发牌后白盒设定）
function setDealer(g, seat) {
  g.dealerIndex = seat;
  g.revealOrder = [seat, (seat + 3) % 4, (seat + 2) % 4, (seat + 1) % 4];
  g.revealIdx = 0;
  g.currentSeat = seat;
}

function allRevealSkip(g) { for (let i = 0; i < 4; i++) g.reveal(i, null); }

function setHand(g, seat, ids) { g.hands[seat] = ids.map(id => g.cardById(id)); }

function setHands(g, handsByIds) {
  g.hands = handsByIds.map(arr => arr.map(id => g.cardById(id)));
  g.bottom = [];
}

// 开墩：leader 先出，响应顺序为 leader→(leader+3)%4→(leader+2)%4→(leader+1)%4
function startTrickAt(g, leader, handsByIds) {
  setHands(g, handsByIds);
  g.startTrick(leader);
}

function stateJson(g) { return JSON.stringify(g.state()); }

// ---------- 牌具与牌力（§2） ----------
test('牌组 54 张且无重复', () => {
  const deck = createDeck();
  assert.equal(deck.length, 54);
  assert.equal(new Set(deck.map(c => c.id)).size, 54);
});

test('牌力表关键点（§2.4）', () => {
  assert.equal(basePower('diamond', '5'), 1000);
  assert.equal(basePower('joker', 'big'), 799);
  assert.equal(basePower('joker', 'small'), 798);
  assert.equal(basePower('spade', 'Q'), 699);
  assert.equal(basePower('heart', 'J'), 599);
  assert.equal(basePower('club', 'J'), 598);
  assert.equal(basePower('diamond', 'J'), 598);
  assert.equal(basePower('heart', '2'), 589);
  assert.equal(basePower('club', '2'), 588);
  assert.equal(basePower('heart', 'A'), 214);
  assert.equal(basePower('heart', '3'), 203);
  assert.equal(basePower('spade', 'A'), 114);
  assert.equal(basePower('club', 'Q'), 112);
  assert.equal(basePower('spade', '5'), 105);
});

test('分牌分值总和 100（§1.3）', () => {
  const deck = createDeck();
  const total = deck.reduce((s, c) => s + c.points, 0);
  assert.equal(total, 100);
  for (const c of deck) {
    if (c.rank === '5') assert.equal(c.points, 5);
    else if (c.rank === '10' || c.rank === 'K') assert.equal(c.points, 10);
    else assert.equal(c.points, 0);
  }
});

// ---------- 发牌（§1.1） ----------
test('发牌：每人 12、底牌 6、无重复（§1.1）', () => {
  const g = craft();
  const s = g.state();
  assert.deepEqual(s.handCounts, [12, 12, 12, 12]);
  assert.equal(s.bottom.length, 6);
  const all = s.hands.flat().concat(s.bottom);
  assert.equal(new Set(all.map(c => c.id)).size, 54);
});

// ---------- 亮牌（§4） ----------
test('亮五反：三张5 亮出后 power 998（方块5 保持 1000）（§4.2/§2.5）', () => {
  const g = craft();
  setDealer(g, 0);
  setHand(g, 0, ['heart_5', 'spade_5', 'diamond_5', 'spade_A', 'spade_K', 'spade_10', 'spade_9', 'spade_8', 'spade_7', 'spade_6', 'spade_4', 'spade_3']);
  const opts = g.legalReveals();
  assert.ok(opts.some(o => o.level === 'wu'));
  g.reveal(0, ['heart_5', 'spade_5', 'diamond_5']);
  assert.equal(g.state().effectiveReveal.level, 'wu');
  assert.equal(g.powerOf(g.cardById('heart_5')), 998);
  assert.equal(g.powerOf(g.cardById('spade_5')), 998);
  assert.equal(g.powerOf(g.cardById('diamond_5')), 1000);
});

test('亮三反：三张3 亮出后 power 996（§4.2）', () => {
  const g = craft();
  setDealer(g, 0);
  setHand(g, 0, ['heart_3', 'spade_3', 'club_3', 'spade_A', 'spade_K', 'spade_10', 'spade_9', 'spade_8', 'spade_7', 'spade_6', 'spade_4', 'spade_5']);
  g.reveal(0, ['heart_3', 'spade_3', 'club_3']);
  assert.equal(g.state().effectiveReveal.level, 'san');
  assert.equal(g.powerOf(g.cardById('heart_3')), 996);
});

test('五反可覆盖先亮的三反；同级别后亮无效（§4.3）', () => {
  const g = craft();
  setDealer(g, 0);
  setHand(g, 0, ['heart_3', 'spade_3', 'club_3', 'spade_A', 'spade_K', 'spade_10', 'spade_9', 'spade_8', 'spade_7', 'spade_6', 'spade_4', 'spade_5']);
  setHand(g, 3, ['heart_5', 'spade_5', 'club_5', 'spade_A', 'spade_K', 'spade_10', 'spade_9', 'spade_8', 'spade_7', 'spade_6', 'spade_4', 'spade_3']);
  g.reveal(0, ['heart_3', 'spade_3', 'club_3']); // 座位0 先亮三反
  g.reveal(3, ['heart_5', 'spade_5', 'club_5']); // 座位3 后亮五反 -> 覆盖
  assert.equal(g.state().effectiveReveal.level, 'wu');
  assert.equal(g.state().effectiveReveal.seat, 3);
  setHand(g, 2, ['heart_5', 'club_5', 'diamond_5', 'spade_A', 'spade_K', 'spade_10', 'spade_9', 'spade_8', 'spade_7', 'spade_6', 'spade_4', 'spade_3']);
  assert.throws(() => g.reveal(2, ['heart_5', 'club_5', 'diamond_5']), /REVEAL_WU_TAKEN/);
});

test('亮牌非法输入：非 3/5、张数不对都报错（§4.2）', () => {
  const g = craft();
  setDealer(g, 0);
  setHand(g, 0, ['heart_4', 'spade_4', 'club_4', 'spade_A', 'spade_K', 'spade_10', 'spade_9', 'spade_8', 'spade_7', 'spade_6', 'diamond_4', 'spade_5']);
  assert.throws(() => g.reveal(0, ['heart_4', 'spade_4', 'club_4']), /REVEAL_RANK_35/);
  assert.throws(() => g.reveal(0, ['heart_5', 'spade_5']), /REVEAL_NEED_3/);
});

test('造反：闲家亮番成功 -> 本副取消进贡（§4.4）', () => {
  const g = craft();
  setDealer(g, 0);
  g.result = { tribute: 'double', newDealerIndex: 0, streak: 0 };
  g.startRound();
  assert.equal(g.state().tributePlan, 'double');
  setHand(g, 3, ['heart_5', 'spade_5', 'club_5', 'spade_A', 'spade_K', 'spade_10', 'spade_9', 'spade_8', 'spade_7', 'spade_6', 'spade_4', 'spade_3']);
  g.reveal(0, null); // 座位0（庄家）跳过
  g.reveal(3, ['heart_5', 'spade_5', 'club_5']); // 座位3（闲家）亮五反
  g.reveal(1, null);
  g.reveal(2, null);
  const s = g.state();
  assert.equal(s.rebellion, true);
  assert.equal(s.tributePlan, 'none');
  assert.equal(s.phase, 'bury');
});

test('庄家方亮番不造反（§4.5）', () => {
  const g = craft();
  setDealer(g, 0);
  g.result = { tribute: 'single', newDealerIndex: 0, streak: 0 };
  g.startRound();
  setHand(g, 0, ['heart_5', 'spade_5', 'club_5', 'spade_A', 'spade_K', 'spade_10', 'spade_9', 'spade_8', 'spade_7', 'spade_6', 'spade_4', 'spade_3']);
  g.reveal(0, ['heart_5', 'spade_5', 'club_5']);
  g.reveal(1, null);
  g.reveal(2, null);
  g.reveal(3, null);
  assert.equal(g.state().rebellion, false);
  assert.equal(g.state().phase, 'tribute');
});
// ---------- 进贡退贡（§5） ----------
test('单进贡：进最大牌、退任意主牌、手牌守恒（§5.2）', () => {
  const g = craft();
  g.dealerIndex = 0;
  g.tributePlan = 'single';
  setHand(g, 0, ['heart_A', 'heart_K', 'spade_A', 'spade_K', 'spade_10', 'spade_9', 'spade_8', 'spade_7', 'spade_6', 'spade_4', 'spade_3', 'diamond_A']);
  setHand(g, 3, ['heart_Q', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5', 'club_4', 'club_3', 'diamond_K']);
  setHand(g, 2, ['spade_2', 'club_2', 'diamond_2', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_4', 'club_3']);
  setHand(g, 1, ['heart_10', 'heart_9', 'heart_8', 'heart_7', 'heart_6', 'heart_5', 'heart_4', 'heart_3', 'diamond_10', 'diamond_9', 'diamond_8', 'diamond_7']);
  g.enterTribute();
  assert.equal(g.state().currentSeat, 0);
  const before0 = g.hands[0].length, before3 = g.hands[3].length;
  g.tributeGive();
  // 进贡的最大牌：heart_A (214) 大于 spade_A/diamond_A (114)
  assert.equal(g.state().lastGive.cardId, 'heart_A');
  assert.equal(g.hands[0].length, before0 - 1);
  assert.equal(g.hands[3].length, before3 + 1);
  assert.equal(g.state().currentSeat, 3);
  // 退贡必须是主牌
  assert.throws(() => g.tributeTake('club_3'), /NEED_MAIN_CARD/);
  g.tributeTake('heart_Q');
  // 退贡完成后进入埋底：庄家手牌 12+6 底牌 = 18
  assert.equal(g.state().phase, 'bury');
  assert.equal(g.hands[3].length, before3);
  assert.ok(g.hands[0].includes(g.cardById('heart_Q')));
});

test('退贡无主牌时允许退任意牌（§5.2 兜底）', () => {
  const g = craft();
  g.dealerIndex = 0;
  g.tributePlan = 'single';
  // 进贡方手牌全为副牌，最大牌是 A（副牌），退贡方仍无主牌
  setHand(g, 0, ['spade_A', 'spade_K', 'spade_10', 'spade_9', 'spade_8', 'spade_7', 'spade_6', 'spade_5', 'spade_4', 'spade_3', 'club_A', 'club_K']);
  setHand(g, 3, ['diamond_A', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5', 'club_4', 'club_3', 'diamond_K']);
  setHand(g, 2, ['spade_2', 'club_2', 'diamond_2', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_4', 'club_3']);
  setHand(g, 1, ['heart_10', 'heart_9', 'heart_8', 'heart_7', 'heart_6', 'heart_5', 'heart_4', 'heart_3', 'diamond_10', 'diamond_9', 'diamond_8', 'diamond_7']);
  g.enterTribute();
  g.tributeGive();
  assert.equal(g.state().lastGive.cardId, 'spade_A'); // 进贡牌为副牌
  assert.equal(g.handMain(3).length, 0); // 收贡方仍无主牌
  g.tributeTake('club_A');
  assert.equal(g.state().phase, 'bury');
});

// ---------- 埋底（§6） ----------
test('埋底：选 6 张无分牌，公开，手牌回到 12（§6）', () => {
  const g = craft();
  setDealer(g, 0);
  setHand(g, 0, ['heart_A', 'heart_K', 'heart_Q', 'heart_10', 'heart_9', 'heart_8', 'spade_A', 'spade_K', 'spade_10', 'spade_9', 'spade_8', 'spade_7']);
  g.bottom = ['heart_4', 'spade_4', 'club_4', 'diamond_4', 'club_A', 'diamond_A'].map(id => g.cardById(id));
  allRevealSkip(g);
  let s = g.state();
  assert.equal(s.phase, 'bury');
  assert.equal(s.hands[0].length, 18);
  const ids = s.hands[0].filter(c => c.points === 0).slice(0, 6).map(c => c.id);
  g.bury(ids);
  s = g.state();
  assert.equal(s.phase, 'trick');
  assert.equal(s.bottom.length, 6);
  assert.equal(s.hands[0].length, 12);
});

test('埋底：含分牌报错（§6.2）', () => {
  const g = craft();
  setDealer(g, 0);
  setHand(g, 0, ['heart_5', 'heart_K', 'heart_Q', 'heart_10', 'heart_9', 'heart_8', 'spade_A', 'spade_K', 'spade_10', 'spade_9', 'spade_8', 'spade_7']);
  g.bottom = ['heart_4', 'spade_4', 'club_4', 'diamond_4', 'club_A', 'diamond_A'].map(id => g.cardById(id));
  allRevealSkip(g);
  const s = g.state();
  assert.equal(s.phase, 'bury');
  const ids = s.hands[0].filter(c => c.id !== 'heart_5').slice(0, 5).map(c => c.id).concat(['heart_5']);
  assert.throws(() => g.bury(ids), /BURY_NO_POINTS/);
});

test('埋底兜底：庄家分牌≥7 自动扣最小分值 6 张，底牌分归庄家方（§6.3）', () => {
  const g = craft();
  g.dealerIndex = 0;
  setHand(g, 0, ['heart_5', 'spade_5', 'club_5', 'diamond_10', 'heart_10', 'spade_10', 'club_10', 'spade_K', 'heart_3', 'spade_3', 'club_3', 'diamond_3']);
  g.bottom = ['spade_A', 'spade_9', 'spade_8', 'spade_7', 'spade_6', 'spade_4'].map(id => g.cardById(id));
  const before = g.state().scores.slice();
  g.enterBury();
  const s = g.state();
  assert.equal(s.buriedBy, 'auto');
  assert.ok(s.autoBury);
  assert.equal(s.bottom.length, 6);
  assert.equal(s.hands[0].length, 12);
  assert.equal(s.phase, 'trick');
  assert.equal(s.scores[0], before[0] + s.autoBury.points);
});

// ---------- 打牌：单牌维度（§3.2/§3.3） ----------
test('单牌跟牌：有同花色必须跟，无同花色可毙或垫', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_3', 'heart_A', 'spade_4', 'spade_5', 'spade_6', 'spade_7', 'spade_8', 'spade_9', 'spade_10', 'spade_K', 'spade_A', 'club_3'],
    ['spade_2', 'club_2', 'diamond_2', 'club_A', 'diamond_8', 'diamond_4', 'club_9', 'club_8', 'club_7', 'club_6', 'club_4', 'club_3'],
    ['heart_2', 'heart_K', 'heart_Q', 'heart_10', 'heart_9', 'heart_8', 'heart_7', 'heart_6', 'heart_5', 'heart_4', 'heart_3', 'diamond_3'],
    ['spade_4', 'heart_3', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5', 'club_4', 'diamond_A'],
  ]);
  g.play(['spade_3']); // 领出黑桃3
  assert.equal(g.state().currentSeat, 3);
  // 座位3 有黑桃4，必须跟黑桃
  assert.throws(() => g.play(['heart_3']), /ILLEGAL_RESPONSE/);
  g.play(['spade_4']);
  // 座位2 无黑桃、有主牌 -> 可毙
  g.play(['heart_K']);
  // 座位1 无黑桃、有主牌（常主2）
  g.play(['spade_2']);
  const s = g.state();
  assert.equal(s.trick.winnerSeat, 1); // 黑桃2 (588) > 红桃K (213) > 黑桃
});

test('领出常主（王）：其余玩家须跟主牌，无主牌可垫', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['joker_big', 'heart_A', 'spade_4', 'spade_5', 'spade_6', 'spade_7', 'spade_8', 'spade_9', 'spade_10', 'spade_K', 'spade_A', 'club_3'],
    ['spade_2', 'club_2', 'diamond_2', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_4', 'club_3'],
    ['heart_2', 'heart_K', 'heart_Q', 'heart_10', 'heart_9', 'heart_8', 'heart_7', 'heart_6', 'heart_5', 'heart_4', 'heart_3', 'diamond_3'],
    ['spade_A', 'spade_K', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5', 'club_4', 'diamond_A'],
  ]);
  g.play(['joker_big']);
  // 座位3 无主牌 -> 可垫副牌
  g.play(['spade_A']);
  // 座位2 有主牌 -> 必须跟主牌
  assert.throws(() => g.play(['diamond_3']), /ILLEGAL_RESPONSE/);
  g.play(['heart_2']);
  // 座位1 有主牌（常主 2）
  g.play(['spade_2']);
  assert.equal(g.state().trick.winnerSeat, 0); // 大王 799 最大
});

test('同牌力先出者为大（副J 598 并列，§2.1/§3.2）', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_Q', 'spade_2', 'spade_4', 'spade_5', 'spade_6', 'spade_7', 'spade_8', 'spade_9', 'spade_10', 'spade_K', 'spade_A', 'club_3'],
    ['heart_4', 'spade_3', 'club_3', 'diamond_3', 'heart_5', 'spade_5', 'club_5', 'diamond_5', 'heart_6', 'spade_6', 'club_6', 'diamond_6'],
    ['diamond_J', 'heart_A', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5', 'club_4', 'spade_4'],
    ['club_J', 'spade_4', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5', 'club_4', 'diamond_A'],
  ]);
  g.play(['spade_2']); // 领出常主黑桃2（588）
  g.play(['club_J']); // 座位3 先出副J（598）
  g.play(['diamond_J']); // 座位2 后出副J，同 598
  g.play(['heart_4']); // 座位1 出主牌
  assert.equal(g.state().trick.winnerSeat, 3); // 先出者为大
});
// ---------- 打牌：甩牌维度（§3.2/§3.3） ----------
test('花色甩：必须是同花色前 N 张', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_A', 'spade_K', 'spade_10', 'spade_5', 'spade_6', 'spade_7', 'spade_8', 'spade_9', 'heart_A', 'heart_K', 'heart_Q', 'club_3'],
    ['spade_2', 'club_2', 'diamond_2', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_4', 'club_3'],
    ['heart_2', 'heart_K', 'heart_Q', 'heart_10', 'heart_9', 'heart_8', 'heart_7', 'heart_6', 'heart_5', 'heart_4', 'heart_3', 'diamond_3'],
    ['spade_Q', 'diamond_4', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5', 'club_4', 'diamond_A'],
  ]);
  assert.throws(() => g.play(['spade_A', 'spade_10']), /THROW_NOT_TOP/); // 手中有黑桃K 未甩
  g.play(['spade_A', 'spade_K']);
  // 座位3 无黑桃（黑桃Q 是常主不算黑桃花色，diamond_4 是方块）-> 垫
  g.play(['club_A', 'club_K']);
  // 座位2 有主牌 -> 全毙
  g.play(['heart_2', 'heart_K']);
  // 座位1 无黑桃、有常主2 -> 垫
  g.play(['club_10', 'club_9']);
  assert.equal(g.state().trick.winnerSeat, 2); // 毙牌最大
});

test('主牌甩：常主按整体牌力前 N 张', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['diamond_5', 'joker_big', 'joker_small', 'spade_5', 'spade_6', 'spade_7', 'spade_8', 'spade_9', 'spade_10', 'spade_K', 'spade_A', 'club_3'],
    ['spade_2', 'club_2', 'diamond_2', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_4', 'club_3'],
    ['heart_2', 'heart_K', 'heart_Q', 'heart_10', 'heart_9', 'heart_8', 'heart_7', 'heart_6', 'heart_5', 'heart_4', 'heart_3', 'diamond_3'],
    ['spade_4', 'diamond_3', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5', 'club_4', 'diamond_A'],
  ]);
  assert.throws(() => g.play(['joker_big', 'joker_small']), /THROW_NOT_TOP/); // 方块5 更大未甩
  g.play(['diamond_5', 'joker_big']);
  // 座位3 无主牌 -> 垫两张副牌
  g.play(['club_A', 'club_K']);
  // 座位2 有主牌 -> 跟两张主牌
  g.play(['heart_2', 'heart_K']);
  // 座位1 有主牌（常主2）-> 跟两张主牌
  g.play(['spade_2', 'club_2']);
  assert.equal(g.state().trick.winnerSeat, 0);
});

// ---------- 打牌：假杠 / 真杠 / 四清（§3.2/§3.3） ----------
test('假杠领出与响应（副牌优先，真杠可压）', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_Q', 'spade_A', 'club_A', 'diamond_A', 'spade_5', 'spade_6', 'spade_7', 'spade_8', 'spade_9', 'spade_10', 'spade_K', 'club_3'],
    ['spade_4', 'club_4', 'diamond_4', 'heart_4', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5'],
    ['heart_2', 'heart_K', 'heart_Q', 'heart_10', 'heart_9', 'heart_8', 'heart_7', 'heart_6', 'heart_5', 'heart_4', 'heart_3', 'diamond_3'],
    ['spade_5', 'club_5', 'spade_9', 'heart_A', 'club_A', 'club_K', 'club_10', 'club_8', 'club_7', 'club_6', 'club_4', 'diamond_3'],
  ]);
  g.play(['spade_Q', 'spade_A', 'club_A', 'diamond_A']); // 假杠（黑桃Q+三张A）
  assert.equal(g.state().trick.dimension, 'fake_kong');
  // 座位3 有大量副牌 -> 不能主动添主牌 heart_A
  assert.throws(() => g.play(['spade_5', 'club_5', 'spade_9', 'heart_A']), /ILLEGAL_RESPONSE/);
  g.play(['spade_5', 'club_5', 'spade_9', 'diamond_3']);
  // 座位2 只有一张副牌 diamond_3 -> 全部副牌 + 3 张主牌
  g.play(['heart_2', 'heart_K', 'heart_Q', 'diamond_3']);
  // 座位1 有 4444 真杠 -> 压过假杠
  g.play(['spade_4', 'club_4', 'diamond_4', 'heart_4']);
  assert.equal(g.state().trick.winnerSeat, 1);
});

test('真杠领出：可被更大真杠压，跟杠可选', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_7', 'club_7', 'diamond_7', 'heart_7', 'spade_5', 'spade_6', 'spade_8', 'spade_9', 'spade_10', 'spade_K', 'spade_A', 'club_3'],
    ['spade_2', 'club_2', 'diamond_2', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_4', 'club_3'],
    ['spade_4', 'club_4', 'diamond_4', 'heart_4', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5'],
    ['spade_K', 'club_K', 'diamond_K', 'heart_K', 'club_A', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5', 'club_4'],
  ]);
  g.play(['spade_7', 'club_7', 'diamond_7', 'heart_7']); // 领出 7777 真杠
  assert.equal(g.state().trick.dimension, 'true_kong');
  // 座位3 有 KKKK -> 可选跟杠压过
  g.play(['spade_K', 'club_K', 'diamond_K', 'heart_K']);
  // 座位2 有 4444 但点数小 -> 选择垫任意 4 张（跟杠可选）
  g.play(['spade_4', 'club_4', 'diamond_4', 'heart_4']);
  // 座位1 垫 4 张
  g.play(['spade_2', 'club_2', 'diamond_2', 'club_A']);
  assert.equal(g.state().trick.winnerSeat, 3); // KKKK > 7777
});

test('四清领出：其余家垫出全部值分牌，领出者赢', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_4', 'club_4', 'diamond_4', 'heart_4', 'spade_5', 'spade_6', 'spade_7', 'spade_8', 'spade_9', 'spade_10', 'spade_K', 'club_3'],
    ['heart_3', 'spade_3', 'club_3', 'diamond_3', 'heart_4', 'spade_6', 'club_6', 'diamond_6', 'heart_7', 'spade_7', 'club_7', 'diamond_7'],
    ['spade_2', 'club_2', 'diamond_2', 'club_A', 'diamond_8', 'diamond_4', 'club_9', 'club_8', 'club_7', 'club_6', 'club_4', 'club_3'],
    ['heart_10', 'spade_5', 'club_A', 'diamond_A', 'diamond_3', 'club_9', 'club_8', 'club_7', 'club_6', 'club_2', 'club_4', 'club_3'],
  ]);
  g.play(['spade_4', 'club_4', 'diamond_4', 'heart_4']); // 领出 4444 四清
  assert.equal(g.state().trick.dimension, 'four_clear');
  // 座位3 有 2 张分牌（heart_10、spade_5）必须全部垫出
  assert.throws(() => g.play(['heart_10']), /ILLEGAL_RESPONSE/);
  g.play(['heart_10', 'spade_5']);
  // 座位2 无分牌 -> 不出
  g.play([]);
  // 座位1 无分牌 -> 不出
  g.play([]);
  const s = g.state();
  assert.equal(s.trick.winnerSeat, 0);
  assert.equal(s.trick.pointsWon, 15);
  assert.equal(s.scores[0], 15);
});

test('4444 用于压真杠时只按真杠处理，不触发四清（§3.3）', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_7', 'club_7', 'diamond_7', 'heart_7', 'spade_5', 'spade_6', 'spade_8', 'spade_9', 'spade_10', 'spade_K', 'spade_A', 'club_3'],
    ['heart_3', 'spade_3', 'club_3', 'diamond_3', 'heart_4', 'spade_6', 'club_6', 'diamond_6', 'heart_7', 'spade_7', 'club_7', 'diamond_7'],
    ['spade_2', 'club_2', 'diamond_2', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_4', 'club_3'],
    ['spade_4', 'club_4', 'diamond_4', 'heart_4', 'club_A', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5', 'club_2'],
  ]);
  g.play(['spade_7', 'club_7', 'diamond_7', 'heart_7']);
  g.play(['spade_4', 'club_4', 'diamond_4', 'heart_4']); // 4444 点数 4 < 7
  g.play(['spade_2', 'club_2', 'diamond_2', 'club_A']);
  g.play(['heart_3', 'spade_3', 'club_3', 'diamond_3']);
  assert.equal(g.state().trick.winnerSeat, 0);
  assert.equal(g.state().trick.pointsWon, 0);
});

// ---------- 结算与轮庄（§8） ----------
test('结算阈值：39 守庄 / 40 换庄 / 60 单进贡 / 80 双进贡（§5.1/§8.2）', () => {
  const cases = [
    { x: 39, stay: true, tribute: 'none', newDealer: 0 },
    { x: 40, stay: false, tribute: 'none', newDealer: 3 },
    { x: 59, stay: false, tribute: 'none', newDealer: 3 },
    { x: 60, stay: false, tribute: 'single', newDealer: 3 },
    { x: 79, stay: false, tribute: 'single', newDealer: 3 },
    { x: 80, stay: false, tribute: 'double', newDealer: 3 },
    { x: 100, stay: false, tribute: 'double', newDealer: 3 },
  ];
  for (const c of cases) {
    const g = craft();
    g.dealerIndex = 0;
    g.streak = 0;
    g.scores = [100 - c.x, c.x];
    g.finishRound();
    const r = g.roundResult();
    assert.equal(r.dealerStay, c.stay, 'x=' + c.x);
    assert.equal(r.tribute, c.tribute, 'x=' + c.x);
    assert.equal(r.newDealerIndex, c.newDealer, 'x=' + c.x);
  }
});

test('连庄满 3 副由队友接任（§8.3）', () => {
  const g = craft();
  g.dealerIndex = 0;
  g.streak = 2;
  g.scores = [80, 20];
  g.finishRound();
  const r = g.roundResult();
  assert.equal(r.dealerStay, true);
  assert.equal(r.streak, 0);
  assert.equal(r.newDealerIndex, 2);
  g.nextRound();
  assert.equal(g.state().dealerIndex, 2);
});

test('换庄由原庄家下家（逆时针）接庄，且进贡计划带入下一副（§8.2/§5.1）', () => {
  const g = craft();
  g.dealerIndex = 1;
  g.streak = 0;
  g.scores = [60, 40]; // 座位1 是庄家（team1），闲家 team0 得 60 -> 换庄+单进贡
  g.finishRound();
  const r = g.roundResult();
  assert.equal(r.dealerStay, false);
  assert.equal(r.newDealerIndex, (1 + 3) % 4);
  assert.equal(r.tribute, 'single');
  g.nextRound();
  const s = g.state();
  assert.equal(s.dealerIndex, r.newDealerIndex);
  assert.equal(s.tributePlan, 'single');
});

test('首副庄家随机（不同种子通常不同）', () => {
  const a = craft(1).state().dealerIndex;
  const b = craft(2).state().dealerIndex;
  assert.notEqual(a, b);
});

// ---------- 非法操作与状态不变 ----------
test('非法响应抛错且状态不变', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_3', 'heart_A', 'spade_4', 'spade_5', 'spade_6', 'spade_7', 'spade_8', 'spade_9', 'spade_10', 'spade_K', 'spade_A', 'club_3'],
    ['spade_2', 'club_2', 'diamond_2', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_4', 'club_3'],
    ['heart_2', 'heart_K', 'heart_Q', 'heart_10', 'heart_9', 'heart_8', 'heart_7', 'heart_6', 'heart_5', 'heart_4', 'heart_3', 'diamond_3'],
    ['spade_4', 'heart_3', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5', 'club_4', 'diamond_A'],
  ]);
  g.play(['spade_3']);
  const before = stateJson(g);
  assert.throws(() => g.play(['heart_3']), /ILLEGAL_RESPONSE/);
  assert.equal(stateJson(g), before);
  assert.throws(() => g.play(['club_A', 'heart_3']), /ILLEGAL_RESPONSE/);
  assert.equal(stateJson(g), before);
});

test('出牌不在手牌中报错（领出也校验）', () => {
  const g = craft();
  startTrickAt(g, 0, [
    ['spade_3', 'heart_A', 'spade_4', 'spade_5', 'spade_6', 'spade_7', 'spade_8', 'spade_9', 'spade_10', 'spade_K', 'spade_A', 'club_3'],
    ['spade_2', 'club_2', 'diamond_2', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_4', 'club_3'],
    ['heart_2', 'heart_K', 'heart_Q', 'heart_10', 'heart_9', 'heart_8', 'heart_7', 'heart_6', 'heart_5', 'heart_4', 'heart_3', 'diamond_3'],
    ['spade_4', 'heart_3', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5', 'club_4', 'diamond_A'],
  ]);
  const before = stateJson(g);
  assert.throws(() => g.play(['joker_big']), /CARD_NOT_IN_HAND/);
  assert.equal(stateJson(g), before);
});

test('阶段流转：发牌→亮牌→进贡→埋底→打牌→结算→下一副（§7）', () => {
  const g = craft();
  assert.equal(g.state().phase, 'reveal');
  allRevealSkip(g);
  assert.equal(g.state().phase, 'bury');
  const s0 = g.state();
  g.bury(s0.hands[s0.dealerIndex].filter(c => c.points === 0).slice(0, 6).map(c => c.id));
  assert.equal(g.state().phase, 'trick');
  let guard = 0;
  while (g.state().phase === 'trick' && guard < 500) {
    const pl = g.legalPlays();
    assert.ok(pl.length > 0, 'no legal play at guard ' + guard);
    g.play(pl[0].cardIds);
    guard++;
  }
  assert.equal(g.state().phase, 'round_end');
  const r = g.roundResult();
  assert.equal(r.scores[0] + r.scores[1], 100);
  g.nextRound();
  assert.equal(g.state().phase, 'reveal');
  assert.equal(g.state().roundNo, 2);
});

test('亮牌必须出自本人手牌（联网防作弊）', () => {
  const g = craft();
  setDealer(g, 0);
  setHand(g, 0, ['spade_A', 'spade_K', 'spade_10', 'spade_9', 'spade_8', 'spade_7', 'spade_6', 'spade_5', 'spade_4', 'spade_3', 'club_A', 'club_K']);
  setHand(g, 1, ['heart_5', 'spade_5', 'club_5', 'heart_A', 'heart_K', 'heart_Q', 'heart_10', 'heart_9', 'heart_8', 'heart_7', 'heart_6', 'heart_4']);
  assert.throws(() => g.reveal(0, ['heart_5', 'spade_5', 'club_5']), /CARD_NOT_IN_HAND/);
});
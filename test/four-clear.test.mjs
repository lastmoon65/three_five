// test/four-clear.test.mjs — 四清响应固定 4 张牌：先垫高分（10/K 先于 5），分牌不足则全部分牌+任意补足
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../game/game.mjs';
import { Game6 } from '../game/game6.mjs';

const NO_POINT = (c) => c.points === 0;

function craft(game, wantByIds, filters) {
  game.startRound();
  const n = game.players.length;
  const handSize = game.hands[0].length;
  const pool = [...game.cardMap.values()]; // 含王，保证无分牌池充足
  const used = new Set();
  const want = [];
  for (let i = 0; i < n; i++) {
    const ids = (wantByIds && wantByIds[i]) || [];
    ids.forEach((id) => { if (used.has(id)) throw new Error('重复牌 ' + id); used.add(id); });
    want[i] = ids.map((id) => game.cardById(id));
  }
  // 先分配带过滤的座位（如无分牌），保证其补牌充足；无过滤座位最后随意补
  const order = [];
  for (let i = 0; i < n; i++) if (filters && filters[i]) order.push(i);
  for (let i = 0; i < n; i++) if (!(filters && filters[i])) order.push(i);
  for (const i of order) {
    const filter = filters && filters[i];
    const rest = pool.filter((c) => !used.has(c.id) && (!filter || filter(c))).slice(0, handSize - want[i].length);
    rest.forEach((c) => used.add(c.id));
    game.hands[i] = want[i].concat(rest);
  }
  game.startTrick(0);
  return game;
}

test('4p：四清响应固定 4 张；分牌多时出最高的 4 张（3K+10，留下 5）', () => {
  const g = craft(new Game(['a', 'b', 'c', 'd']), {
    0: ['spade_4', 'club_4', 'diamond_4', 'heart_4'],
    3: ['spade_K', 'club_K', 'diamond_K', 'heart_10', 'spade_5'], // 5 张分牌
  }, {
    2: NO_POINT,
    1: NO_POINT,
    3: NO_POINT, // 座位3 补位也无分，保证分牌恰好 5 张
  });
  g.play(['spade_4', 'club_4', 'diamond_4', 'heart_4']);
  assert.equal(g.state().trick.dimension, 'four_clear');
  // 只能出 4 张：出 5 张被拒
  assert.throws(() => g.play(['spade_K', 'club_K', 'diamond_K', 'heart_10', 'spade_5']), /ILLEGAL_RESPONSE/);
  // 必须包含最高的分牌（10/K 先于 5）：出 3K+5（漏了 10）被拒
  assert.throws(() => g.play(['spade_K', 'club_K', 'diamond_K', 'spade_5']), /ILLEGAL_RESPONSE/);
  // 出最高的 4 张（3K+10）合法
  g.play(['spade_K', 'club_K', 'diamond_K', 'heart_10']);
  // 无分牌玩家也须垫 4 张
  const s2 = g.hands[2].filter(NO_POINT).slice(0, 4).map((c) => c.id);
  g.play(s2);
  const s1 = g.hands[1].filter(NO_POINT).slice(0, 4).map((c) => c.id);
  g.play(s1);
  const s = g.state();
  assert.equal(s.trick.winnerSeat, 0);
  assert.equal(s.trick.pointsWon, 40, '3K(30)+10(10)=40，5 分被留下');
  assert.equal(g.hands[3].length, 12 - 4, '手牌精确减少 4 张');
  assert.equal(s.phase, 'trick');
});

test('4p：分牌不足 4 张时，分牌全出 + 任意补足到 4 张', () => {
  const g = craft(new Game(['a', 'b', 'c', 'd']), {
    0: ['spade_4', 'club_4', 'diamond_4', 'heart_4'],
    3: ['heart_10', 'spade_5'], // 2 张分牌
  }, {
    2: NO_POINT,
    1: NO_POINT,
    3: NO_POINT, // 座位3 补位无分，分牌恰好 2 张
  });
  g.play(['spade_4', 'club_4', 'diamond_4', 'heart_4']);
  // 只出 2 张分牌被拒（须补足 4 张）
  assert.throws(() => g.play(['heart_10', 'spade_5']), /ILLEGAL_RESPONSE/);
  const fillers = g.hands[3].filter((c) => c.id !== 'heart_10' && c.id !== 'spade_5').slice(0, 2).map((c) => c.id);
  g.play(['heart_10', 'spade_5', ...fillers]);
  // 其余玩家补足 4 张，让本墩打完
  g.play(g.hands[2].filter(NO_POINT).slice(0, 4).map((c) => c.id));
  g.play(g.hands[1].filter(NO_POINT).slice(0, 4).map((c) => c.id));
  assert.equal(g.state().trick.winnerSeat, 0);
});

test('6p：四清响应固定 4 张、优先高分', () => {
  const g = craft(new Game6(['a', 'b', 'c', 'd', 'e', 'f']), {
    0: ['spade_4_0', 'club_4_0', 'diamond_4_0', 'heart_4_0'],
    5: ['spade_K_0', 'club_K_0', 'diamond_K_0', 'heart_10_0', 'spade_5_0'],
  }, {
    1: NO_POINT, 2: NO_POINT, 3: NO_POINT, 4: NO_POINT, 5: NO_POINT,
  });
  g.play(['spade_4_0', 'club_4_0', 'diamond_4_0', 'heart_4_0']);
  assert.throws(() => g.play(['spade_K_0', 'club_K_0', 'diamond_K_0', 'heart_10_0', 'spade_5_0']), /ILLEGAL_RESPONSE/);
  assert.throws(() => g.play(['spade_K_0', 'club_K_0', 'diamond_K_0', 'spade_5_0']), /ILLEGAL_RESPONSE/);
  g.play(['spade_K_0', 'club_K_0', 'diamond_K_0', 'heart_10_0']);
  for (let i = 4; i >= 1; i--) {
    const ids = g.hands[i].filter(NO_POINT).slice(0, 4).map((c) => c.id);
    g.play(ids);
  }
  const s = g.state();
  assert.equal(s.trick.winnerSeat, 0);
  assert.equal(s.trick.pointsWon, 40);
  assert.equal(g.hands[5].length, 17 - 4);
});

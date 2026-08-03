// test/heart-main.test.mjs — 红桃主花色领出按主牌响应（红桃或常主均可）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../game/game.mjs';
import { Game6 } from '../game/game6.mjs';

const NO_MAIN = (c) => c.suit !== 'heart' && !(c.suit === 'diamond' && c.rank === '5') && !(c.suit === 'spade' && c.rank === 'Q') && c.rank !== 'J' && c.rank !== '2' && c.suit !== 'joker';

// 构造不重叠手牌：每座指定若干关键牌 + 从剩余牌池补足
function craft(game, wantByIds, filters) {
  game.startRound();
  const n = game.players.length;
  const handSize = game.hands[0].length;
  const pool = [...game.cardMap.values()].filter((c) => c.suit !== 'joker');
  const used = new Set();
  // 先预占所有关键牌，避免被填充牌抢走
  const want = [];
  for (let i = 0; i < n; i++) {
    const ids = (wantByIds && wantByIds[i]) || [];
    ids.forEach((id) => { if (used.has(id)) throw new Error('重复牌 ' + id); used.add(id); });
    want[i] = ids.map((id) => game.cardById(id));
  }
  for (let i = 0; i < n; i++) {
    const filter = filters && filters[i];
    const cards = want[i].slice();
    const rest = pool.filter((c) => !used.has(c.id) && (!filter || filter(c))).slice(0, handSize - cards.length);
    rest.forEach((c) => used.add(c.id));
    game.hands[i] = cards.concat(rest);
  }
  game.startTrick(0);
  return game;
}

test('4p：领出红桃 → 有主牌须出主牌（常主可跟、副牌被拒）；无主牌可垫', () => {
  const g = craft(new Game(['a', 'b', 'c', 'd']), {
    0: ['heart_A'],      // 领出红桃
    3: ['heart_K', 'spade_2', 'club_A', 'club_K', 'club_10', 'club_9', 'club_8', 'club_7', 'club_6', 'club_5', 'club_4', 'club_3'], // 首个跟牌者：有红桃/常主/多张副牌
    1: ['diamond_5'],    // 尾家：有方块5 常主
  }, {
    2: NO_MAIN,          // 座位2 无任何主牌
  });
  g.play(['heart_A']);
  assert.equal(g.state().currentSeat, 3);
  // 座位3 有主牌：出副牌被拒
  const sub = g.hands[3].find((c) => c.suit === 'club' && c.rank !== '2' && c.rank !== 'J');
  assert.throws(() => g.play([sub.id]), /ILLEGAL_RESPONSE/, '有主牌时必须出主牌');
  // 常主（黑桃2）合法
  g.play(['spade_2']);
  // 座位2 无主牌：垫任意牌合法
  g.play([g.hands[2][0].id]);
  // 座位1 出方块5 常主
  g.play(['diamond_5']);
  assert.equal(g.state().trick.winnerSeat, 1, '方块5(1000) 最大');
});

test('4p：领出红桃 → 跟红桃同样合法（同为主牌）', () => {
  const g = craft(new Game(['a', 'b', 'c', 'd']), {
    0: ['heart_A'],
    3: ['heart_K'],
    1: ['diamond_5'],
  }, {
    2: NO_MAIN,
  });
  g.play(['heart_A']);
  g.play(['heart_K']); // 跟红桃合法
  g.play([g.hands[2][0].id]);
  g.play(['diamond_5']);
  assert.equal(g.state().trick.winnerSeat, 1);
});

test('6p：领出红桃 → 首个跟牌者（逆时针 0→5）须出主牌，常主可跟、副牌被拒', () => {
  const g = craft(new Game6(['a', 'b', 'c', 'd', 'e', 'f']), {
    0: ['heart_A_0'],
    5: ['heart_K_0', 'spade_2_0', 'club_A_0', 'club_K_0', 'club_10_0', 'club_9_0', 'club_8_0', 'club_7_0', 'club_6_0', 'club_5_0', 'club_4_0', 'club_3_0'],
  });
  g.play(['heart_A_0']);
  assert.equal(g.state().currentSeat, 5);
  const sub = g.hands[5].find((c) => c.suit === 'club' && c.rank !== '2' && c.rank !== 'J' && c.suit !== 'heart');
  assert.throws(() => g.play([sub.id]), /ILLEGAL_RESPONSE/, '6p 有主牌时必须出主牌');
  g.play(['spade_2_0']); // 常主合法
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MIN_CARD_STEP,
  autoFourClearPlay,
  cardLabel,
  handLayout,
  hasAutoBurySnapshot,
  isGamePaused,
  isHandCardClickable,
  isHandCardDimmed,
  isPointCard,
  matchLegalPlay,
  playErrorToastText,
  recommendedPlay,
  seatTeamLabel,
  TOAST_MS,
} from '../public-net/ui-logic.js';

test('toast 显示时长固定为 2 秒', () => {
  assert.equal(TOAST_MS, 2000);
});

test('cardLabel：大王、小王与普通牌', () => {
  assert.equal(cardLabel({ suit: 'joker', rank: 'big' }), '大王');
  assert.equal(cardLabel({ suit: 'joker', rank: 'small' }), '小王');
  assert.equal(cardLabel({ suit: 'heart', rank: '10' }), '♥10');
  assert.equal(cardLabel({ suit: 'spade', rank: 'A' }), '♠A');
});

test('handLayout：横屏/桌面单排步距充足时保持一行', () => {
  const layout = handLayout({ count: 8, containerWidth: 640, cardWidth: 80, orientation: 'landscape' });
  assert.deepEqual(layout, { rows: 1, perRow: 8, step: 80 });
  assert.ok(layout.step >= MIN_CARD_STEP);
});

test('handLayout：横屏/桌面单排步距不足时折成两行', () => {
  for (const orientation of ['landscape', 'desktop']) {
    const layout = handLayout({ count: 20, containerWidth: 640, cardWidth: 80, orientation });
    assert.equal(layout.rows, 2);
    assert.equal(layout.perRow, 10);
    assert.equal(layout.step, 560 / 9);
    assert.ok(layout.step >= MIN_CARD_STEP);
  }
});

test('handLayout：竖屏 13/18/23 张最多两行，并返回与输入一致的计算', () => {
  for (const count of [13, 18, 23]) {
    const cardWidth = 64;
    const containerWidth = 390;
    const layout = handLayout({ count, containerWidth, cardWidth, orientation: 'portrait' });
    assert.ok(layout.rows <= 2);
    assert.equal(layout.perRow, Math.ceil(count / layout.rows));
    assert.equal(layout.step, (containerWidth - cardWidth) / (layout.perRow - 1));
  }
});

test('handLayout：竖屏小牌数单排不足 44px 时也折行', () => {
  const layout = handLayout({ count: 12, containerWidth: 390, cardWidth: 80, orientation: 'portrait' });
  assert.equal(layout.rows, 2);
  assert.equal(layout.perRow, 6);
});

test('出牌按钮匹配只认服务端 legalPlays 的集合相等', () => {
  const legalPlays = [
    { cardIds: ['spade_A'], dimension: 'single' },
    { cardIds: ['heart_A', 'heart_K'], dimension: 'throw' },
  ];
  assert.equal(matchLegalPlay(['heart_K', 'heart_A'], legalPlays)?.dimension, 'throw');
  assert.equal(matchLegalPlay(['heart_A'], legalPlays), null);
  assert.equal(matchLegalPlay(['heart_A', 'heart_K', 'heart_Q'], legalPlays), null);
  const kongPlay = { cardIds: ['spade_Q', 'spade_A', 'club_A', 'diamond_A'], dimension: 'fake_kong' };
  assert.deepEqual(matchLegalPlay(['diamond_A', 'club_A', 'spade_A', 'spade_Q'], [kongPlay]), kongPlay);
  assert.equal(matchLegalPlay([], [kongPlay]), null);
});

test('推荐牌只从服务端 kongPlays/playHints/legalPlays 中取', () => {
  const kongPlays = [{ cardIds: ['club_A', 'diamond_A', 'heart_A', 'spade_A'] }];
  const legalPlays = [{ cardIds: ['spade_3'], dimension: 'single' }];
  assert.deepEqual(recommendedPlay({ kongPlays, legalPlays }), kongPlays[0].cardIds);
  assert.deepEqual(recommendedPlay({ legalPlays }), legalPlays[0].cardIds);
  assert.deepEqual(recommendedPlay({ playHints: { auto: true, allowed: ['spade_5', 'heart_5'] } }), ['spade_5', 'heart_5']);
});

test('四清应答只自动采用服务端唯一合法出牌，空牌集不再自动提交', () => {
  const trick = { dimension: 'four_clear' };
  const playHints = { auto: true, allowed: ['spade_10', 'club_5', 'club_2', 'spade_3'] };
  const legalPlays = [{ cardIds: ['spade_10', 'club_5', 'club_2', 'spade_3'], dimension: 'four_clear' }];
  assert.deepEqual(autoFourClearPlay({ trick, playHints, legalPlays }), { cardIds: ['spade_10', 'club_5', 'club_2', 'spade_3'] });
  assert.equal(
    autoFourClearPlay({ trick, playHints: { auto: true, allowed: [] }, legalPlays: [{ cardIds: [], dimension: 'four_clear' }] }),
    null,
  );
  assert.equal(autoFourClearPlay({ trick: { dimension: 'single' }, playHints, legalPlays }), null);
  assert.equal(autoFourClearPlay({ trick, playHints: { auto: false, allowed: [] }, legalPlays }), null);
  assert.equal(autoFourClearPlay({ trick, playHints, legalPlays: [...legalPlays, ...legalPlays] }), null);
});

test('自动化验收选择器与前端数据边界保持稳定', () => {
  const html = readFileSync(new URL('../public-net/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public-net/app.js', import.meta.url), 'utf8');
  const required = [
    'login-username', 'login-password', 'login-submit', 'login-error',
    'btn-create-room', 'join-room-code', 'btn-join-room', 'room-code',
    'btn-ready', 'btn-start-game', 'my-hand', 'btn-play', 'btn-hint', 'btn-clear',
    'btn-reveal-skip', 'btn-bury', 'btn-tribute-take', 'btn-next-round',
  ];
  for (const id of required) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /body data-screen="login"/);
  assert.match(app, /data-card-id/);
  assert.match(app, /data-reveal-index|dataset\.revealIndex/);
  assert.match(app, /dataset\.phase/);
  assert.ok(!app.includes('game/game.mjs'));
  assert.ok(!/leadLegal|responseLegal|basePower/.test(app));
  assert.ok(!html.includes('朋友账号'));
});

test('双主题、减弱动效与闲家进度刻度保持可用', () => {
  const html = readFileSync(new URL('../public-net/index.html', import.meta.url), 'utf8');
  const tokens = readFileSync(new URL('../public-net/tokens.css', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public-net/style.css', import.meta.url), 'utf8');
  assert.match(html, /data-theme-choice="green"/);
  assert.match(html, /data-theme-choice="midnight"/);
  for (const tick of [40, 60, 80]) assert.match(html, new RegExp(`--tick:${tick}`));
  assert.match(tokens, /html\[data-theme="green"\]/);
  assert.match(tokens, /html\[data-theme="midnight"\]/);
  assert.match(tokens, /prefers-reduced-motion: reduce/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /html\.reduce-motion/);
});

test('修复轮：favicon、复制按钮、进度条与四清操作文案保持稳定', () => {
  const html = readFileSync(new URL('../public-net/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public-net/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public-net/style.css', import.meta.url), 'utf8');
  assert.match(html, /rel="icon" href="data:image\/svg\+xml/);
  assert.match(css, /\.chip-btn\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.score-center\s*\{[^}]*width:\s*100%/s);
  assert.ok(!/\.selection-note\s*\{\s*display:\s*none/.test(css));
  assert.match(app, /autoFourClearPlay/);
  assert.match(app, /\$\('btn-hint'\)\.hidden = game\.phase === 'bury'/);
  assert.match(app, /\$\('btn-play'\)\.hidden = game\.phase === 'bury'|playButton\.hidden = game\.phase === 'bury'/);
  assert.match(app, /垫出分牌/);
  assert.match(app, /本墩无分牌可垫/);
});

test('座位阵营按庄家奇偶判断，自己与队友不因视角改变阵营', () => {
  assert.equal(seatTeamLabel(0, 0), '庄家方');
  assert.equal(seatTeamLabel(1, 0), '闲家方');
  assert.equal(seatTeamLabel(2, 0), '庄家方');
  assert.equal(seatTeamLabel(3, 0), '闲家方');
  assert.equal(seatTeamLabel(1, 1), '庄家方');
  assert.equal(seatTeamLabel(2, 1), '闲家方');
});

test('自动扣底提示只依据服务端 autoBury 或 buriedBy=auto', () => {
  assert.equal(hasAutoBurySnapshot({ autoBury: false, buriedBy: 'manual' }), false);
  assert.equal(hasAutoBurySnapshot({ autoBury: [], buriedBy: 'manual' }), false);
  assert.equal(hasAutoBurySnapshot({ autoBury: {}, buriedBy: 'manual' }), false);
  assert.equal(hasAutoBurySnapshot({ autoBury: ['heart_5'], buriedBy: 'manual' }), true);
  assert.equal(hasAutoBurySnapshot({ autoBury: { pending: false }, buriedBy: 'manual' }), true);
  assert.equal(hasAutoBurySnapshot({ autoBury: null, buriedBy: 'auto' }), true);
});

test('退修回归：选中叠放、不可出压暗、自己座位、牌桌红心与自动扣底提示', () => {
  const html = readFileSync(new URL('../public-net/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public-net/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public-net/style.css', import.meta.url), 'utf8');

  assert.doesNotMatch(css, /\.card\.selected\s*\{[^}]*z-index/s);
  assert.match(css, /\.card\.dim \.face\s*\{\s*filter:\s*brightness\(var\(--st-illegal-dim\)\)\s+saturate\(\.35\)/s);
  assert.doesNotMatch(css, /\.card\.dim\s*\{[^}]*opacity/s);

  assert.match(app, /dataset\.self = '1'/);
  assert.match(app, /seatTeamLabel\(slot\.index, game\.dealerIndex\)/);
  assert.match(app, /isSelf \? '我'/);
  assert.doesNotMatch(css, /\.seat-me \.seat-copy\s*\{\s*display:\s*none/s);

  const gameFelt = html.match(/<div class="felt game-felt"[^>]*>[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(gameFelt, /<div class="felt game-felt" aria-hidden="true"><\/div>/);
  assert.doesNotMatch(gameFelt, /felt-heart/);

  assert.match(app, /hasAutoBurySnapshot\(game\)/);
  assert.match(app, /分牌过多，已自动扣底/);
  assert.match(app, /buriedBy/);
});

test('toast 按竖屏、横屏与宽屏分别定位', () => {
  const css = readFileSync(new URL('../public-net/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.toast\s*\{[^}]*top:\s*calc\(56px \+ env\(safe-area-inset-top\)\)[^}]*pointer-events:\s*none/s);
  assert.match(css, /@media \(min-aspect-ratio: 1\/1\)\s*\{\s*\.toast\s*\{[^}]*top:\s*calc\(8px \+ env\(safe-area-inset-top\)\)/s);
  assert.match(css, /@media \(min-aspect-ratio: 1\/1\) and \(min-width: 1100px\) and \(min-height: 620px\)\s*\{\s*\.toast\s*\{[^}]*top:\s*calc\(16px \+ env\(safe-area-inset-top\)\)/s);
});

test('打牌失败提示：英文错误码转换为中文重选文案', () => {
  assert.equal(playErrorToastText({ code: 'BAD_PLAY', message: 'FAILED_THROW_UNRESOLVED' }), '请重新选择要出的牌');
  assert.equal(playErrorToastText({ code: 'BAD_PLAY', message: 'ILLEGAL_RESPONSE' }), '请重新选择要出的牌');
  assert.equal(playErrorToastText({ code: 'BAD_PLAY', message: '请重新选择要出的牌' }), '请重新选择要出的牌');
  assert.doesNotMatch(playErrorToastText({ code: 'BAD_PLAY', message: 'FAILED_THROW_UNRESOLVED' }), /[A-Za-z]/);
});

test('竖屏窄屏亮牌选项避开底部安全区', () => {
  const css = readFileSync(new URL('../public-net/style.css', import.meta.url), 'utf8');
  const narrow = css.match(/@media \(max-width: 760px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(narrow, /\.reveal-options\s*\{[^}]*bottom:\s*calc\(50px \+ env\(safe-area-inset-bottom\)\)/s);
});

test('埋底失败提示：分牌错误转为中文，出牌与已有中文文案不变', () => {
  assert.equal(playErrorToastText({ code: 'BAD_BURY', message: 'BURY_NO_POINTS' }), '埋底不能包含分牌，请重新选择');
  assert.equal(playErrorToastText({ message: 'BURY_NO_POINTS' }), '埋底不能包含分牌，请重新选择');
  assert.equal(playErrorToastText({ code: 'BAD_BURY', message: '埋底不能包含分牌，请重新选择' }), '埋底不能包含分牌，请重新选择');
  assert.doesNotMatch(playErrorToastText({ code: 'BAD_BURY', message: 'BURY_NO_POINTS' }), /BURY_NO_POINTS|BAD_BURY|[A-Za-z]/);
  assert.equal(playErrorToastText({ code: 'BAD_PLAY', message: 'FAILED_THROW_UNRESOLVED' }), '请重新选择要出的牌');
  assert.equal(playErrorToastText({ code: 'BAD_PLAY', message: '请重新选择要出的牌' }), '请重新选择要出的牌');
});

test('埋底阶段分牌不可选并压暗，非分牌仍可点选', () => {
  const game = { phase: 'bury', currentSeat: 0, me: 0, message: '庄家选 6 张无分牌扣底（底牌将公开）' };
  const heart5 = { id: 'heart_5', suit: 'heart', rank: '5', points: 5 };
  const diamond5 = { id: 'diamond_5', suit: 'diamond', rank: '5', points: 5 };
  const spade10 = { id: 'spade_10', suit: 'spade', rank: '10', points: 10 };
  const clubK = { id: 'club_K', suit: 'club', rank: 'K', points: 10 };
  const spade3 = { id: 'spade_3', suit: 'spade', rank: '3', points: 0 };
  const joker = { id: 'joker_big', suit: 'joker', rank: 'big', points: 0 };
  for (const card of [heart5, diamond5, spade10, clubK]) {
    assert.equal(isPointCard(card), true);
    assert.equal(isHandCardClickable(card, game), false);
    assert.equal(isHandCardDimmed(card, game), true);
  }
  assert.equal(isPointCard(spade3), false);
  assert.equal(isHandCardClickable(spade3, game), true);
  assert.equal(isHandCardDimmed(spade3, game), false);
  assert.equal(isHandCardClickable(joker, game), true);
  assert.equal(isHandCardDimmed(joker, game), false);
});

test('对局暂停时手牌不可点选，写操作按暂停文案判定', () => {
  const paused = { phase: 'reveal', currentSeat: 1, me: 1, revealActor: 1, message: 'P0 已离线，等待重连（本副暂停）' };
  const live = { phase: 'reveal', currentSeat: 1, me: 1, revealActor: 1, message: '轮到你了：选择亮牌或跳过' };
  const card = { id: 'spade_3', suit: 'spade', rank: '3', points: 0 };
  assert.equal(isGamePaused(paused), true);
  assert.equal(isGamePaused(live), false);
  assert.equal(isHandCardClickable(card, paused), false);
  const buryPaused = { phase: 'bury', currentSeat: 0, me: 0, message: '闲家 已离线，等待重连（本副暂停）' };
  assert.equal(isGamePaused(buryPaused), true);
  assert.equal(isHandCardClickable({ id: 'spade_3', rank: '3', points: 0 }, buryPaused), false);
});

test('前端错误处理把埋底分牌错误码交给中文 toast，AUTH_FAIL 仍单独处理', () => {
  const app = readFileSync(new URL('../public-net/app.js', import.meta.url), 'utf8');
  assert.match(app, /code === 'AUTH_FAIL'/);
  assert.match(app, /playErrorToastText\(\{ code, message: data\.message \}\)/);
  assert.match(app, /code === 'BAD_BURY'/);
  assert.match(app, /BURY_NO_POINTS/);
  assert.match(app, /isHandCardClickable\(card, game\)/);
  assert.match(app, /isHandCardDimmed\(card, game\)/);
  assert.match(app, /isGamePaused\(game\)/);
});

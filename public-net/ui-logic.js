// Pure, DOM-free helpers shared by the browser client and Node tests.
// This module intentionally does not import or duplicate the rules engine.

export const MIN_CARD_STEP = 44;
export const TOAST_MS = 2000;
export const SUIT_SYMBOLS = Object.freeze({
  spade: '♠',
  heart: '♥',
  club: '♣',
  diamond: '♦',
});

const SIDE_SUIT_ORDER = Object.freeze({ spade: 0, diamond: 1, club: 2 });

export function cardLabel(card) {
  if (!card) return '?';
  if (card.suit === 'joker') {
    if (card.rank === 'big') return '大王';
    if (card.rank === 'small') return '小王';
    return '王';
  }
  return (SUIT_SYMBOLS[card.suit] || '') + (card.rank || '');
}

// Returns the horizontal distance between adjacent cards. The caller may
// render that distance as a negative overlap via CSS; keeping the calculation
// here makes the 44px touch-width rule independently testable.
export function handLayout({ count = 0, containerWidth = 0, cardWidth = 0, orientation = 'portrait' } = {}) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const width = Math.max(0, Number(containerWidth) || 0);
  const card = Math.max(0, Number(cardWidth) || 0);
  if (!total) return { rows: 1, perRow: 0, step: 0 };

  const usable = Math.max(0, width - card);
  const singleStep = total > 1 ? usable / (total - 1) : 0;
  let rows = 1;

  if (orientation === 'portrait') {
    // Portrait hands of 13-23 cards are capped at two rows. Smaller hands may
    // still fold when a single row would expose less than 44px per card.
    if (total >= 13 || (total > 1 && singleStep < MIN_CARD_STEP)) rows = 2;
  } else if (total > 1 && singleStep < MIN_CARD_STEP) {
    rows = 2;
  }

  const perRow = Math.ceil(total / rows);
  const step = perRow > 1 ? usable / (perRow - 1) : 0;
  return { rows, perRow, step };
}

export function sameIdSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const left = a.map(String).sort();
  const right = b.map(String).sort();
  return left.every((id, index) => id === right[index]);
}

export function playErrorToastText({ code = '', message = '' } = {}) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (/[\u3400-\u9fff]/.test(text)) return text;
  if (String(code).toUpperCase() === 'BAD_PLAY' || /FAILED_THROW_UNRESOLVED|ILLEGAL_RESPONSE|BAD_LEAD|THROW_NOT_TOP|CARD_NOT_IN_HAND/.test(text.toUpperCase())) {
    return '请重新选择要出的牌';
  }
  return text || '操作未完成';
}

export function seatTeamLabel(seatIndex, dealerIndex) {
  const seat = Math.trunc(Number(seatIndex));
  const dealer = Math.trunc(Number(dealerIndex));
  if (!Number.isFinite(seat) || !Number.isFinite(dealer)) return '';
  return seat % 2 === dealer % 2 ? '庄家方' : '闲家方';
}

export function hasAutoBurySnapshot(game) {
  if (!game) return false;
  if (game.buriedBy === 'auto') return true;
  const value = game.autoBury;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value === true || (typeof value === 'string' && value.trim().length > 0);
}

export function matchLegalPlay(selectedIds, legalPlays) {
  if (!Array.isArray(selectedIds) || !Array.isArray(legalPlays)) return null;
  return legalPlays.find((play) => sameIdSet(selectedIds, play.cardIds)) || null;
}

export function recommendedPlay({ legalPlays = [], kongPlays = [], playHints = null } = {}) {
  if (Array.isArray(kongPlays) && kongPlays.length) return kongPlays[0].cardIds.slice();
  if (playHints && playHints.auto && Array.isArray(playHints.allowed) && playHints.allowed.length) {
    return playHints.allowed.slice();
  }
  if (Array.isArray(legalPlays) && legalPlays.length) return legalPlays[0].cardIds.slice();
  if (playHints && Array.isArray(playHints.allowed) && playHints.allowed.length === 1) {
    return playHints.allowed.slice();
  }
  return [];
}

export function autoFourClearPlay({ trick = null, playHints = null, legalPlays = [] } = {}) {
  if (trick?.dimension !== 'four_clear' || playHints?.auto !== true) return null;
  if (!Array.isArray(legalPlays) || legalPlays.length !== 1) return null;
  const legalIds = legalPlays[0]?.cardIds;
  if (!Array.isArray(legalIds) || legalIds.length === 0) return null;
  const allowed = Array.isArray(playHints.allowed) ? playHints.allowed : legalIds;
  const cardIds = sameIdSet(allowed, legalIds) ? allowed : legalIds;
  return { cardIds: cardIds.map(String) };
}

export function dimensionLabel(dimension) {
  return ({
    single: '单张',
    throw: '甩牌',
    fake_kong: '假杠',
    true_kong: '真杠',
    four_clear: '四清',
  })[dimension] || '出牌';
}

export function isConstCard(card) {
  if (!card) return false;
  if (card.suit === 'joker') return true;
  if (card.suit === 'diamond' && card.rank === '5') return true;
  if (card.suit === 'spade' && card.rank === 'Q') return true;
  return card.rank === 'J' || card.rank === '2';
}

export function isTrumpCard(card, revealedIds = new Set()) {
  if (!card) return false;
  return isConstCard(card) || card.suit === 'heart' || revealedIds.has(card.id);
}

export function revealedPowerMap(revealed = []) {
  return new Map((revealed || []).filter(Boolean).map((item) => [item.id, item.power]));
}

// Display ordering only: trumps first, then side suits in the visual order
// used by the prototype. Legal play decisions remain server-owned.
export function sortHandForDisplay(cards, revealed = []) {
  const powers = revealedPowerMap(revealed);
  const revealedIds = new Set(powers.keys());
  const powerOf = (card) => powers.get(card.id) ?? card.power ?? 0;
  return (cards || []).slice().sort((a, b) => {
    const aTrump = isTrumpCard(a, revealedIds);
    const bTrump = isTrumpCard(b, revealedIds);
    if (aTrump !== bTrump) return aTrump ? -1 : 1;
    if (aTrump) return powerOf(b) - powerOf(a) || String(a.id).localeCompare(String(b.id));
    const aSuit = SIDE_SUIT_ORDER[a.suit] ?? 9;
    const bSuit = SIDE_SUIT_ORDER[b.suit] ?? 9;
    if (aSuit !== bSuit) return aSuit - bSuit;
    return powerOf(b) - powerOf(a) || String(a.id).localeCompare(String(b.id));
  });
}

export function uniqueCardIds(plays = []) {
  return [...new Set((plays || []).flatMap((play) => play.cardIds || []).map(String))];
}

// game/smoke.mjs — 规则引擎冒烟自检
import { Game, createDeck, basePower } from './game.mjs';

const deck = createDeck();
if (deck.length !== 54) throw new Error('deck length ' + deck.length);
const pw = basePower;
if (pw('diamond','5') !== 1000 || pw('joker','big') !== 799 || pw('joker','small') !== 798 || pw('spade','Q') !== 699 ||
    pw('heart','J') !== 599 || pw('club','J') !== 598 || pw('heart','2') !== 589 || pw('club','2') !== 588 ||
    pw('heart','A') !== 214 || pw('heart','3') !== 203 || pw('spade','A') !== 114 || pw('club','5') !== 105) {
  throw new Error('power table wrong');
}

let seed = 42;
const rng = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

const g = new Game(['甲','乙','丙','丁'], rng);
g.startRound();
let s = g.state();
console.log('round', s.roundNo, 'phase', s.phase, 'dealer', s.dealerIndex, 'hands', s.handCounts.join(','));
for (let i = 0; i < 4; i++) g.reveal(null);
s = g.state();
console.log('after reveal ->', s.phase);
if (s.phase !== 'bury') throw new Error('first round should skip tribute');
const dealerCards = s.hands[s.dealerIndex];
const noPoint = dealerCards.filter(c => c.points === 0);
if (noPoint.length < 6) throw new Error('expected 6 non-scoring cards to bury');
g.bury(noPoint.slice(0, 6).map(c => c.id));
s = g.state();
console.log('after bury ->', s.phase, 'leader', s.currentSeat, 'bottom', s.bottom.length);
let guard = 0;
while (s.phase === 'trick' && guard < 300) {
  const plays = g.legalPlays();
  if (plays.length === 0) throw new Error('no legal play at guard ' + guard);
  g.play(plays[0].cardIds);
  s = g.state();
  guard++;
}
console.log('tricks played', guard, 'phase', s.phase);
if (s.phase !== 'round_end') throw new Error('round not ended');
const r = g.roundResult();
console.log('result', JSON.stringify(r));
if (r.scores[0] + r.scores[1] !== 100) throw new Error('score total not 100');
g.nextRound();
s = g.state();
console.log('next round', s.roundNo, 'dealer', s.dealerIndex, 'phase', s.phase, 'tributePlan', s.tributePlan);
console.log('SMOKE OK');
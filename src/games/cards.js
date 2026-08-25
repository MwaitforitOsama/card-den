// Shared card primitives used by every game engine. Cards are 2-char
// strings: rank + suit. 'AS' = Ace of Spades, 'TD' = Ten of Diamonds.
// Ranks run low→high 2..A (ace high).

export const RANKS = '23456789TJQKA';
export const SUITS = 'SHDC';

export function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

export function shuffle(deck, rng = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function rankValue(card) {
  return RANKS.indexOf(card[0]);
}

export function suitOf(card) {
  return card[1];
}

// Display order for a hand: suits grouped (alternating colors), high to low.
const SUIT_DISPLAY_ORDER = 'SHCD';

export function sortHand(hand) {
  return [...hand].sort((a, b) => {
    const s = SUIT_DISPLAY_ORDER.indexOf(suitOf(a)) - SUIT_DISPLAY_ORDER.indexOf(suitOf(b));
    return s !== 0 ? s : rankValue(b) - rankValue(a);
  });
}

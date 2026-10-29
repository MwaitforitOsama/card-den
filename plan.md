# Plan: Thulla house rule — "Sarrein"

Status: **plan only — nothing implemented yet.** Every rule below was
confirmed by the product owner in conversation (2026-10-30). Anything not
listed here is unchanged Thulla behavior.

---

## 1. The rule, as agreed

### Names used below
- **B** — the player whose **last card wins a clean trick** (B's hand is now empty).
- **A** — the only other player still holding cards.

### When Sarrein starts
All of these must be true:
1. The **Sarrein** switch is ON for the room.
2. Exactly **2 players** still hold cards when the trick is played.
3. The trick is **clean** (both followed suit) and **B's card heads it**.
4. That card was **B's last card** — B's hand is now empty.
5. **A still holds at least one card** after the trick.

It does not matter who led that trick — A leading a lower club and B
answering with the 10♣, or B leading the 10♣ and A following lower, are
both Sarrein.

Cases that stay exactly as today (no Sarrein):
- **A's card heads the trick** (e.g. A plays K♣ over B's 10♣) and B is
  empty → game over, **A is Bhabhi**.
- **Both hands empty on the same trick** → **draw**.
- **B's last card is a thulla** (e.g. A leads 9♥, B has only the 10♣) →
  normal thulla: A picks up, B is empty and safe, **A is Bhabhi**.

### A Sarrein round
1. **A has exactly 1 card** when B must pick → **A loses** (A is Bhabhi).
   The game ends; no pick happens.
2. Otherwise A's remaining cards are **shuffled** and shown **face down to
   everyone** (A included — nobody sees which slot is which card).
3. **B taps one face-down card.** It leaves A's hand and lands **face up on
   the table as B's lead**. A gets no preview. **No undo** for the pick.
4. **A follows** from his own hand, normal follow-suit rules: if A holds
   the led suit he must play one, and **he chooses which**.
5. Resolution:

| A's response | Result |
|---|---|
| Plays the suit **higher** than B's card | **B wins** — A is Bhabhi. (Applies even if it was A's last card.) |
| Plays the suit **lower**, and **still has cards** | Clean trick → **next round**: B picks again. |
| Plays the suit **lower**, and that was **A's last card** | **A wins** — B is Bhabhi. (e.g. A holds 3♠ 2♠, B picks 3♠, A plays 2♠.) |
| Has **no card of the suit** → throws a thulla | B would have to pick up → **A wins** — B is Bhabhi. |

Rule of thumb confirmed by the owner: *whoever has to pick up the thulla
loses.*

### Restrictions during Sarrein
- **No concede** — the 🏳️ button is unavailable for both players.
- **No undo** on B's blind pick. (A's follow always resolves the round, so
  it has no undo window anyway — same as any trick-ending card today.)
- **No "take cards"** — already impossible with 2 players; unchanged.

### The switch
- Label: **`Sarrein: ON`** / **`Sarrein: OFF`**.
- **OFF by default.**
- Same behavior as the Rung switches: shown to everyone in the lobby and on
  the game-over screen; **only the host** can flip it; **only between
  games**; the setting sticks for the room.

---

## 2. Worked examples (to become unit tests)

| # | Setup | Moves | Expected |
|---|---|---|---|
| E1 | A: 6 cards incl. 5♣; B: 10♣. A leads. | A 5♣, B 10♣ | Sarrein starts, A has 5 cards, B to pick |
| E2 | Same hands, B leads | B 10♣, A 5♣ | Sarrein starts |
| E3 | A: K♣ + others; B: 10♣ | B 10♣, A K♣ | Game over, A Bhabhi (no Sarrein) |
| E4 | A: 6 cards incl. 9♥; B: 10♣. A leads. | A 9♥, B 10♣ (thulla) | A picks up, A Bhabhi (unchanged) |
| E5 | Switch OFF, E1 moves | — | Game over, A Bhabhi (today's behavior) |
| E6 | Sarrein, A has 1 card | — | A loses immediately |
| E7 | Sarrein, A: K♠ 2♠ | B picks 2♠, A must play K♠ | B wins (A Bhabhi) |
| E8 | Sarrein, A: 3♠ 2♠ | B picks 3♠, A plays 2♠ | A wins (B Bhabhi) |
| E9 | Sarrein, A: 3♦ 7♣ 9♥ | B picks 3♦, A has no ♦ → plays 7♣ | A wins (B Bhabhi) |
| E10 | Sarrein, A: 9♦ 4♦ K♠ | B picks 9♦, A plays 4♦ | Next round, B picks again from {K♠} → E6 path: A has 1 card → A loses |
| E11 | Sarrein, A: Q♦ 4♦ 2♦ 7♣ | B picks 4♦, A chooses Q♦ | B wins |
| E12 | Sarrein active | A or B sends concede | Rejected |

Open check for E10: after the clean round A holds 1 card, so per rule
round-step 1 **A loses** before any pick. (Matches the agreed "A has only
one card → A loses".)

---

## 3. Implementation plan

### 3.1 Engine — `src/games/thulla/engine.js`
- `createGame(numPlayers, rng, rules = {})` — store `state.rules =
  { sarrein: !!rules.sarrein }`.
- New state fields:
  - `sarrein: null | { picker: B, holder: A, order: [cards…] }`
    — `order` is A's hand reshuffled each round (server-only; never sent).
- In `playCard`, clean-trick branch (trick 2+): before `markSafe`, detect
  the start conditions in §1; if met, **don't mark B safe**, enter Sarrein
  (or end immediately if A has exactly 1 card), emit
  `{ type: 'sarrein_started', picker, holder }`.
- New `sarreinPick(state, seat, slot)`:
  - validates `seat === picker`, `slot` in range;
  - removes `order[slot]` from A's hand, puts it in the trick as B's lead,
    sets `ledSuit`, `turn = holder`; emits `{ type: 'sarrein_pick', seat, card }`.
- `legalMoves` for A during Sarrein = normal follow-suit over A's hand
  (A chooses). B has no legal hand moves (his "move" is the pick).
- Resolve A's follow (inside `playCard` when `state.sarrein`):
  higher → B wins; lower & cards left → next round (reshuffle, A 1-card
  check); lower & empty → A wins; off-suit → A wins.
  Ends via `phase = 'over'`, `bhabhi = loser`, `game_over` event plus
  `{ type: 'sarrein_result', winner, loser, reason }` for toasts.
- `canConcede` → `null` while `state.sarrein`.
- `undoPlay` → nothing to undo (`lastPlay` stays `null` for picks/follows).

### 3.2 Adapter — `src/games/thulla/adapter.js`
- `settings: { sarrein: { default: false } }` (enables the room's
  existing `set_rule` handler — no room changes needed for toggling).
- `start(room)` → `createGame(n, Math.random, room.rules?.thulla ?? {})`.
- `gameView`: add `sarrein: { picker, holder, slots: order.length }` —
  **slot count only, never the cards** — and `youPick: seat === picker`;
  `rules: { sarrein }` so the table can show it's on.
- New action `sarrein_pick(R, ws, seat, msg)` → `R.handleMove(ws, () =>
  sarreinPick(game, seat, msg.slot))`.

### 3.3 Room — `src/room.js`
- No rule-plumbing changes (generic `set_rule` already validates against
  `adapter.settings`). Verify the grace-timer auto-restart path also passes
  rules (it goes through `startNewGame → adapter.start`, so it should).
- Confirm `handleMove` doesn't open an undo window for the pick
  (`lastPlay` is null).

### 3.4 Client
- `index.html`: add `<button id="rule-sarrein" class="rule-toggle" hidden>`.
- `game-view.js`: add `#rule-sarrein` to the hide-list.
- `thulla-view.js`:
  - Rule toggle in lobby/over (same helper as Rung, but **default OFF** —
    Rung's helper assumes `?? true`, so pass the default explicitly).
  - During Sarrein: render A's `slots` as face-down cards in the center;
    clickable only for the picker (`youPick`) → `send({ type:
    'sarrein_pick', slot })`. Everyone else sees them disabled.
  - Status line: "Sarrein — B picks one of A's cards" / "A to answer".
  - Chip sub-text for B: "Sarrein" instead of "0 cards".
  - Hide 🏳️ Concede while Sarrein is active.
  - Toasts: `sarrein_started` ("⚔️ Sarrein! B picks from A's cards"),
    `sarrein_pick`, `sarrein_result` (who won and why).
- `how-to-play.html`: new Thulla section "Switch: Sarrein" with the rules
  table and an animated scene; mention in Room → host controls.
- `README.md`: add Sarrein to the Thulla house rules.

### 3.5 Tests
- `test/engine.test.js`: E1–E12 with hand-built states, plus a randomized
  full-game run with Sarrein ON asserting every game terminates with a
  valid bhabhi/draw.
- `test/integration/`: toggle Sarrein via `set_rule` (host only, between
  games only), and a forced Sarrein flow over WebSockets (rigged deal or a
  test hook — decide during implementation without changing rules).

---

## 4. Not in scope
- Bots (Thulla has none).
- Any change to Thulla behavior when the switch is OFF.
- Sarrein with 3+ players left.

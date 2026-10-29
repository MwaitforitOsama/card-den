# Taash Adda — Card Den

Online card nights for the daily gang — play from anywhere when meeting up
isn't possible. Two games in one room: **Bhabhi Thulla** and **Rung (Court
Piece)**. One Cloudflare Worker (named `card-den`) serves the frontend and
hosts the game server (a Durable Object per room over WebSockets), so the
same code runs locally and on Cloudflare's free tier.

## Run locally

You only need [Node.js](https://nodejs.org) 18+ — no Cloudflare account, no
build step, nothing else.

```sh
npm install
npm run dev        # starts everything on http://localhost:8787
```

Open http://localhost:8787 in several browser tabs (or on phones on the same
network) to play. One person picks a game (Thulla or Rung), creates a room,
and taps the room code in the header to copy an invite link
(`…/?gamecode=XXXX`) — anyone opening it joins automatically (first-timers
are asked their name once). Typing the 4-letter code by hand still works
too. Between games the host can switch what the room plays with the
⇄ button — same code, same chat and voice call.

## How to play

New players: open `/how-to-play.html` (linked as 📖 on the home screen and
❓ in the table header). It covers Thulla, Rung with its house-rule
switches, and the room's buttons, with worked examples.

## Test

```sh
npm test           # engine unit tests, both games (node --test)
```

## Thulla — house rules (as implemented)

- 3–7 players, 52 cards dealt as equally as possible, ace high.
- The Ace of Spades opens trick 1 — the server throws it automatically for
  its holder (forced play, no undo). Trick 1 always goes to the waste pile —
  an off-suit card on trick 1 doesn't end it and nobody picks up.
- From trick 2: follow suit if you can. An off-suit card (**thulla**) ends
  the trick instantly; the highest card of the led suit picks up the whole
  trick and leads next. Clean tricks go to the waste pile and the highest
  card of the led suit leads next.
- **Taking cards**: the leader, before leading (trick 2+), may ask to take
  the whole hand of the next player with cards — the transfer only happens
  if that player approves. A decline can be re-asked; the request cancels
  automatically if the asker plays a card instead. The player whose cards
  are taken is instantly Safely Bahar. Not allowed when only 2 players
  remain.
- No waste-pile draw: winning a clean trick with your last card still makes
  you safe; the next player with cards leads.
- Last player holding cards is the **bhabhi**. If the final players all empty
  their hands on the same trick, it's a draw.
- **Conceding**: when only 2 players still hold cards and the endgame is a
  foregone conclusion, either of them can press 🏳️ Concede. The opponent
  must accept — then the game ends immediately with the conceder losing
  (game parr gayi) and the opponent the winner. Declining keeps the game
  going, and the offer can be re-made anytime; playing a card cancels a
  pending offer.

## Rung — house rules (Pakistani double-sar, as implemented)

- Exactly 4 players in fixed partnerships: seats 1 & 3 vs seats 2 & 4
  (partners opposite). The host arranges who sits where — in the lobby or
  between games, tap two players to swap them. With more than 4 seated, the
  first four seats play and the rest sit that deal out.
- **Who calls the rung**: the first game opens with a toss — one card
  each, face up, highest card's owner calls. Opposite-team ties re-toss
  just the tied players; a tie within one team hands that team the call.
  From then on the pair that won the previous game decides between
  themselves (first to tap "I'll pick the rung" — argue it out on voice),
  falling back to a toss whenever the old result can't apply (aborted
  game, Thulla in between, a winner left, seat swaps split the pair).
  **Nothing is dealt until the caller is decided.**
- The caller is dealt 5 cards along with everyone else and picks the rung
  from those 5, announced to the table. The rest is then dealt 4 + 4
  (5 + 4 + 4 = 13 cards each) and the caller leads the first sar.
- Follow suit if you can; anything (including trump) if you can't. Highest
  trump heads the sar, otherwise the highest card of the led suit; the
  header leads the next sar.
- **Heading a sar does not take it.** Completed sars pile up face-up in the
  middle. The pile is picked up only when the **same player** heads a sar
  and then stays unbeaten leading the next one — anyone overtaking the
  leader (opponents *and* partners) spoils the pickup and inherits the
  lead with the same burden.
- Sars 1–4 can never be picked up; the earliest pickup is sar 5, and a
  pickup takes the **whole pile** for the team (winning sar 5 = 5 sars at
  once).
- The sar right after a pickup is **barred** — nobody can take it, it
  starts the new pile. The same player may still earn the very next pile
  (pick up 5, head barred 6, defend 7 → takes 6+7).
- All 13 sars are played out, and the final sar's header always takes
  whatever is left on the table — so team totals sum to 13. First team
  past 7 wins (announced the moment it's decided, margin still plays out);
  13–0 is a **whitewash** 🧹.
- **Ace can't win the sar** (university house rule, on by default): defending the
  lead with any Ace keeps you senior but picks up nothing — the pile
  stays, your lead stays, and the next sar is winnable as normal. The 13th
  sar is immune. A 🂡 toggle in the lobby (and on the game-over screen)
  shows the rule to everyone; the host can flip it between games for
  guests who play classic rung, and the setting sticks for the room.
- **Two Aces together equal a 2** (university house rule, on by default,
  own 🂡🂡 toggle): if your card in the previous sar was a full Ace that
  **stayed senior** — it headed the sar when it resolved — an Ace from
  you in this sar fights as the 2 of its suit (a demoted trump Ace is
  still a trump, just the lowest one). It's no longer an "Ace", so it CAN
  win the sar. An Ace that got cut or thrown off-suit arms nothing — you
  were never senior. A pickup-blocked Ace (the 🂡 rule) still headed the
  sar, so it arms. Pairs only: the demotion consumes the pair, a third
  consecutive Ace is a full Ace again, and any non-Ace resets. It's a **trap**: there is no advance warning — the
  demotion is revealed only as the card lands ("counts as 2"), and that
  throw is final (no undo). Remember your own last card.
- **Cannot win sar with Rung** (university house rule, on by default, own
  🎺 toggle): a sar led with the rung suit can never be picked up (except
  sar 13) — the pile stays, the leader keeps the lead, no bar. Leading
  rung is therefore a **flush**: on an otherwise-winnable sar the opposite
  team must beat the led rung card if they can. Team-smart — an earlier
  opponent may hold back only while their partner still to act holds a
  bigger rung card — and released the moment anyone overtakes the lead.
  Follow-suit is never broken, and only cards that genuinely beat the led
  card at effective rank qualify (a trap-armed Ace counts as a 2 and is
  never compelled). Collecting the pile always takes a plain-suit lead.
- One deal per game; Play Again re-deals with the dealer seat rotating, so
  the rung call moves around the table.

## The bot (Rung seat-filler)

Three friends, no fourth? The host can seat **Botta 🤖** from the Rung
lobby (one bot max). It plays strictly by the rules — a random legal
card on its turn, its longest suit if the toss makes it the caller — and
never claims the rung call (its human partner does). It pauses ~3
seconds before every action ("🤖 Botta is thinking…") so the table can
follow what it throws; the previous player's undo window stays open
during the pause, same as against a slow human. Beyond that the game
never waits on it: no grace timer, no voice, no undo. The host can
eject it anytime via the ✕ on its chip — mid-game ejection dissolves the
deal (nothing counted) — and switching the room to Thulla sends it home
automatically.

## Session scoreboard

Every finished game is tallied: the room counts total games played, and each
seated player carries a 🎮 games / 🏆 wins / 💀 losses record (shown small
on their chip and as full standings on the game-over screen, biggest loser
👑 on top). Thulla only ever awards losses (there is no winner, only the
bhabhi); Rung awards a win or a loss to all four — and whitewash sweeps are
counted separately. Stats survive reconnects but are wiped when a player
leaves the room; games aborted by a disconnect don't count.

## Disconnects

The **host can dissolve** a running game (two-tap 🛑 button): it aborts
with nothing recorded — no scoreboard change — and everyone returns to the
lobby with seats kept, ready to restart or switch games. **Rejoining
under the same name reclaims your seat** while the server still holds it
(the grace window): a browser restart, a deliberate Leave-and-return,
even a different device — the name is the identity in a friends room.

If a player drops mid-game, everyone sees a 30-second countdown. If they
reconnect in time the game simply continues; if not, they are removed and a
fresh game starts automatically among the remaining players (back to the
lobby if too few remain). Thulla players who already got away can disconnect
freely — the game doesn't wait for them.

## Voice

Voice is opt-in: tap 🎧 to join the room's push-to-talk call, then hold
the 🎙 button (or Space on desktop) to talk. Audio flows directly between
voice members over a WebRTC mesh — the server only relays the handshake
and tracks who joined. To spare phone batteries the mesh is silent when
idle: the mic is attached only while the button is held (nothing is
encoded or sent otherwise), the mic is released after 15s without a press,
Opus runs mono with DTX at ~20 kbps, and a tab left in the background
leaves voice after a minute. Spectators can listen but not talk. Mic access needs a secure context: it works
on http://localhost, but **testing voice from phones requires the HTTPS
`workers.dev` URL** (`npm run deploy`), not a LAN IP.

If a voice link dies (VPN toggle, Wi-Fi switch, flaky network), it heals
itself: a brief grace for blips, then an ICE restart — fresh candidates
over the same connection — retried with backoff up to 4 times before
giving up on that peer (a toast says who) until the roster or the network
changes. The mesh is UDP-only by design (no TURN relay): if two players
on hostile networks still can't hear each other, that's the known ceiling
— chat and the game are unaffected.

## Layout

- `src/worker.js` — Worker entry: routing + room codes; static assets binding
- `src/room.js` — `GameRoom` Durable Object, game-agnostic: seats, chat,
  spectators, grace timer (alarms), undo window, scoreboard, WebSockets,
  personalized state broadcasts. Delegates rules to the room's game adapter.
- `src/games/` — one directory per game, plugged in via `games/index.js`:
  - `cards.js` — shared deck/rank/sort primitives
  - `thulla/engine.js` + `thulla/adapter.js` — pure Thulla rules + room glue
  - `rung/engine.js` + `rung/adapter.js` — pure Rung rules + room glue
- `src/bots/` — bot players, a separate entity from the game code: the
  registry (`index.js`) plus one brain per game (`rung-bot.js`), consuming
  each engine's public API only
- `public/js/` — frontend ES modules, no build step:
  `main.js` (wiring/boot) · `socket.js` (connection lifecycle) ·
  `game-view.js` (shared table frame: chips, hand, timers, overlay) ·
  `views/table-common.js` (trick area, animations, standings) ·
  `views/thulla-view.js` · `views/rung-view.js` · `chat.js` · `cards.js` ·
  `session.js` · `toast.js` · `dom.js`
- `test/engine.test.js`, `test/rung.test.js` — unit tests incl. randomized
  full-game runs
- `test/integration/` — end-to-end tests against a running dev server:
  `node test/integration/smoke.mjs` (full Thulla games, reconnect, rematch),
  `rung-test.mjs` (game switching, seat swaps, a full Rung deal, stats),
  `chat-test.mjs`, `grace-test.mjs` (~35s, real 15s timers).
  Set `PORT=…` if the server isn't on 8787.

## Deploy

Runs on Cloudflare's **free tier** (Workers + SQLite-backed Durable
Objects): 100k requests/day, far more than nightly games will ever use.

```sh
npx wrangler login   # one-time: opens the browser to authorize your account
npm run deploy
```

The first deploy asks you to pick a `workers.dev` subdomain for your
account; after that the game is live at
`card-den.<your-subdomain>.workers.dev` (the worker name comes from
`wrangler.jsonc`). Note that phone microphones only work over HTTPS, so
voice chat needs the deployed URL — `npm run dev` on a LAN IP won't do it.

## Credits & license

- Code: Apache-2.0 (see [LICENSE](LICENSE)).
- Card faces: [Vector Playing Cards](https://totalnonsense.com/open-source-vector-playing-cards/)
  by Chris Aguilar, LGPL-3.0 — see `public/cards/LICENSE.txt`.

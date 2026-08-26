// Bot registry: games that can seat a bot plug one in here, keyed by game
// id — entirely outside the game engines and adapters. A game without an
// entry simply has no bot (the room refuses to seat one).

import { rungBot } from './rung-bot.js';

export const BOTS = { rung: rungBot };

// Game registry: every playable game plugs in here as an adapter with a
// common interface (see thulla/adapter.js for the reference shape). A room
// is bound to one game id at a time; the host can switch between games.

import { thulla } from './thulla/adapter.js';
import { rung } from './rung/adapter.js';

export const GAMES = { thulla, rung };
export const DEFAULT_GAME = 'thulla';

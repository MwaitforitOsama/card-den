// Identity storage. The session (room + seat token) is per-tab so several
// tabs in one browser are separate players; localStorage keeps a backup so a
// killed tab (e.g. on a phone) can rejoin its seat on next boot.

const SESSION_KEY = 'thulla-session';
const NAME_KEY = 'thulla-name';

const parse = raw => { try { return JSON.parse(raw); } catch { return null; } };

export const loadName = () => localStorage.getItem(NAME_KEY) || '';
export const saveName = name => localStorage.setItem(NAME_KEY, name);

export const tabSession = () => parse(sessionStorage.getItem(SESSION_KEY));
export const backupSession = () => parse(localStorage.getItem(SESSION_KEY));

export function saveSession(session) {
  if (session) {
    const raw = JSON.stringify(session);
    sessionStorage.setItem(SESSION_KEY, raw);
    localStorage.setItem(SESSION_KEY, raw);
  } else {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
  }
}

// Leaving a room on purpose PARKS the session instead of destroying it:
// boot never auto-resumes a parked room, but a manual rejoin of the same
// room under the same name can still reclaim the seat (while the server
// keeps it — the grace window).
const PARKED_KEY = 'thulla-parked';

export const parkedSession = () => parse(localStorage.getItem(PARKED_KEY));

export function parkSession(session) {
  if (session) localStorage.setItem(PARKED_KEY, JSON.stringify(session));
}

/**
 * Set detection — deciding from the index which rows belong to one group,
 * so a single Enter can act on all of them.
 *
 * A set ("Open all 5 items") is a fact about the index in almost every case that
 * matters: a named bookmark folder, an explicit "all of these", or a time
 * window. Those are not judgements, so they belong in code — which also means
 * they no longer wait ~800 ms on a network call, and they cannot be wrong because
 * a model hedged.
 *
 * Three rules, first match wins:
 *   1. the query names a collection — a bookmark folder that is not one of the
 *      browser's own containers
 *   2. the query explicitly asks for all of something
 *   3. the query has a time window and several rows fall inside it
 */

import { normalize, stripFillers, tokenize } from './fuzzy.js';

/** Folder names the browsers invent. Not collections the user named. */
const DEFAULT_FOLDERS = new Set([
  'bookmarks',
  'bookmarks bar',
  'other bookmarks',
  'mobile bookmarks',
  'unfiled',
  'menu',
  'toolbar',
  'mozilla firefox',
]);

/** Asking for everything, in so many words. */
const EXPLICIT_ALL = /\b(all|every|each|both|these|those|them)\b/i;

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 25;

function isNamedFolder(folder) {
  return Boolean(folder) && !DEFAULT_FOLDERS.has(normalize(folder));
}

/**
 * @param {object} args
 * @param {string} args.query
 * @param {object|null} args.timeWindow
 * @param {Array<{row: object, fuzzy: number}>} args.scored  the whole scored pool, pre-truncation
 * @returns {{active: boolean, members?: object[], rule?: string, label?: string}}
 */
export function detectSet({ query, timeWindow = null, scored = [] }) {
  const text = String(query ?? '').trim();
  if (text.length === 0 || scored.length < MIN_MEMBERS) return { active: false };

  // 1. A named collection. Scored so the best-matching folder wins — otherwise
  // "my ChaiCode bookmarks" would also swallow the browser's own "Bookmarks".
  const tokens = stripFillers(tokenize(text));
  let bestFolder = null;
  let bestScore = 0;
  for (const { row } of scored) {
    if (!isNamedFolder(row.folder)) continue;
    const folderWords = normalize(row.folder).split(' ');
    const score = tokens.filter((token) => folderWords.some((word) => word === token || word.startsWith(token))).length;
    if (score > bestScore) {
      bestScore = score;
      bestFolder = row.folder;
    }
  }
  if (bestFolder && bestScore > 0) {
    const members = scored
      .filter(({ row }) => row.folder === bestFolder)
      .map(({ row }) => row)
      .slice(0, MAX_MEMBERS);
    if (members.length >= MIN_MEMBERS) return { active: true, rule: 'folder', label: bestFolder, members };
  }

  // 2. An explicit request for everything.
  if (EXPLICIT_ALL.test(text)) {
    const members = scored
      .filter(({ fuzzy }) => fuzzy >= 0.6)
      .map(({ row }) => row)
      .slice(0, MAX_MEMBERS);
    if (members.length >= MIN_MEMBERS) return { active: true, rule: 'explicit-all', members };
  }

  // 3. A time window. The pool is already restricted to the window by the engine,
  // so "the rows in it" is simply the pool.
  if (timeWindow) {
    // 0.6, not 0.4: a lower bar swept marginal rows into the set and produced
    // "Open all 25 items" for a phrase that meant a handful of links.
    const members = scored
      .filter(({ fuzzy }) => fuzzy >= 0.6)
      .map(({ row }) => row)
      .slice(0, MAX_MEMBERS);
    if (members.length >= MIN_MEMBERS) return { active: true, rule: 'time-window', label: timeWindow.label, members };
  }

  return { active: false };
}

/**
 * The row the panel draws for a detected set. `members` is what the executor
 * resolves when Enter is pressed — the whole set, not just the visible part.
 */
export function groupRow({ members, label, rule }) {
  const where = label ? (rule === 'time-window' ? `from ${label}` : `in ${label}`) : null;
  return {
    id: '__set__',
    kind: members[0]?.kind ?? 'open_url',
    title: `Open all ${members.length} ${members.length === 1 ? 'item' : 'items'}`,
    detail: where ? `Everything ${where}` : 'Press Enter to open the whole set',
    icon_kind: 'named',
    icon: 'view-list-symbolic',
    isGroup: true,
    // A set detected by rule is confident by construction: folder membership and
    // time windows are facts, and "all" is the user's own word.
    ready: true,
    score: 1,
    members,
  };
}

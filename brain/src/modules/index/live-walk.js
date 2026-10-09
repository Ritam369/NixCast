/**
 * Live name search — walks configured roots on demand instead of indexing them.
 *
 * Why this exists: the file index covers a fixed set of folders, which is what
 * keeps a keystroke instant and keeps Jev's candidate list small. The cost is
 * that anything outside those folders is invisible — a removable drive, a photo
 * library, a project tree. Indexing everything is not the answer either: the
 * walk cost would move into the refresh, and a large tree would swamp the
 * candidate budget with rows nobody asked for.
 *
 * So this walks only when the index could not answer the query, and it walks
 * under a hard deadline. The local phase must stay instant, which means partial
 * results are acceptable and a truncated walk is a normal outcome, not an error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileIconFor, relativeAge, safeStat } from '../../common/utils.js';

const DEFAULTS = {
  enabled: true,
  timeoutMs: 120,
  maxDepth: 6,
  maxResults: 8,
  minQueryLength: 3,
  maxEntries: 20_000,
};

/**
 * "grep the tree by name": a case-insensitive substring test on the file name.
 * Deliberately literal — the fuzzy scorer and Jev handle ranking later, and a
 * walk that tried to be clever would be slow and unpredictable.
 */
function nameMatches(fileName, needle) {
  return fileName.toLowerCase().includes(needle);
}

/** Where a hit lives, in the shortest form that is still unambiguous. */
function labelFor(root, dir) {
  const relative = path.relative(root, dir);
  const rootName = path.basename(root);
  return relative ? `${rootName}/${relative}` : rootName;
}

/**
 * @param {object} args
 * @param {string[]} args.roots      absolute directories to walk
 * @param {string} args.query        what the user typed
 * @param {object} [args.config]     overrides for the DEFAULTS above
 * @returns {{rows: object[], stats: object}}
 */
export function walkForQuery({ roots = [], query = '', config = {}, now = Date.now() }) {
  const opts = { ...DEFAULTS, ...config };
  const needle = String(query ?? '').trim().toLowerCase();

  const stats = { roots: roots.length, scanned: 0, dirs: 0, matches: 0, truncated: false, elapsedMs: 0, skipped: null };
  if (!opts.enabled) return { rows: [], stats: { ...stats, skipped: 'disabled' } };
  if (needle.length < opts.minQueryLength) return { rows: [], stats: { ...stats, skipped: 'query too short' } };
  if (roots.length === 0) return { rows: [], stats: { ...stats, skipped: 'no search roots' } };

  const started = now;
  const deadline = started + opts.timeoutMs;
  const found = [];

  /** Depth-first, newest-first within a directory, aborting the moment we run out of budget. */
  const visit = (dir, root, depth) => {
    if (stats.scanned >= opts.maxEntries || Date.now() > deadline) {
      stats.truncated = true;
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unmounted drive, or a directory we may not read
    }
    stats.dirs += 1;

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      stats.scanned += 1;
      if (stats.scanned >= opts.maxEntries || Date.now() > deadline) {
        stats.truncated = true;
        return;
      }

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // A folder can be exactly what the user is looking for — "open the
        // ChaiAurCode folder" — so a matching directory becomes a row too, by the
        // same name test as a file. plocate already returned folders; this makes
        // the two sources agree. It still recurses either way.
        if (nameMatches(entry.name, needle)) {
          const dirStat = safeStat(full);
          const dirIcon = fileIconFor(full, dirStat);
          found.push({
            id: `file:${full}`,
            kind: 'open_file',
            title: entry.name,
            detail: `Found in ${labelFor(root, dir)} · folder`,
            keywords: `${entry.name} ${labelFor(root, dir)}`,
            icon_kind: dirIcon.icon_kind,
            icon: dirIcon.icon,
            path: full,
            mtime: dirStat?.mtimeMs ?? 0,
            isDir: true,
            liveWalk: true,
          });
          stats.matches += 1;
        }
        if (depth < opts.maxDepth) visit(full, root, depth + 1);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (!nameMatches(entry.name, needle)) continue;

      const stat = safeStat(full);
      if (!stat) continue;
      const icon = fileIconFor(full, stat);

      found.push({
        id: `file:${full}`,
        kind: 'open_file',
        title: entry.name,
        detail: `Found in ${labelFor(root, dir)} · ${relativeAge(stat.mtimeMs, now)}`,
        keywords: `${entry.name} ${labelFor(root, dir)}`,
        icon_kind: icon.icon_kind,
        icon: icon.icon,
        path: full,
        mtime: stat.mtimeMs,
        isDir: false,
        size: stat.size,
        liveWalk: true,
      });
      stats.matches += 1;
    }
  };

  for (const root of roots) {
    visit(root, root, 0);
    if (stats.truncated && Date.now() > deadline) break;
  }

  // Prefer the most literal hit: an exact name, then a prefix, then the shortest
  // name, then the most recently modified. Ranking quality beyond that is Jev's
  // job, and this keeps the candidate list genuinely useful when it is truncated.
  const rank = (row) => {
    const name = row.title.toLowerCase();
    if (name === needle) return 0;
    if (name.startsWith(needle)) return 1;
    return 2;
  };
  found.sort((a, b) => rank(a) - rank(b) || a.title.length - b.title.length || b.mtime - a.mtime);

  stats.elapsedMs = Date.now() - started;
  return { rows: found.slice(0, opts.maxResults), stats };
}

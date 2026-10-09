/**
 * Whole-disk name search, via plocate.
 *
 * plocate keeps a prebuilt database of every path on the machine, so a lookup
 * costs about ten milliseconds instead of a filesystem walk. That is what makes
 * "find this file anywhere" possible without either indexing everything up front
 * or walking gigabytes on every keystroke.
 *
 * Two honest limits, both of which the live walk covers instead: it matches
 * *names*, not file contents, and it only knows what existed when the database
 * was last rebuilt (NixOS does that on a timer).
 */

import path from 'node:path';
import { createLogger } from '../../common/logger.js';
import { fileIconFor, safeStat } from '../../common/utils.js';

const log = createLogger('index.plocate');

const DEFAULTS = {
  enabled: true,
  timeoutMs: 400,
  maxResults: 10,
  minQueryLength: 3,
  strongMatch: 0.6,
};

/**
 * Paths that are technically real files but are almost never what someone means
 * when they type a filename into a launcher: build output, version control
 * internals, caches, the Windows recycle bin. They are *marked*, not filtered —
 * the engine ranks them lower, so a query that only matches inside node_modules
 * still finds its file, just below everything else.
 */
const NOISY_PATH =
  /\/(node_modules|\.pnpm-store|\.git|\.cache|\.vscode\/extensions|\.local\/share\/trash|\$recycle\.bin|\.trash-1000|system volume information|appdata\/(local|roaming)\/(temp|packages))\//i;

export function isNoisyPath(filePath) {
  return NOISY_PATH.test(String(filePath ?? ''));
}

let cachedBinary;

/** The plocate binary, or null. Cached — the answer cannot change mid-session. */
export function plocateBinary() {
  if (cachedBinary !== undefined) return cachedBinary;
  cachedBinary = Bun.which('plocate') ?? Bun.which('locate') ?? null;
  if (!cachedBinary) log.debug('plocate is not installed, so whole-disk search is off');
  return cachedBinary;
}

/** One hit -> one row, in the same shape the rest of the index uses. */
export function rowForPath(filePath, now = Date.now()) {
  const stat = safeStat(filePath);
  // The database can be older than the filesystem: a path may be gone.
  if (!stat) return null;

  const icon = fileIconFor(filePath, stat);
  const parent = path.basename(path.dirname(filePath));
  return {
    id: `file:${filePath}`,
    kind: 'open_file',
    title: path.basename(filePath) || filePath,
    detail: `On disk · ${parent}${stat.isDirectory() ? ' · folder' : ''}`,
    keywords: `${path.basename(filePath)} ${filePath}`,
    icon_kind: icon.icon_kind,
    icon: icon.icon,
    path: filePath,
    mtime: stat.mtimeMs,
    isDir: stat.isDirectory(),
    size: stat.size,
    foundBy: 'plocate',
    noisy: isNoisyPath(filePath),
  };
}

/**
 * @returns {{rows: object[], stats: object}} never throws; a missing database or
 * a slow lookup simply yields no rows.
 */
export function searchByName({ query = '', config = {}, now = Date.now() }) {
  const opts = { ...DEFAULTS, ...config };
  const started = Date.now();
  const stats = { scanned: 0, matches: 0, elapsedMs: 0, truncated: false, skipped: null };

  // Ordered so the reason describes the caller's input first and the machine
  // second: "query too short" must not depend on plocate being installed.
  if (opts.enabled === false) return { rows: [], stats: { ...stats, skipped: 'disabled' } };

  const needle = String(query).trim();
  if (needle.length < opts.minQueryLength) return { rows: [], stats: { ...stats, skipped: 'query too short' } };

  const binary = plocateBinary();
  if (!binary) return { rows: [], stats: { ...stats, skipped: 'plocate is not installed' } };

  // Ask for more than we need: some hits will have been deleted since the
  // database was built. `-b` matches on the basename and `--` stops the query
  // from being read as an option.
  const limit = Math.max(opts.maxResults * 3, 20);
  let text = '';
  try {
    const proc = Bun.spawnSync([binary, '-i', '-b', '-l', String(limit), '--', needle], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: opts.timeoutMs,
    });
    text = proc.stdout?.toString() ?? '';
    if (proc.exitCode !== 0 && text.length === 0) {
      return { rows: [], stats: { ...stats, elapsedMs: Date.now() - started, skipped: `plocate exited ${proc.exitCode}` } };
    }
  } catch (err) {
    // Most likely the timeout killed it, which is a normal outcome on a cold
    // database. Not an error worth surfacing.
    log.debug('plocate lookup did not finish', String(err));
    return { rows: [], stats: { ...stats, elapsedMs: Date.now() - started, skipped: 'timed out' } };
  }

  const seen = new Set();
  const rows = [];
  for (const line of text.split('\n')) {
    const candidate = line.trim();
    if (candidate.length === 0) continue;
    stats.scanned += 1;
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const row = rowForPath(candidate, now);
    if (!row) continue;
    rows.push(row);
    stats.matches += 1;
    if (rows.length >= opts.maxResults) {
      stats.truncated = true;
      break;
    }
  }

  stats.elapsedMs = Date.now() - started;
  return { rows, stats };
}

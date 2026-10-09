/**
 * Browser history — the Linux replacement for the macOS launcher's
 * ChromeHistory.swift.
 *
 * Firefox (places.sqlite) and the Chromium family (History, a SQLite file)
 * both hold their database open and locked while the browser runs, so we copy
 * the file (plus its -wal/-shm companions) to a temporary location and read
 * the copy. The browser database never leaves the machine; only the handful of
 * surviving candidates are ever sent to Jev.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { createLogger } from '../../common/logger.js';
import { paths } from '../../common/paths.js';
import { visitAge } from '../search/time-window.js';

const log = createLogger('index.history');

/** Chromium timestamps are microseconds since 1601-01-01. */
const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000;

function copyDatabase(file) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-history-'));
  const copy = path.join(tmpDir, path.basename(file));
  fs.copyFileSync(file, copy);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${file}${suffix}`)) {
      try {
        fs.copyFileSync(`${file}${suffix}`, `${copy}${suffix}`);
      } catch {
        /* a missing WAL only costs us the newest visits */
      }
    }
  }
  return { copy, tmpDir };
}

function withDatabase(file, fn) {
  const { copy, tmpDir } = copyDatabase(file);
  let db;
  try {
    db = new Database(copy, { readonly: true });
    return fn(db);
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readFirefoxProfiles() {
  const ini = paths.firefoxProfilesIni;
  if (!fs.existsSync(ini)) return [];

  const profiles = [];
  let current = null;
  for (const line of fs.readFileSync(ini, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      if (current) profiles.push(current);
      current = trimmed.startsWith('[Profile') ? { isDefault: false } : null;
      continue;
    }
    if (!current) continue;
    const [key, ...rest] = trimmed.split('=');
    const value = rest.join('=');
    if (key === 'Path') current.relativePath = value;
    if (key === 'IsRelative') current.isRelative = value === '1';
    if (key === 'Default') current.isDefault = value === '1';
  }
  if (current) profiles.push(current);

  return profiles
    .filter((p) => p.relativePath)
    .map((p) => {
      const dir = p.isRelative ? path.join(paths.firefoxDir, p.relativePath) : p.relativePath;
      return { dir, isDefault: p.isDefault, places: path.join(dir, 'places.sqlite') };
    })
    .filter((p) => fs.existsSync(p.places));
}

function chromiumProfiles(config) {
  const out = [];
  const wanted = new Set(config.index.browsers ?? []);
  for (const brand of paths.chromiumBrands) {
    if (!wanted.has(brand.id)) continue;
    const root = path.join(paths.chromiumFamilyConfig, brand.dir);
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== 'Default' && !entry.name.startsWith('Profile ')) continue;
      const history = path.join(root, entry.name, 'History');
      if (fs.existsSync(history)) out.push({ label: brand.label, dir: path.join(root, entry.name), history });
    }
  }
  return out;
}

function firefoxRows(profile, config, now) {
  const sinceMicros = (now - config.index.historyDays * 86_400_000) * 1000;
  return withDatabase(profile.places, (db) => {
    const rows = db
      .query(
        `SELECT p.url AS url, p.title AS title, MAX(v.visit_date) AS last_visit, p.visit_count AS visit_count
         FROM moz_places p
         JOIN moz_historyvisits v ON v.place_id = p.id
         WHERE v.visit_date > ? AND p.url LIKE 'http%'
         GROUP BY p.id
         ORDER BY last_visit DESC
         LIMIT ?`
      )
      .all(sinceMicros, config.index.historyRows);

    return rows.map((r) => ({
      url: r.url,
      title: r.title || r.url,
      visitedAt: Number(r.last_visit) / 1000,
      visitCount: r.visit_count,
      browser: 'Firefox',
    }));
  });
}

function chromiumRows(profile, config, now) {
  const sinceWindowsMicros = (now - config.index.historyDays * 86_400_000 + WINDOWS_EPOCH_OFFSET_MS) * 1000;
  return withDatabase(profile.history, (db) => {
    const rows = db
      .query(
        `SELECT url AS url, title AS title, last_visit_time AS last_visit, visit_count AS visit_count
         FROM urls
         WHERE last_visit_time > ? AND url LIKE 'http%'
         ORDER BY last_visit_time DESC
         LIMIT ?`
      )
      .all(sinceWindowsMicros, config.index.historyRows);

    return rows.map((r) => ({
      url: r.url,
      title: r.title || r.url,
      visitedAt: Number(r.last_visit) / 1000 - WINDOWS_EPOCH_OFFSET_MS,
      visitCount: r.visit_count,
      browser: profile.label,
    }));
  });
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Chromium records redirect hops, OAuth callbacks and third-party webhook hits
 * in the same table as real page visits. They are worthless as candidates — a
 * set query for "links I visited today" offered a Stripe 3-D Secure notify URL
 * on this machine — and they crowd out pages the user recognises. Two signals
 * are reliable in code, so the narrowing happens here rather than being left to
 * the model: absurd length, and paths that are never real destinations.
 */
const NON_PAGE_PATTERNS = [
  // No \b after these: "3d_secure_2" and "tds2_..." are underscore-continued,
  // and _ is a word character, so a word boundary never matches there.
  /\/3d_secure/i,
  /\/tds2/i,
  /\/(oauth|oidc|saml)\/(callback|authorize|redirect)/i,
  /[?&](code|state|nonce|id_token|session_state)=/i,
  /\/callback\?/i,
  /\.(js|css|png|jpe?g|gif|svg|woff2?|ico)(\?|$)/i,
];

export function isLikelyPage(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (url.length > 180) return false;
  return !NON_PAGE_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * A visit worth offering as a candidate.
 *
 * The second signal is the telling one: Chromium leaves the title empty for API
 * calls, webhook hits and most redirect hops and falls back to showing the URL.
 * Those are never what someone means by "the links I visited today", and in the
 * panel they render as a raw 150-character URL, which is how a Stripe 3-D Secure
 * notify endpoint ended up in the results on this machine.
 */
export function isLikelyVisit({ url, title }) {
  if (!isLikelyPage(url)) return false;
  return Boolean(title) && title !== url;
}

/** Deduplicated, newest-first visit rows for every readable profile. */
export function loadHistory(config) {
  const now = Date.now();
  const collected = [];
  const sources = [];

  for (const profile of readFirefoxProfiles()) {
    try {
      const rows = firefoxRows(profile, config, now);
      collected.push(...rows);
      sources.push({ browser: 'Firefox', profile: path.basename(profile.dir), visits: rows.length });
    } catch (err) {
      log.warn(`firefox history unavailable (${path.basename(profile.dir)})`, String(err));
    }
  }

  for (const profile of chromiumProfiles(config)) {
    try {
      const rows = chromiumRows(profile, config, now);
      collected.push(...rows);
      sources.push({ browser: profile.label, profile: path.basename(profile.dir), visits: rows.length });
    } catch (err) {
      log.warn(`${profile.label} history unavailable (${path.basename(profile.dir)})`, String(err));
    }
  }

  // Same URL visited in several profiles: keep the most recent visit and add
  // the visit counts together.
  const byUrl = new Map();
  for (const row of collected) {
    const existing = byUrl.get(row.url);
    if (!existing || row.visitedAt > existing.visitedAt) {
      byUrl.set(row.url, {
        ...row,
        visitCount: (existing?.visitCount ?? 0) + (row.visitCount ?? 0),
        browser: existing && existing.browser !== row.browser ? `${row.browser}+` : row.browser,
      });
    }
  }

  // OAuth callbacks, sign-in hops and search pages arrive as dozens of
  // distinct URLs that all share one title. Collapsing those by title+host
  // leaves one row per thing the user actually recognises.
  const byTitle = new Map();
  for (const row of [...byUrl.values()].sort((a, b) => b.visitedAt - a.visitedAt)) {
    const host = hostOf(row.url);
    const titled = row.title && row.title !== row.url && row.title.length > 3;
    const key = titled ? `${host}|${row.title}` : `url|${row.url}`;
    if (!byTitle.has(key)) byTitle.set(key, { ...row, host });
  }

  const rows = [...byTitle.values()]
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .filter((row) => isLikelyVisit(row))
    .map((row) => {
      const host = hostOf(row.url);
      return {
        id: `url:${row.url}`,
        kind: 'open_url',
        title: row.title,
        detail: `${host} · visited ${visitAge(row.visitedAt, now)} · ${row.browser}`,
        keywords: `${host} ${row.url} link page visited`,
        icon_kind: 'named',
        icon: 'web-browser-symbolic',
        url: row.url,
        host,
        visitedAt: row.visitedAt,
        visitCount: row.visitCount ?? 1,
      };
    });

  log.debug(`history: ${rows.length} urls`, JSON.stringify(sources));
  return { rows, sources };
}

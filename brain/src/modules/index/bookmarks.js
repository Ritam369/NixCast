/**
 * Bookmarks — Firefox (places.sqlite) and the Chromium family (Bookmarks JSON).
 *
 * Why this is a provider of its own rather than a corner of history: a bookmark
 * is a deliberate act, so it deserves its own subtitle, and a folder name is a
 * natural set query. "open the ChaiCode bookmarks" then reuses the machinery
 * that already exists — scope, match_cN, the green ↵ — with no new decision
 * logic anywhere.
 */

import path from 'node:path';
import { createLogger } from '../../common/logger.js';
import { safeReadFile, timeOfDay } from '../../common/utils.js';
import { withDatabase, WINDOWS_EPOCH_OFFSET_MS } from './sqlite.js';
import { readFirefoxProfiles, chromiumProfiles } from './profiles.js';

const log = createLogger('index.bookmarks');

const LIMIT_PER_BROWSER = 300;

/** Firefox's built-in roots: containers, not folders the user chose to make. */
const FIREFOX_ROOTS = new Set(['menu', 'toolbar', 'unfiled', 'mobile', 'tags']);

function firefoxRows(profile) {
  return withDatabase(profile.places, (db) => {
    const folders = new Map(
      db.query('SELECT id, title, parent FROM moz_bookmarks WHERE type = 2').all().map((row) => [row.id, row])
    );

    /** Walk parents up to the root, skipping the built-in containers. */
    const folderPathFor = (id) => {
      const names = [];
      let current = folders.get(id);
      let guard = 0;
      while (current && guard < 25) {
        if (current.title && !FIREFOX_ROOTS.has(current.title)) names.unshift(current.title);
        if (!current.parent) break;
        current = folders.get(current.parent);
        guard += 1;
      }
      return names.join(' / ') || 'Bookmarks';
    };

    return db
      .query(
        `SELECT b.title AS title, p.url AS url, b.dateAdded AS added, b.parent AS parent
         FROM moz_bookmarks b
         JOIN moz_places p ON p.id = b.fk
         WHERE b.type = 1 AND p.url LIKE 'http%'
         ORDER BY b.dateAdded DESC
         LIMIT ?`
      )
      .all(LIMIT_PER_BROWSER)
      .map((row) => ({
        title: row.title || row.url,
        url: row.url,
        folder: folderPathFor(row.parent),
        addedMs: Number(row.added ?? 0) / 1000,
        browser: 'Firefox',
      }));
  });
}

/**
 * Flatten Chromium's bookmark tree. Exported because it is the one part of this
 * provider that can be tested without a browser installed.
 */
export function walkChromiumBookmarks(parsed, label) {
  const out = [];

  const walk = (node, trail) => {
    const name = typeof node?.name === 'string' ? node.name : '';
    // The synthetic top node is literally named "Bookmarks"; keeping it would
    // make every folder read "Bookmarks/ChaiCode".
    const nextTrail = name && name !== 'Bookmarks' ? [...trail, name] : trail;

    if (typeof node?.url === 'string' && node.url.startsWith('http')) {
      out.push({
        title: name || node.url,
        url: node.url,
        folder: trail.join(' / ') || 'Bookmarks bar',
        addedMs: node.date_added ? Number(node.date_added) / 1000 - WINDOWS_EPOCH_OFFSET_MS : 0,
        browser: label,
      });
      return;
    }

    for (const child of node?.children ?? []) walk(child, nextTrail);
  };

  for (const root of Object.values(parsed?.roots ?? {})) walk(root, []);
  return out;
}

function chromiumRows(profile) {
  const raw = safeReadFile(path.join(profile.dir, 'Bookmarks'));
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(`${profile.label}: Bookmarks file is not valid JSON`, String(err));
    return [];
  }

  return walkChromiumBookmarks(parsed, profile.label).slice(0, LIMIT_PER_BROWSER);
}

export function loadBookmarks(config) {
  const collected = [];

  for (const profile of readFirefoxProfiles()) {
    try {
      collected.push(...firefoxRows(profile));
    } catch (err) {
      log.warn('firefox bookmarks unavailable', String(err));
    }
  }

  for (const profile of chromiumProfiles(config)) {
    try {
      collected.push(...chromiumRows(profile));
    } catch (err) {
      log.warn(`${profile.label} bookmarks unavailable`, String(err));
    }
  }

  // The same page saved twice — two folders, or two browsers: one row, with the
  // other folder named in the subtitle rather than repeated as a look-alike.
  const byUrl = new Map();
  for (const row of collected) {
    const existing = byUrl.get(row.url);
    if (!existing) {
      byUrl.set(row.url, row);
      continue;
    }
    if (existing.folder !== row.folder && !existing.folder.includes(row.folder)) {
      existing.folder = `${existing.folder} · also ${row.folder}`;
    }
  }

  const rows = [...byUrl.values()].map((row) => ({
    id: `bookmark:${row.url}`,
    kind: 'open_url',
    title: row.title,
    detail: `Bookmark in ${row.folder} · ${row.browser}`,
    keywords: `${row.title} ${row.folder} bookmark saved ${row.browser}`,
    icon_kind: 'named',
    icon: 'starred-symbolic',
    url: row.url,
    host: hostOf(row.url),
    folder: row.folder,
    addedMs: row.addedMs,
    bookmark: true,
  }));

  log.debug(`indexed ${rows.length} bookmarks from ${collected.length} entries`);
  return rows;
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

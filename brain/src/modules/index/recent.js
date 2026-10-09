/**
 * Recently-used index — ~/.local/share/recently-used.xbel.
 *
 * This is a Linux-only source with no macOS counterpart, and it is a much
 * better answer to "the pdf I just downloaded" than modification time,
 * because GTK records what was actually opened.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../common/logger.js';
import { paths } from '../../common/paths.js';
import { decodeFileUri, fileIconFor, relativeAge, safeStat } from '../../common/utils.js';

const log = createLogger('index.recent');

const BOOKMARK_RE = /<bookmark\b([^>]*)>([\s\S]*?)<\/bookmark>/g;
const ATTR_RE = (name) => new RegExp(`${name}="([^"]*)"`, 'i');
const TITLE_RE = /<title>([\s\S]*?)<\/title>/i;

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function loadRecent(config) {
  const file = paths.recentlyUsed;
  if (!fs.existsSync(file)) {
    log.debug('no recently-used.xbel');
    return [];
  }

  const now = Date.now();
  const rows = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log.warn('could not read recently-used.xbel', String(err));
    return [];
  }

  for (const match of text.matchAll(BOOKMARK_RE)) {
    const attrs = match[1];
    const body = match[2];
    const href = ATTR_RE('href').exec(attrs)?.[1];
    if (!href || !href.startsWith('file://')) continue;

    const filePath = decodeFileUri(href);
    if (!filePath) continue;

    const stat = safeStat(filePath);
    if (!stat || stat.isDirectory()) continue; // stale entries are common

    const modified = ATTR_RE('modified').exec(attrs)?.[1];
    const visited = modified ? Date.parse(modified) : stat.mtimeMs;
    const titleMatch = TITLE_RE.exec(body);
    const title = titleMatch ? unescapeXml(titleMatch[1]) : path.basename(filePath);

    const icon = fileIconFor(filePath, stat);
    rows.push({
      id: `recent:${filePath}`,
      kind: 'open_file',
      title,
      detail: `Recent · opened ${relativeAge(Number.isNaN(visited) ? stat.mtimeMs : visited, now)}`,
      keywords: `${title} ${path.basename(filePath)} recent opened`,
      icon_kind: icon.icon_kind,
      icon: icon.icon,
      path: filePath,
      alsoKnownAs: path.basename(filePath),
      mtime: Number.isNaN(visited) ? stat.mtimeMs : visited,
    });
  }

  rows.sort((a, b) => b.mtime - a.mtime);
  log.debug(`indexed ${rows.length} recent files`);
  return rows;
}

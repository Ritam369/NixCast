/**
 * File index — the Linux equivalent of the macOS launcher's ~/Downloads,
 * ~/Desktop and ~/Documents scan. Top level plus one nested level, with a
 * per-folder cap so a huge Downloads directory cannot stall the brain.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../common/logger.js';
import { fileIconFor, relativeAge, safeStat } from '../../common/utils.js';

const log = createLogger('index.files');

function scanDir(dir, { maxPerFolder, depth, rows, now }) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const candidates = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    candidates.push(entry);
  }

  // Newest first, so a capped folder keeps the files the user actually wants.
  const withStats = [];
  for (const entry of candidates) {
    const full = path.join(dir, entry.name);
    const stat = safeStat(full);
    if (!stat) continue;
    withStats.push({ entry, full, stat });
  }
  withStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  let added = 0;
  for (const { entry, full, stat } of withStats) {
    if (added >= maxPerFolder) break;

    const isDir = stat.isDirectory();
    const icon = fileIconFor(full, stat);
    const parent = path.basename(path.dirname(full));

    rows.push({
      id: `file:${full}`,
      kind: isDir ? 'open_file' : 'open_file',
      title: entry.name,
      detail: `${isDir ? 'Folder' : 'File'} in ~/${parent} · modified ${relativeAge(stat.mtimeMs, now)}`,
      keywords: `${entry.name} ${parent}`,
      icon_kind: icon.icon_kind,
      icon: icon.icon,
      path: full,
      mtime: stat.mtimeMs,
      isDir,
      size: stat.size,
    });
    added += 1;
  }

  if (depth > 0) {
    for (const { full, stat } of withStats) {
      if (stat.isDirectory() && !path.basename(full).startsWith('.')) {
        scanDir(full, { maxPerFolder, depth: depth - 1, rows, now });
      }
    }
  }
}

export function loadFiles(config) {
  const now = Date.now();
  const rows = [];
  const dirs = [...new Set([config.index.downloadsDir, ...(config.index.extraDirs ?? [])].filter(Boolean))];

  for (const dir of dirs) {
    scanDir(dir, { maxPerFolder: config.index.maxPerFolder ?? 400, depth: config.index.nestedDepth ?? 1, rows, now });
  }

  log.debug(`indexed ${rows.length} files from ${dirs.length} dirs`);
  return rows;
}

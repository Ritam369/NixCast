/**
 * Where the browsers keep their databases.
 *
 * Extracted so that history and bookmarks share one answer to "which profiles
 * exist on this machine", instead of two copies drifting apart.
 */

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../../common/paths.js';

/** Firefox profiles that actually have a places.sqlite. */
export function readFirefoxProfiles() {
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

/**
 * Chromium-family profile directories. `history` is included for the history
 * provider; the bookmarks provider only needs `dir`, since both files live
 * side by side in the same profile directory.
 */
export function chromiumProfiles(config) {
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

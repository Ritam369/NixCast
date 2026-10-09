/**
 * Application index — the Linux equivalent of scanning /Applications.
 *
 * Reads XDG desktop entries from every applications/ directory and produces
 * launchable rows. NixOS puts most entries in /run/current-system/sw/share,
 * which is why paths.dataDirs() adds it explicitly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../common/logger.js';
import { paths, dataDirs } from '../../common/paths.js';

const log = createLogger('index.apps');

/** Exec= values contain field codes like %U / %f that must not be passed on. */
export function stripFieldCodes(exec) {
  return String(exec ?? '')
    .replace(/%[fFuUdDnNickvm]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The command a desktop entry actually runs, for the subtitle. */
function executableName(exec) {
  const first = String(exec ?? '').split(' ')[0];
  return first ? first.split('/').pop() : null;
}

/**
 * freedesktop categories are the one machine-readable statement of what an app
 * *is*, so they belong in what the matcher and the model can see. The list is
 * ordered least to most descriptive by convention, so the first recognised
 * category is usually the useful one — and the toolkit/desktop noise at the end
 * ("GTK;GNOME;") is skipped.
 */
const CATEGORY_LABELS = {
  AudioVideo: 'Media',
  Audio: 'Audio',
  Video: 'Video',
  Development: 'Development tool',
  Education: 'Education',
  Game: 'Game',
  Graphics: 'Graphics',
  Network: 'Network',
  Office: 'Office',
  Science: 'Science',
  Settings: 'Settings',
  System: 'System tool',
  Utility: 'Utility',
  Core: 'Core tool',
  FileManager: 'File manager',
  TerminalEmulator: 'Terminal emulator',
  TextEditor: 'Text editor',
  WebBrowser: 'Web browser',
  Email: 'Email',
  InstantMessaging: 'Chat',
  Player: 'Media player',
  Recorder: 'Recorder',
  Viewer: 'Viewer',
  Calculator: 'Calculator',
  Clock: 'Clock',
  Calendar: 'Calendar',
  DocumentViewer: 'Document viewer',
  Spreadsheet: 'Spreadsheet',
  Presentation: 'Presentation',
  ImageProcessing: 'Image editor',
  Photography: 'Photography',
};

/** Toolkits and desktop names that say nothing about what an app does. */
const CATEGORY_NOISE = new Set(['GTK', 'GNOME', 'KDE', 'Qt', 'XFCE', 'MATE', 'DDE', 'Core']);

/**
 * Categories that name a function ("TerminalEmulator") outrank the broad buckets
 * ("System", "Utility") that conventionally come first, because the broad one is
 * shared by hundreds of apps while the specific one is what distinguishes this
 * app from its neighbours. Getting this order wrong is why Console described
 * itself as "System tool".
 */
const SPECIFIC_CATEGORIES = new Set([
  'TerminalEmulator',
  'TextEditor',
  'WebBrowser',
  'Email',
  'InstantMessaging',
  'FileManager',
  'DocumentViewer',
  'Spreadsheet',
  'Presentation',
  'ImageProcessing',
  'Photography',
  'Player',
  'Recorder',
  'Viewer',
  'Calculator',
  'Clock',
  'Calendar',
  'Game',
]);

export function humanCategory(categories) {
  const parts = String(categories ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !CATEGORY_NOISE.has(part));

  for (const part of parts) {
    if (SPECIFIC_CATEGORIES.has(part)) return CATEGORY_LABELS[part];
  }
  for (const part of parts) {
    if (CATEGORY_LABELS[part]) return CATEGORY_LABELS[part];
  }

  return null;
}

function parseDesktopEntry(text) {
  const entry = {};
  let inMain = false;
  let sawMain = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      inMain = line === '[Desktop Entry]';
      if (inMain) sawMain = true;
      continue;
    }
    if (!inMain) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    // Keep the first plain key; localised variants (Name[de]) only fill gaps.
    if (!(key in entry) || !/\[/.test(key)) entry[key] = value;
  }

  return sawMain ? entry : null;
}

function localized(entry, key) {
  if (entry[key]) return entry[key];
  for (const k of Object.keys(entry)) {
    if (k.startsWith(`${key}[`)) return entry[k];
  }
  return '';
}

export function loadApps(config) {
  const dirs = [...new Set([...(config.index.appDirs ?? []), ...dataDirs().map((d) => path.join(d, 'applications')), paths.userApplications])];

  const seen = new Set();
  const apps = [];

  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of names) {
      if (!name.endsWith('.desktop')) continue;
      const file = path.join(dir, name);
      if (seen.has(name)) continue; // user entries shadow system ones

      let entry;
      try {
        entry = parseDesktopEntry(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if (!entry) continue;
      if (entry.Type && entry.Type !== 'Application') continue;
      if (entry.NoDisplay === 'true' || entry.Hidden === 'true') continue;

      const title = localized(entry, 'Name');
      const exec = stripFieldCodes(entry.Exec);
      if (!title || !exec) continue;

      seen.add(name);
      const binary = executableName(exec);
      const category = humanCategory(entry.Categories);
      const generic = localized(entry, 'GenericName') || localized(entry, 'Comment');
      apps.push({
        id: `app:${name}`,
        kind: 'open_app',
        title,
        // The subtitle is read by the user *and* by Jev — the model only ever
        // sees title + detail. Falling back to a bare "Application" left it
        // unable to tell a terminal emulator from a container launcher, which is
        // how typing "terminal" ended up selecting a distrobox entry.
        detail: [generic || category || 'Application', binary].filter(Boolean).join(' · '),
        keywords: [
          localized(entry, 'Keywords').split(';').join(' '),
          localized(entry, 'Comment'),
          category ?? '',
          (entry.Categories ?? '').replace(/;/g, ' '),
          name.replace('.desktop', ''),
        ]
          .filter(Boolean)
          .join(' '),
        icon_kind: entry.Icon ? 'named' : 'fallback',
        icon: entry.Icon ?? 'application-x-executable',
        exec,
        desktopFile: file,
        terminal: entry.Terminal === 'true',
        categories: entry.Categories ?? '',
      });
    }
  }

  log.debug(`indexed ${apps.length} applications from ${dirs.length} dirs`);
  return apps;
}

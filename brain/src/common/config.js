import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDir, dataDirs } from './paths.js';
import { createLogger } from './logger.js';

const log = createLogger('config');

export const DEFAULT_CONFIG = {
  search: {
    maxCandidates: 13,
    maxCandidatesWithWindow: 30,
    maxRows: 7,
    nlFillers: [
      'the',
      'a',
      'an',
      'open',
      'launch',
      'start',
      'run',
      'show',
      'me',
      'my',
      'find',
      'search',
      'for',
      'about',
      'read',
      'please',
      'file',
      'files',
      'page',
      'pages',
      'link',
      'links',
      'that',
      'i',
      'just',
      'in',
      'on',
      'of',
      'to',
      'from',
    ],
  },

  index: {
    downloadsDir: paths.downloads,
    extraDirs: [paths.desktop, paths.documents],
    maxPerFolder: 400,
    nestedDepth: 1,
    historyDays: 90,
    historyRows: 3000,
    browsers: ['firefox', 'brave', 'chrome', 'chromium', 'edge', 'vivaldi'],
    refreshMs: 120_000,
    appDirs: [...dataDirs().map((d) => path.join(d, 'applications'))],

    /**
     * Folders searched *live*, on demand, instead of being indexed up front.
     *
     * The indexed folders above are what keep a keystroke instant, but they also
     * mean anything outside them is invisible — an external drive, a photo
     * library, a project tree. Add those here rather than to extraDirs: a live
     * walk costs nothing until it runs, needs no refresh, and works the moment a
     * removable drive is plugged in. A path that is not mounted is simply
     * skipped.
     *
     * Index a tree instead (extraDirs) when searches in it are frequent, and
     * list it here when it is large, removable, or occasional.
     */
    /**
     * Whole-disk name search through plocate's prebuilt database. Consulted only
     * when the index has no confident match, so it costs nothing while typing.
     * Install it with `services.locate.enable = true` (see docs/nixos.md).
     */
    plocate: {
      enabled: true,
      /** plocate's own lookup is ~10 ms; this only bounds a cold database. */
      timeoutMs: 400,
      maxResults: 10,
      minQueryLength: 3,
      strongMatch: 0.85,
      /** Build artefacts, caches and recycle bins are ranked down, not hidden. */
      noisyPenalty: 0.35,
    },

    searchRoots: [],
    liveWalk: {
      enabled: true,
      /** Hard deadline. The local phase must stay instant, so partial results are fine. */
      timeoutMs: 120,
      maxDepth: 6,
      maxResults: 8,
      /** Shorter queries are too broad to be worth a walk. */
      minQueryLength: 3,
      maxEntries: 20_000,
      /**
       * Stand down when the index already has a match this confident (0.85 is
       * the word-prefix tier). A lower bar let mediocre matches suppress the
       * walk, hiding files the walk would have found by name.
       */
      strongMatch: 0.85,
    },
  },

  toggles: [
    { id: 'dark-mode', title: 'Toggle Dark Mode', keywords: 'theme appearance night light dark' },
    { id: 'wifi', title: 'Turn Wi-Fi Off', keywords: 'wifi wireless network airplane' },
    { id: 'bluetooth', title: 'Toggle Bluetooth', keywords: 'bluetooth bt adapter headphones headset pair discoverable bluez radios' },
    { id: 'dnd', title: 'Toggle Do Not Disturb', keywords: 'notifications dnd focus mute' },
    { id: 'hidden-files', title: 'Show Hidden Files', keywords: 'dotfiles nautilus files' },
    { id: 'empty-trash', title: 'Empty Trash', keywords: 'trash rubbish delete' },
    { id: 'sleep', title: 'Sleep', keywords: 'suspend hibernate' },
    { id: 'lock', title: 'Lock Screen', keywords: 'lock logout secure' },
  ],

  /**
   * Custom commands. This replaces macOS Shortcuts, which has no Linux
   * equivalent. Each action becomes a first-class row.
   */
  actions: [
    {
      id: 'nixos-rebuild',
      title: 'Rebuild NixOS',
      keywords: 'nixos rebuild switch config',
      command: ['nixos-rebuild', 'build'],
      terminal: true,
      description: 'nixos-rebuild build (does not touch the running system)',
    },
  ],

  ui: {
    /**
     * Terminal used for actions marked `"terminal": true`. Empty means: the
     * first of kitty, alacritty, foot, gnome-terminal, xterm that is installed.
     */
    terminal: '',
  },
};

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge where arrays are replaced wholesale, not concatenated. */
export function mergeDeep(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? mergeDeep(base[key], value) : value;
  }
  return out;
}

let cached = null;

export function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;

  let fileConfig = {};
  if (fs.existsSync(paths.configFile)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
    } catch (err) {
      log.warn(`could not parse ${paths.configFile}, using defaults`, String(err));
    }
    const mode = fs.statSync(paths.configFile).mode & 0o777;
    if (mode & 0o077) log.warn(`${paths.configFile} is mode ${mode.toString(8)}; it holds an API key, use chmod 600`);
  }

  cached = mergeDeep(DEFAULT_CONFIG, fileConfig);

  // Environment overrides — useful for testing without touching the config file.
  if (process.env.NIXCAST_SOCKET) cached.socket = process.env.NIXCAST_SOCKET;
  if (process.env.NIXCAST_DISABLE_WALK === '1') cached.index.liveWalk.enabled = false;

  return cached;
}

export function saveConfig(config) {
  ensureDir(paths.appConfigDir);
  const target = paths.configFile;
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
  cached = config;
  return target;
}

export function ensureConfigFile() {
  if (fs.existsSync(paths.configFile)) return { created: false, file: paths.configFile };
  saveConfig(DEFAULT_CONFIG);
  return { created: true, file: paths.configFile };
}


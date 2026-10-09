import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDir, dataDirs } from './paths.js';
import { createLogger } from './logger.js';

const log = createLogger('config');

export const DEFAULT_CONFIG = {
  /**
   * Jev credentials. Two transports:
   *
   *   transport: 'gateway'  Vercel AI Gateway via the AI SDK's
   *                         experimental_evaluate — model `typesafe-ai/jev`,
   *                         question type `boolean`, answer field
   *                         `probability`. Use this with an AI Gateway key
   *                         (AI_GATEWAY_API_KEY).
   *   transport: 'direct'   TypeSafe's own HTTP API — model `jev-latest`,
   *                         question type `noul`, answer field `noul`. Use
   *                         this with a TypeSafe key.
   *   transport: 'off'      never call out; fuzzy-only launcher.
   *
   * `apiKey` is read from this file and never from the Nix store, because
   * everything in /nix/store is world readable. JEV_API_KEY,
   * AI_GATEWAY_API_KEY and TYPESAFE_API_KEY in the environment win over it.
   */
  jev: {
    enabled: true,
    transport: 'gateway',
    apiKey: '',
    model: 'typesafe-ai/jev',
    /**
     * Ask the gateway for zero data retention. Off by default because the
     * gateway refuses the whole request on plans that do not include it
     * ("Zero Data Retention (ZDR) is only available for Pro and Enterprise
     * plans"), which would look like a broken launcher. Turn it on if your plan
     * supports it and you want that guarantee.
     */
    zeroDataRetention: false,
    /** Empty means "use the AI SDK provider's own default base URL". */
    gatewayBaseUrl: '',
    baseUrl: 'https://api.typesafe.ai',
    path: '/v1/systemone',
    timeoutMs: 15000,
    /**
     * How long to wait after the last keystroke before asking Jev. The local
     * fuzzy order renders instantly regardless, so this is pure perceived
     * latency: 100 ms feels immediate while still collapsing a burst of typing
     * into one request.
     */
    debounceMs: 100,
    maxRetries: 2,
    warmup: true,
    extraHeaders: {},
  },

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

  weights: {
    target: 0.65,
    action: 0.2,
    fuzzy: 0.15,
    setMember: 0.25,
  },

  thresholds: {
    ready: 0.6,
    readyDirectTarget: 0.9,
    matchMember: 0.6,
    offerAll: 0.5,
    tornAll: 0.15,
    readyAll: 0.75,
    minSetSize: 2,
    maxSetSize: 25,
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
      /** Skip the walk when the index already produced this many confident matches. */
      strongMatch: 0.6,
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
    panelTopFraction: 0.15,
    showFooterStats: true,
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
  const env = process.env;
  if (env.JEV_TRANSPORT) cached.jev.transport = env.JEV_TRANSPORT;
  if (env.JEV_BASE_URL) cached.jev.baseUrl = env.JEV_BASE_URL;
  if (env.JEV_GATEWAY_BASE_URL) cached.jev.gatewayBaseUrl = env.JEV_GATEWAY_BASE_URL;
  if (env.JEV_MODEL) cached.jev.model = env.JEV_MODEL;
  if (env.JEV_DISABLE === '1') cached.jev.enabled = false;

  // The key: AI_GATEWAY_API_KEY for the gateway transport, TYPESAFE_API_KEY for
  // the direct one. Either is accepted as a fallback so switching transports
  // never means moving the secret.
  const preferred = cached.jev.transport === 'gateway'
    ? env.AI_GATEWAY_API_KEY ?? env.TYPESAFE_API_KEY
    : env.TYPESAFE_API_KEY ?? env.AI_GATEWAY_API_KEY;
  if (env.JEV_API_KEY ?? preferred) cached.jev.apiKey = env.JEV_API_KEY ?? preferred;

  // A gateway model id is meaningless to the direct API and vice versa, so
  // follow the transport when the model was left at its default.
  if (cached.jev.transport === 'direct' && cached.jev.model === DEFAULT_CONFIG.jev.model) cached.jev.model = 'jev-latest';
  if (cached.jev.transport === 'gateway' && cached.jev.model === 'jev-latest') cached.jev.model = DEFAULT_CONFIG.jev.model;

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
  const template = mergeDeep(DEFAULT_CONFIG, {
    jev: { apiKey: 'PUT-YOUR-VERCEL-AI-GATEWAY-KEY-HERE' },
  });
  saveConfig(template);
  return { created: true, file: paths.configFile };
}

export function jevIsConfigured(config = loadConfig()) {
  const key = config.jev.apiKey ?? '';
  if (!config.jev.enabled || config.jev.transport === 'off') return false;
  return key.length > 0 && !key.startsWith('PUT-YOUR');
}

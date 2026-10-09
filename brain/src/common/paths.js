import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const HOME = os.homedir();

function env(name, fallback) {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

/** XDG spec plus the NixOS-specific locations we care about. */
export const paths = {
  home: HOME,

  configDir: env('XDG_CONFIG_HOME', path.join(HOME, '.config')),
  dataDir: env('XDG_DATA_HOME', path.join(HOME, '.local', 'share')),
  stateDir: env('XDG_STATE_HOME', path.join(HOME, '.local', 'state')),
  cacheDir: env('XDG_CACHE_HOME', path.join(HOME, '.cache')),
  runtimeDir: env('XDG_RUNTIME_DIR', `/run/user/${process.getuid?.() ?? 1000}`),

  get appConfigDir() {
    return path.join(this.configDir, 'jev-launcher');
  },
  get configFile() {
    return path.join(this.appConfigDir, 'config.json');
  },
  get socketPath() {
    return process.env.JEV_SOCKET ?? path.join(this.runtimeDir, 'jev-launcher', 'brain.sock');
  },
  get logFile() {
    return path.join(this.stateDir, 'jev-launcher', 'brain.log');
  },

  // Application indices
  get userApplications() {
    return path.join(this.dataDir, 'applications');
  },
  get nixProfileApplications() {
    return path.join(HOME, '.nix-profile', 'share', 'applications');
  },
  get systemApplications() {
    return '/run/current-system/sw/share/applications';
  },

  // File indices
  get downloads() {
    return path.join(HOME, 'Downloads');
  },
  get desktop() {
    return path.join(HOME, 'Desktop');
  },
  get documents() {
    return path.join(HOME, 'Documents');
  },
  get recentlyUsed() {
    return path.join(this.dataDir, 'recently-used.xbel');
  },

  // Browser histories
  get firefoxDir() {
    return path.join(HOME, '.mozilla', 'firefox');
  },
  get firefoxProfilesIni() {
    return path.join(HOME, '.mozilla', 'firefox', 'profiles.ini');
  },
  get chromiumFamilyConfig() {
    return path.join(this.configDir);
  },
  chromiumBrands: [
    { id: 'brave', label: 'Brave', dir: 'BraveSoftware/Brave-Browser' },
    { id: 'chrome', label: 'Chrome', dir: 'google-chrome' },
    { id: 'chromium', label: 'Chromium', dir: 'chromium' },
    { id: 'edge', label: 'Edge', dir: 'microsoft-edge' },
    { id: 'vivaldi', label: 'Vivaldi', dir: 'vivaldi' },
  ],
};

/** Directories that XDG says hold user data; honours XDG_DATA_DIRS. */
export function dataDirs() {
  const dirs = [];
  const home = env('XDG_DATA_HOME', path.join(HOME, '.local', 'share'));
  dirs.push(home);
  const sys = env('XDG_DATA_DIRS', '/usr/local/share:/usr/share');
  for (const d of sys.split(':')) if (d) dirs.push(d);

  // NixOS puts packages in the system profile and per-user profiles, which are
  // not always listed in XDG_DATA_DIRS for a session started before a rebuild.
  dirs.push('/run/current-system/sw/share');
  dirs.push(path.join(HOME, '.nix-profile', 'share'));
  if (process.env.NIX_PROFILES) {
    for (const p of process.env.NIX_PROFILES.split(' ')) if (p) dirs.push(path.join(p, 'share'));
  }
  return [...new Set(dirs.filter((d) => fs.existsSync(d)))];
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

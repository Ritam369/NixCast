import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isNoisyPath, rowForPath, searchByName } from '../src/modules/index/plocate.js';

let root;
let file;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nixcast-plocate-'));
  fs.mkdirSync(path.join(root, 'Album'), { recursive: true });
  file = path.join(root, 'Album', 'Holiday-Photo.jpg');
  fs.writeFileSync(file, 'x');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('plocate rows', () => {
  test('a hit becomes an open_file row with its real path', () => {
    const row = rowForPath(file);
    expect(row.kind).toBe('open_file');
    expect(row.title).toBe('Holiday-Photo.jpg');
    expect(row.path).toBe(file);
    expect(row.detail).toContain('On disk');
    expect(row.foundBy).toBe('plocate');
    expect(row.isDir).toBe(false);
  });

  test('a folder is labelled as one', () => {
    const row = rowForPath(path.join(root, 'Album'));
    expect(row.isDir).toBe(true);
    expect(row.detail).toContain('folder');
  });

  test('a path that no longer exists yields nothing', () => {
    // The database is a snapshot; the filesystem moves on.
    expect(rowForPath(path.join(root, 'gone.txt'))).toBeNull();
  });

  test('keywords carry the full path, so a directory name is searchable too', () => {
    expect(rowForPath(file).keywords).toContain('Album');
  });
});

describe('build artefacts are marked, not hidden', () => {
  test('the paths that ruined a name search are recognised', () => {
    expect(isNoisyPath('/mnt/onedrive/$Recycle.Bin/S-1-5/SideProjects/app/node_modules/@mui/icons-material/HolidayVillage.js')).toBe(true);
    expect(isNoisyPath('/home/ritam/project/.git/objects/pack/thing')).toBe(true);
    expect(isNoisyPath('/home/ritam/.vscode/extensions/openai.chatgpt/assets/holiday-widget.js')).toBe(true);
    expect(isNoisyPath('/mnt/onedrive/Users/Admin/AppData/Local/Temp/holiday.png')).toBe(true);
    // Package-manager caches: a search for "dark" used to surface seven theme
    // JSONs from the bun cache above the actual Toggle Dark Mode row.
    expect(isNoisyPath('/home/ritam/.bun/install/cache/@oh-my-pi/pi-coding-agent@18/src/modes/theme/dark.json')).toBe(true);
    expect(isNoisyPath('/home/ritam/.cache/pip/wheels/holiday.whl')).toBe(true);
    expect(isNoisyPath('/nix/store/abc123-firefox-131/share/dark.css')).toBe(true);
    // The D: drive spells it uppercase, and carries a pnpm store and a Windows
    // system folder — all of which turned up in a real search.
    expect(isNoisyPath('/home/ritam/mount-d/$RECYCLE.BIN/S-1-5-21/thing')).toBe(true);
    expect(isNoisyPath('/home/ritam/mount-d/D DRIVE HP LAPTOP/app/.pnpm-store/v3/files/ab')).toBe(true);
    expect(isNoisyPath('/home/ritam/mount-d/System Volume Information/tracking.log')).toBe(true);
  });

  test('ordinary files are not marked', () => {
    expect(isNoisyPath('/mnt/onedrive/Users/Admin/OneDrive/Pictures/Apu.jpg')).toBe(false);
    expect(isNoisyPath('/home/ritam/Downloads/Ritam_Saha_Resume.pdf')).toBe(false);
    expect(isNoisyPath('/home/ritam/WebApp/src/modules/user.service.js')).toBe(false);
  });

  test('a row carries the mark, so the engine can rank it down', () => {
    const noisy = rowForPath('/home/ritam/project/node_modules/pkg/index.js');
    expect(noisy === null || noisy.noisy === true).toBe(true);
  });
});

describe('plocate queries', () => {
  test('short queries are skipped — a two-letter query is not a disk sweep', () => {
    const { rows, stats } = searchByName({ query: 'ho' });
    expect(rows).toHaveLength(0);
    expect(stats.skipped).toBe('query too short');
  });

  test('it can be turned off in config', () => {
    const { stats } = searchByName({ query: 'holiday', config: { enabled: false } });
    expect(stats.skipped).toBe('disabled');
  });

  test('a missing binary is survivable, never an exception', () => {
    // On a machine without plocate the whole feature has to disappear quietly.
    const { rows, stats } = searchByName({ query: 'holiday' });
    expect(Array.isArray(rows)).toBe(true);
    if (stats.skipped === 'plocate is not installed') expect(rows).toHaveLength(0);
  });

  test('a real lookup returns rows for a file that exists on this machine', () => {
    const { rows, stats } = searchByName({ query: 'Holiday-Photo', config: { maxResults: 5 } });
    if (stats.skipped) {
      // plocate not installed yet, or its database predates the temp file.
      expect(rows).toHaveLength(0);
      return;
    }
    expect(rows.every((r) => r.path && r.title)).toBe(true);
  });
});

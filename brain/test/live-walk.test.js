import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkForQuery } from '../src/modules/index/live-walk.js';

/**
 * A fixture tree, built on disk so the walk is tested against real directory
 * listing rather than a mock.
 */
let root;
let deepRoot;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-walk-'));
  fs.mkdirSync(path.join(root, 'Camera Roll'), { recursive: true });
  fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Apu.jpg'), 'x');
  fs.writeFileSync(path.join(root, 'Apu2.jpg'), 'x');
  fs.writeFileSync(path.join(root, '.hidden-Apu.jpg'), 'x');
  fs.writeFileSync(path.join(root, 'Camera Roll', 'Apu holiday.jpg'), 'x');
  fs.writeFileSync(path.join(root, 'Camera Roll', 'unrelated.pdf'), 'x');
  fs.writeFileSync(path.join(root, 'screenshots', 'Screenshot from 2026.png'), 'x');

  deepRoot = path.join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
  fs.mkdirSync(deepRoot, { recursive: true });
  fs.writeFileSync(path.join(deepRoot, 'too-deep-Apu.jpg'), 'x');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('live walk', () => {
  test('finds a file by a substring of its name, at any depth under the root', () => {
    const { rows } = walkForQuery({ roots: [root], query: 'apu' });
    const names = rows.map((r) => r.title);
    expect(names).toContain('Apu.jpg');
    expect(names).toContain('Apu2.jpg');
    expect(names).toContain('Apu holiday.jpg');
    expect(names).not.toContain('unrelated.pdf');
  });

  test('is case-insensitive in both directions', () => {
    expect(walkForQuery({ roots: [root], query: 'APU' }).rows.length).toBeGreaterThan(0);
    expect(walkForQuery({ roots: [root], query: 'apu HOLIDAY' }).rows.length).toBe(1);
  });

  test('exact and prefix matches are ranked ahead of incidental ones', () => {
    const { rows } = walkForQuery({ roots: [root], query: 'apu.jpg' });
    expect(rows[0].title).toBe('Apu.jpg');
  });

  test('rows are shaped for the executor: open_file with a real path', () => {
    const [row] = walkForQuery({ roots: [root], query: 'apu.jpg' }).rows;
    expect(row.kind).toBe('open_file');
    expect(row.path).toBe(path.join(root, 'Apu.jpg'));
    expect(row.detail).toMatch(/Found in/);
    expect(row.icon_kind).toBe('named');
    expect(row.liveWalk).toBe(true);
  });

  test('a folder whose name matches is a result as well', () => {
    // "open the ChaiAurCode folder" has to work, not only files.
    const { rows } = walkForQuery({ roots: [root], query: 'camera' });
    const folder = rows.find((r) => r.title === 'Camera Roll');
    expect(folder).toBeDefined();
    expect(folder.isDir).toBe(true);
    expect(folder.detail).toContain('folder');
    expect(folder.path).toBe(path.join(root, 'Camera Roll'));
  });

  test('hidden files are ignored', () => {
    const names = walkForQuery({ roots: [root], query: 'apu' }).rows.map((r) => r.title);
    expect(names.some((n) => n.startsWith('.'))).toBe(false);
  });

  test('a non-matching folder is not offered just for existing', () => {
    const titles = walkForQuery({ roots: [root], query: 'apu' }).rows.map((r) => r.title);
    expect(titles).not.toContain('screenshots');
  });

  test('short queries are skipped, so a keystroke is never turned into a walk', () => {
    const { rows, stats } = walkForQuery({ roots: [root], query: 'ap' });
    expect(rows).toHaveLength(0);
    expect(stats.skipped).toBe('query too short');
  });

  test('maxDepth bounds the walk', () => {
    const shallow = walkForQuery({ roots: [root], query: 'too-deep', config: { maxDepth: 2 } });
    expect(shallow.rows).toHaveLength(0);

    const deep = walkForQuery({ roots: [root], query: 'too-deep', config: { maxDepth: 9 } });
    expect(deep.rows.map((r) => r.title)).toContain('too-deep-Apu.jpg');
  });

  test('maxResults caps the candidate list', () => {
    const { rows } = walkForQuery({ roots: [root], query: 'screenshot', config: { maxResults: 1 } });
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  test('a busier tree can be truncated by the entry cap, and says so', () => {
    const { stats } = walkForQuery({ roots: [root], query: 'apu', config: { maxEntries: 2 } });
    expect(stats.truncated).toBe(true);
  });

  test('a missing root is survivable — an unmounted drive must not throw', () => {
    const { rows, stats } = walkForQuery({ roots: ['/run/media/definitely-not-mounted-xyz'], query: 'anything' });
    expect(rows).toHaveLength(0);
    expect(stats.dirs).toBe(0);
  });

  test('no roots means no walk at all', () => {
    expect(walkForQuery({ roots: [], query: 'apu' }).stats.skipped).toBe('no search roots');
  });

  test('disabling it in config stops every walk', () => {
    expect(walkForQuery({ roots: [root], query: 'apu', config: { enabled: false } }).stats.skipped).toBe('disabled');
  });

  test('multiple roots are all searched', () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-walk2-'));
    fs.writeFileSync(path.join(second, 'second-Apu.jpg'), 'x');
    const names = walkForQuery({ roots: [root, second], query: 'apu' }).rows.map((r) => r.title);
    expect(names).toContain('second-Apu.jpg');
    fs.rmSync(second, { recursive: true, force: true });
  });
});

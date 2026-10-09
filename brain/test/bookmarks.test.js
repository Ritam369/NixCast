import { test, expect, describe } from 'bun:test';
import { walkChromiumBookmarks } from '../src/modules/index/bookmarks.js';

/**
 * The shape of a real Chromium Bookmarks file, trimmed to what matters: a
 * synthetic root literally named "Bookmarks", named folders under the bar, and
 * URLs as leaves.
 */
const FIXTURE = {
  checksum: 'abc',
  roots: {
    bookmark_bar: {
      children: [
        { date_added: '13412931094154983', name: 'ChaiCode', type: 'folder', children: [
          { date_added: '13412931094154984', name: 'TimeArena', type: 'url', url: 'https://timearena.in/' },
          { date_added: '13412931094154985', name: 'Masterji', type: 'url', url: 'https://www.masterji.co/dashboard' },
        ] },
        { date_added: '13412931094154986', name: 'Loose link', type: 'url', url: 'https://example.com/loose' },
      ],
      date_added: '13412931094154980',
      name: 'Bookmarks',
      type: 'folder',
    },
    other: {
      children: [
        { date_added: '13412931094154987', name: 'Reference', type: 'folder', children: [
          { date_added: '13412931094154988', name: 'TypeSafe', type: 'url', url: 'https://docs.typesafe.ai/' },
        ] },
      ],
      name: 'Other bookmarks',
      type: 'folder',
    },
  },
  version: 1,
};

describe('chromium bookmark tree', () => {
  test('finds every URL, including nested folders', () => {
    const rows = walkChromiumBookmarks(FIXTURE, 'Brave');
    expect(rows.map((r) => r.title).sort()).toEqual(['Loose link', 'Masterji', 'TimeArena', 'TypeSafe']);
  });

  test('names the folder a bookmark lives in, without the synthetic root', () => {
    const rows = walkChromiumBookmarks(FIXTURE, 'Brave');
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
    expect(byTitle.TimeArena.folder).toBe('ChaiCode');
    // Chromium's non-bar roots keep their own name so folders stay unambiguous;
    // only the bar — literally named "Bookmarks" — is dropped.
    expect(byTitle.TypeSafe.folder).toBe('Other bookmarks / Reference');
    // A bookmark sitting directly in the bar has no folder of its own.
    expect(byTitle['Loose link'].folder).toBe('Bookmarks bar');
  });

  test('carries the browser label through', () => {
    expect(walkChromiumBookmarks(FIXTURE, 'Brave').every((r) => r.browser === 'Brave')).toBe(true);
  });

  test('converts Chromium microsecond timestamps to epoch ms', () => {
    const [row] = walkChromiumBookmarks(FIXTURE, 'Brave');
    // ~2026, not 1601 and not 1970 — this is the bug the history provider had.
    expect(new Date(row.addedMs).getFullYear()).toBeGreaterThan(2020);
  });

  test('survives an empty or malformed tree', () => {
    expect(walkChromiumBookmarks({}, 'Brave')).toEqual([]);
    expect(walkChromiumBookmarks(null, 'Brave')).toEqual([]);
    expect(walkChromiumBookmarks({ roots: { bookmark_bar: { type: 'folder' } } }, 'Brave')).toEqual([]);
  });

  test('ignores non-http entries such as javascript: bookmarklets', () => {
    const withBookmarklet = {
      roots: { bookmark_bar: { name: 'Bookmarks', type: 'folder', children: [
        { name: 'Bookmarklet', type: 'url', url: 'javascript:void(0)' },
        { name: 'Real page', type: 'url', url: 'https://example.com/' },
      ] } },
    };
    const rows = walkChromiumBookmarks(withBookmarklet, 'Brave');
    expect(rows.map((r) => r.title)).toEqual(['Real page']);
  });
});

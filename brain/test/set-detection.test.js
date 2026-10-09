import { test, expect, describe } from 'bun:test';
import { detectSet, groupRow } from '../src/modules/search/set-detection.js';

const bookmark = (fuzzy, title, folder) => ({
  row: { id: `bookmark:${title}`, kind: 'open_url', title, folder, url: `https://example.com/${title}` },
  fuzzy,
});

const page = (fuzzy, title) => ({
  row: { id: `url:${title}`, kind: 'open_url', title, url: `https://example.com/${title}` },
  fuzzy,
});

describe('set detection without Jev', () => {
  test('a named folder becomes a set', () => {
    const scored = ['TimeArena', 'Masterji', 'Courses', 'Chai Visual', 'React'].map((t) => bookmark(0.8, t, 'ChaiCode'));
    const set = detectSet({ query: 'open my ChaiCode bookmarks', timeWindow: null, scored });

    expect(set.active).toBe(true);
    expect(set.rule).toBe('folder');
    expect(set.label).toBe('ChaiCode');
    expect(set.members).toHaveLength(5);
  });

  test("the browser's own containers are not collections", () => {
    // "Bookmarks" appears in the query, but it is where the browser dumps
    // unfiled links — treating it as a collection would open dozens of tabs.
    const scored = [bookmark(0.8, 'a', 'Bookmarks'), bookmark(0.8, 'b', 'Bookmarks bar'), bookmark(0.8, 'c', 'Bookmarks')];
    expect(detectSet({ query: 'open my bookmarks', timeWindow: null, scored }).active).toBe(false);
  });

  test('a named folder beats a default container in the same query', () => {
    const scored = [...['x', 'y'].map((t) => bookmark(0.8, t, 'Bookmarks')), bookmark(0.8, 'TimeArena', 'ChaiCode'), bookmark(0.8, 'Courses', 'ChaiCode')];
    const set = detectSet({ query: 'my ChaiCode bookmarks', timeWindow: null, scored });
    expect(set.label).toBe('ChaiCode');
    expect(set.members.map((m) => m.title)).toEqual(['TimeArena', 'Courses']);
  });

  test('an explicit "all" gathers the strong matches only', () => {
    const scored = [page(0.9, 'one'), page(0.8, 'two'), page(0.2, 'weak')];
    const set = detectSet({ query: 'open all of these', timeWindow: null, scored });

    expect(set.active).toBe(true);
    expect(set.rule).toBe('explicit-all');
    expect(set.members.map((m) => m.title)).toEqual(['one', 'two']);
  });

  test('a time window becomes a set', () => {
    const scored = [page(0.72, 'a'), page(0.68, 'b'), page(0.61, 'c')];
    const set = detectSet({ query: 'links I visited', timeWindow: { label: 'today' }, scored });

    expect(set.active).toBe(true);
    expect(set.rule).toBe('time-window');
    expect(set.members).toHaveLength(3);
  });

  test('a time window ignores rows that only share a word', () => {
    // Two real matches and two marginal ones: the set is the real matches, and
    // the marginal rows are not swept in just for sharing a word.
    const scored = [page(0.72, 'strong'), page(0.65, 'also'), page(0.59, 'marginal'), page(0.45, 'noise')];
    const set = detectSet({ query: 'links I visited', timeWindow: { label: 'today' }, scored });
    expect(set.members.map((m) => m.title)).toEqual(['strong', 'also']);
  });

  test('one member is not a set — there is nothing to open "all" of', () => {
    expect(detectSet({ query: 'open all of these', timeWindow: null, scored: [page(0.9, 'only')] }).active).toBe(false);
  });

  test('an empty query never produces a set', () => {
    expect(detectSet({ query: '', timeWindow: null, scored: [page(0.9, 'a'), page(0.9, 'b')] }).active).toBe(false);
  });

  test('the group row is executable and carries every member', () => {
    const members = ['a', 'b', 'c'].map((t) => bookmark(0.8, t, 'ChaiCode').row);
    const row = groupRow({ members, label: 'ChaiCode', rule: 'folder' });

    expect(row.title).toBe('Open all 3 items');
    expect(row.isGroup).toBe(true);
    expect(row.ready).toBe(true);
    expect(row.kind).toBe('open_url');
    expect(row.members).toHaveLength(3);
    expect(row.detail).toContain('ChaiCode');
  });

  test('the set is capped so "open all" can never open a hundred tabs', () => {
    const scored = Array.from({ length: 60 }, (_, i) => page(0.9, `p${i}`));
    const set = detectSet({ query: 'open all of these', timeWindow: null, scored });
    expect(set.members).toHaveLength(25);
  });
});

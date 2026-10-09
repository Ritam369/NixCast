import { test, expect, describe } from 'bun:test';
import { fuzzyScore, isConfidentMatch, scoreRow, normalize, stripFillers, tokenize } from '../src/modules/search/fuzzy.js';
import { parseTimeWindow } from '../src/modules/search/time-window.js';

describe('fuzzy scoring', () => {
  test('an exact match is the strongest signal', () => {
    expect(fuzzyScore('sleep', 'Sleep')).toBe(1);
  });

  test('a prefix beats a word match', () => {
    const prefix = fuzzyScore('slac', 'Slack');
    const word = fuzzyScore('slack', 'Open Slack Now');
    expect(prefix).toBeGreaterThan(word);
  });

  test('short titles win over long ones', () => {
    expect(fuzzyScore('dark', 'Toggle Dark Mode')).toBeGreaterThan(fuzzyScore('dark', 'malay signature dark png'));
  });

  test('initial matching works for abbreviations but not for sentences', () => {
    // "pd" really does mean Plan Details.
    expect(fuzzyScore('pd', 'Plan Details | Cloudinary')).toBeGreaterThan(0.3);
    // A whole sentence must not collapse to word initials: this exact case
    // once put "Plan Details | Cloudinary" above every PDF on the machine.
    expect(fuzzyScore('the pdf I just downloaded', 'Plan Details | Cloudinary')).toBeLessThan(0.3);
  });

  test('a long phrase is not a subsequence match for everything', () => {
    const score = fuzzyScore('the pdf I just downloaded', 'console cloudinary com visited 2 d ago firefox');
    expect(score).toBeLessThan(0.5);
  });

  test('naming a file extension helps that file', () => {
    const pdf = scoreRow('the pdf I just downloaded', {
      title: 'Ritam_Saha_Resume.pdf',
      detail: 'Recent · opened 1 d ago',
      keywords: 'Ritam_Saha_Resume.pdf Downloads',
    });
    const page = scoreRow('the pdf I just downloaded', {
      title: 'Plan Details | Cloudinary',
      detail: 'console.cloudinary.com · visited 2 d ago · Firefox',
      keywords: 'console.cloudinary.com',
    });
    expect(pdf).toBeGreaterThanOrEqual(page);
  });

  test('normalisation folds case, accents and separators', () => {
    expect(normalize('Résumé_Final.PDF')).toBe('resume final pdf');
    expect(normalize('  spaced   out  ')).toBe('spaced out');
  });

  test('filler words are stripped but never everything', () => {
    const fillers = ['the', 'open', 'a'];
    expect(stripFillers(tokenize('open the pdf'), fillers)).toEqual(['pdf']);
    // A query made only of filler keeps its tokens rather than becoming empty.
    expect(stripFillers(tokenize('open the'), fillers)).toEqual(['open', 'the']);
  });

  test('no match scores zero', () => {
    expect(fuzzyScore('zzzzz', 'Slack')).toBe(0);
  });

  test('isConfidentMatch decides the green Enter', () => {
    const toggle = { title: 'Toggle Dark Mode', keywords: 'toggle dark mode theme', detail: 'Currently on' };
    expect(isConfidentMatch('dark', toggle)).toBe(true);
    expect(isConfidentMatch('dark mode', toggle)).toBe(true);
    expect(isConfidentMatch('da', toggle)).toBe(false); // typing, not intent
    const pdf = { title: 'ritam_aadhar.pdf', keywords: 'recent opened', detail: 'Recent · opened 1 d ago' };
    expect(isConfidentMatch('the pdf I just downloaded', pdf)).toBe(false);
  });

  test('a one- or two-letter word must not match a long token', () => {
    // Regression from the plural fix: a reverse prefix test let the "d" in
    // "opened 1 d ago" satisfy the query "dark", and the "b" in "W.B." satisfy
    // "bluetooth". Both put unrelated rows above the right one.
    expect(fuzzyScore('dark', 'Recent · opened 1 d ago')).toBeLessThan(0.3);
    expect(fuzzyScore('bluetooth', 'MAKAUT, W.B.')).toBeLessThan(0.3);
  });

  test('a plural in the query matches the singular in the target', () => {
    // Regression: "bookmarks" did not match the word "bookmark", so every
    // bookmark row satisfied the same number of tokens and the order was random.
    expect(fuzzyScore('bookmarks', 'Bookmark in ChaiCode')).toBeGreaterThan(0.5);
    expect(fuzzyScore('bookmarks files', 'Bookmark Files')).toBeGreaterThan(0.5);
  });
});

describe('time windows', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const HOUR = 3_600_000;

  test('"in the past 24 hours" produces a window and strips the phrase', () => {
    const window = parseTimeWindow('links I visited in the past 24 hours', now);
    expect(window).not.toBeNull();
    expect(window.since).toBe(now - 24 * HOUR);
    expect(window.strippedQuery).toBe('links I visited');
  });

  test('"last 3 days"', () => {
    const window = parseTimeWindow('files from the last 3 days', now);
    expect(window.since).toBe(now - 72 * HOUR);
  });

  test('"last hour" and "this week" resolve to different sizes', () => {
    expect(parseTimeWindow('opened in the last hour', now).since).toBe(now - HOUR);
    const week = parseTimeWindow('this week', now);
    expect(week.label).toBe('this week');
    expect(week.since).toBeLessThan(now);
  });

  test('"yesterday" starts at the previous midnight', () => {
    const window = parseTimeWindow('what did I read yesterday', now);
    expect(window.label).toBe('yesterday');
    expect(window.since).toBe(Date.UTC(2026, 8, 19, 12, 0, 0) - 12 * HOUR);
  });

  test('"a few days ago"', () => {
    const window = parseTimeWindow('the pdf I downloaded a few days ago', now);
    expect(window.since).toBe(now - 72 * HOUR);
    expect(window.strippedQuery).toBe('the pdf I downloaded');
  });

  test('phrases without a time window return null', () => {
    expect(parseTimeWindow('dark', now)).toBeNull();
    expect(parseTimeWindow('', now)).toBeNull();
  });
});

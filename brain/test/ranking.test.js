import { test, expect, describe } from 'bun:test';
import { buildQuestions, buildEventsState, actionMatchesKind, ACTION_KINDS } from '../src/modules/jev/questions.js';
import { rankRows, orderForDisplay } from '../src/modules/search/ranker.js';
import { DEFAULT_CONFIG } from '../src/common/config.js';

const row = (i, kind = 'open_file') => ({
  candidateId: `c${i}`,
  id: `row${i}`,
  kind,
  title: `Row ${i}`,
  detail: 'detail',
  fuzzy: 0.5,
});

describe('question construction', () => {
  test('every real candidate gets a match question, synthetics do not', () => {
    const rows = [row(0), row(1)];
    const synthetic = [{ candidateId: 'c2', kind: 'web_search', title: 'Search the web', detail: '' }];
    // Membership questions are only asked for set-ish queries now, so this test
    // has to look like one — see wantsSet() in questions.js.
    const { questions, targetOptions } = buildQuestions({ rows, synthetic, query: 'all my links' });

    expect(Object.keys(questions)).toContain('match_c0');
    expect(Object.keys(questions)).toContain('match_c1');
    expect(Object.keys(questions)).not.toContain('match_c2');
    expect(targetOptions).toEqual(['c0', 'c1', 'c2', 'none']);
  });

  test('the target choice always offers "none"', () => {
    const { questions } = buildQuestions({ rows: [row(0)], synthetic: [] });
    expect(questions.target.type).toBe('choice');
    expect(Object.keys(questions.target.criteria)).toContain('none');
  });

  test('the action choice covers every executable kind', () => {
    const { questions } = buildQuestions({ rows: [row(0)], synthetic: [] });
    for (const kind of ACTION_KINDS) {
      expect(Object.keys(questions.action.criteria)).toContain(kind);
    }
  });

  test('ready and scope are present', () => {
    const { questions } = buildQuestions({ rows: [row(0)], synthetic: [] });
    expect(questions.ready.type).toBe('noul');
    expect(questions.scope.type).toBe('choice');
    expect(Object.keys(questions.scope.criteria).sort()).toEqual(['all', 'one']);
  });

  test('the state carries the query, candidates and a time window', () => {
    const state = buildEventsState({
      query: 'links today',
      context: { frontmost_app: 'firefox' },
      timeWindow: { label: 'today', since: 0, until: 1000 },
      rows: [row(0)],
      synthetic: [],
    });
    expect(state.query).toBe('links today');
    expect(state.candidates).toHaveLength(1);
    expect(state.candidates[0].id).toBe('c0');
    expect(state.time_window.label).toBe('today');
    expect(state.context.frontmost_app).toBe('firefox');
  });

  test('an action is credited when it agrees with the row kind', () => {
    expect(actionMatchesKind('open_file', 'open_file')).toBe(1);
    expect(actionMatchesKind('open_file', 'open_url')).toBe(0.5);
    expect(actionMatchesKind('web_search', 'open_file')).toBe(0.4);
    expect(actionMatchesKind('unclear', 'open_file')).toBe(0);
    expect(actionMatchesKind(null, 'open_file')).toBe(0);
  });
});

describe('ranking', () => {
  const weights = DEFAULT_CONFIG.weights;
  const thresholds = DEFAULT_CONFIG.thresholds;

  test('a confident target on top makes Enter ready', () => {
    const ranked = rankRows({
      rows: [row(0), row(1)],
      answers: {
        target: { type: 'choice', choice: 'c0', probabilities: { c0: 0.99, c1: 0.01 } },
        action: { type: 'choice', choice: 'open_file' },
        ready: { type: 'noul', noul: 0.9 },
        scope: { type: 'choice', probabilities: { one: 1, all: 0 } },
      },
      weights,
      thresholds,
    });

    expect(ranked.rows[0].candidateId).toBe('c0');
    expect(ranked.ready).toBe(true);
    expect(ranked.action).toBe('open_file');
    // 0.65*0.99 + 0.20*1 + 0.15*0.5
    expect(ranked.rows[0].score).toBeCloseTo(0.9185, 4);
  });

  test('a 90% target turns Enter green even when ready is unsure', () => {
    const ranked = rankRows({
      rows: [row(0), row(1)],
      answers: {
        target: { type: 'choice', choice: 'c0', probabilities: { c0: 0.95, c1: 0.05 } },
        action: { type: 'choice', choice: 'open_file' },
        ready: { type: 'noul', noul: 0.1 },
        scope: { type: 'choice', probabilities: { one: 1, all: 0 } },
      },
      weights,
      thresholds,
    });
    expect(ranked.ready).toBe(true);
  });

  test('an ambiguous prefix is not ready', () => {
    const ranked = rankRows({
      rows: [row(0), row(1), row(2)],
      answers: {
        target: { type: 'choice', choice: 'c0', probabilities: { c0: 0.4, c1: 0.35, c2: 0.25 } },
        action: { type: 'choice', choice: 'open_file' },
        ready: { type: 'noul', noul: 0.29 },
        scope: { type: 'choice', probabilities: { one: 0.9, all: 0.1 } },
      },
      weights,
      thresholds,
    });
    expect(ranked.ready).toBe(false);
    expect(ranked.set.active).toBe(false);
  });

  test('a set query collects members and offers the group row', () => {
    const ranked = rankRows({
      rows: [row(0, 'open_url'), row(1, 'open_url'), row(2, 'open_url'), row(3, 'open_url')],
      answers: {
        target: { type: 'choice', choice: 'c0', probabilities: { c0: 0.5 } },
        action: { type: 'choice', choice: 'open_url' },
        ready: { type: 'noul', noul: 0.5 },
        scope: { type: 'choice', probabilities: { one: 0.2, all: 0.8 } },
        match_c0: { type: 'noul', noul: 0.95 },
        match_c1: { type: 'noul', noul: 0.9 },
        match_c2: { type: 'noul', noul: 0.8 },
        match_c3: { type: 'noul', noul: 0.1 },
      },
      weights,
      thresholds,
    });

    expect(ranked.set.active).toBe(true);
    expect(ranked.set.size).toBe(3);
    expect(ranked.set.placement).toBe('top');
    expect(ranked.set.ready).toBe(true);

    const display = orderForDisplay({ ranked, maxRows: 7 });
    expect(display[0].isGroup).toBe(true);
    expect(display[0].title).toBe('Open all 3 items');
    expect(display[0].ready).toBe(true);
  });

  test('an unsure set is offered below the best single hit', () => {
    const ranked = rankRows({
      rows: [row(0, 'open_url'), row(1, 'open_url'), row(2, 'open_url')],
      answers: {
        target: { type: 'choice', choice: 'c0', probabilities: { c0: 0.9 } },
        action: { type: 'choice', choice: 'open_url' },
        ready: { type: 'noul', noul: 0.8 },
        scope: { type: 'choice', probabilities: { one: 0.6, all: 0.4 } },
        match_c0: { type: 'noul', noul: 0.9 },
        match_c1: { type: 'noul', noul: 0.8 },
        match_c2: { type: 'noul', noul: 0.7 },
      },
      weights,
      thresholds,
    });

    expect(ranked.set.placement).toBe('after-top');
    const display = orderForDisplay({ ranked, maxRows: 7 });
    // Only the group row carries isGroup; ordinary rows leave it undefined.
    expect(Boolean(display[0].isGroup)).toBe(false);
    expect(display[1].isGroup).toBe(true);
  });

  test('set readiness needs pAll above the higher threshold', () => {
    const ranked = rankRows({
      rows: [row(0, 'open_url'), row(1, 'open_url')],
      answers: {
        target: { type: 'choice', choice: 'c0', probabilities: { c0: 0.9 } },
        action: { type: 'choice', choice: 'open_url' },
        ready: { type: 'noul', noul: 0.9 },
        // above tornAll (0.15) but below readyAll (0.75)
        scope: { type: 'choice', probabilities: { one: 0.7, all: 0.3 } },
        match_c0: { type: 'noul', noul: 0.95 },
        match_c1: { type: 'noul', noul: 0.9 },
      },
      weights,
      thresholds,
    });

    expect(ranked.set.active).toBe(true);
    expect(ranked.set.ready).toBe(false);
    expect(ranked.ready).toBe(false);
  });

  test('rows keep their own kind so the executor still knows what to do', () => {
    const ranked = rankRows({
      rows: [row(0, 'system_toggle')],
      answers: {
        target: { type: 'choice', choice: 'c0', probabilities: { c0: 0.99 } },
        action: { type: 'choice', choice: 'open_file' }, // deliberately wrong
        ready: { type: 'noul', noul: 0.99 },
        scope: { type: 'choice', probabilities: { one: 1, all: 0 } },
      },
      weights,
      thresholds,
    });
    expect(ranked.rows[0].kind).toBe('system_toggle');
  });
});

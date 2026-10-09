import { test, expect, describe } from 'bun:test';
import { rankRows, orderForDisplay } from '../src/modules/search/ranker.js';
import { DEFAULT_CONFIG } from '../src/common/config.js';

const weights = DEFAULT_CONFIG.weights;
const thresholds = DEFAULT_CONFIG.thresholds;

const urlRow = (i) => ({
  candidateId: `c${i}`,
  id: `url:https://example.com/${i}`,
  kind: 'open_url',
  title: `Page ${i}`,
  detail: `example.com · visited 5 min ago · Brave`,
  url: `https://example.com/${i}`,
  fuzzy: 0.5,
});

function setAnswers(n) {
  const answers = {
    target: { type: 'choice', choice: 'c0', probabilities: { c0: 0.5 } },
    action: { type: 'choice', choice: 'open_url' },
    ready: { type: 'noul', noul: 0.9 },
    scope: { type: 'choice', probabilities: { one: 0.2, all: 0.8 } },
  };
  for (let i = 0; i < n; i += 1) answers[`match_c${i}`] = { type: 'noul', noul: 0.9 };
  return answers;
}

describe('the group row must carry its members', () => {
  test('members are attached, so the executor does not receive an empty set', () => {
    // Regression: the panel offered "Open all 7 items" with a green ↵ and then
    // answered "could not run that: set is empty", because orderForDisplay built
    // the group row without members while server.js read `row.members ?? []`.
    const rows = [0, 1, 2, 3, 4, 5, 6].map(urlRow);
    const ranked = rankRows({ rows, answers: setAnswers(7), weights, thresholds });
    const group = orderForDisplay({ ranked, maxRows: 7 }).find((r) => r.isGroup);

    expect(group).toBeDefined();
    expect(Array.isArray(group.members)).toBe(true);
    expect(group.members.length).toBe(7);
    expect(group.members.every((m) => typeof m.url === 'string')).toBe(true);
    expect(group.title).toBe('Open all 7 items');
  });

  test('the group stays executable when the model hedges on the action', () => {
    const rows = [0, 1].map(urlRow);
    const answers = setAnswers(2);
    answers.action = { type: 'choice', choice: 'unclear' };
    const ranked = rankRows({ rows, answers, weights, thresholds });
    const group = orderForDisplay({ ranked, maxRows: 7 }).find((r) => r.isGroup);
    // The row's kind is what the executor switches on, so it must come from the
    // members rather than from a hedged action answer.
    expect(group.kind).toBe('open_url');
  });

  test('members survive the display cap, so Enter opens the whole set', () => {
    // Only maxRows rows are drawn, but the set itself must not be truncated:
    // opening "all 25" must open 25, not the 6 that happen to be visible.
    const rows = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(urlRow);
    const ranked = rankRows({ rows, answers: setAnswers(10), weights, thresholds });
    const display = orderForDisplay({ ranked, maxRows: 4 });
    const group = display.find((r) => r.isGroup);

    expect(display.length).toBeLessThanOrEqual(4);
    expect(group.members.length).toBe(10);
  });

  test('ordinary rows carry no members', () => {
    const rows = [0, 1].map(urlRow);
    const ranked = rankRows({ rows, answers: setAnswers(2), weights, thresholds });
    const display = orderForDisplay({ ranked, maxRows: 7 });
    expect(display.filter((r) => !r.isGroup).every((r) => r.members === undefined)).toBe(true);
  });
});

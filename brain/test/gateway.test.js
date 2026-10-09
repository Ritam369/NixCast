import { test, expect, describe } from 'bun:test';
import {
  toEvaluationQuestions,
  fromEvaluationAnswer,
  fromEvaluationAnswers,
  normalizeUsage,
} from '../src/modules/jev/answers.js';

describe('question translation (native -> AI SDK gateway)', () => {
  test('noul becomes boolean', () => {
    const [question] = Object.values(
      toEvaluationQuestions({ ready: { type: 'noul', instructions: 'Is the intent settled?' } })
    );
    expect(question.type).toBe('boolean');
    expect(question.instructions).toBe('Is the intent settled?');
  });

  test('choice and score are passed through untouched', () => {
    const out = toEvaluationQuestions({
      target: { type: 'choice', instructions: 'which', criteria: { c0: 'Row 0', none: 'nothing' } },
      severity: { type: 'score', instructions: 'how bad', criteria: ['low', 'high'] },
    });
    expect(out.target.type).toBe('choice');
    expect(out.target.criteria.c0).toBe('Row 0');
    expect(out.severity.type).toBe('score');
    expect(out.severity.criteria).toEqual(['low', 'high']);
  });

  test('boolean criteria are only forwarded when supplied', () => {
    const without = toEvaluationQuestions({ a: { type: 'noul', instructions: 'x' } });
    expect('criteria' in without.a).toBe(false);

    const with_ = toEvaluationQuestions({
      a: { type: 'noul', instructions: 'x', criteria: { true: 'yes it is', false: 'no it is not' } },
    });
    expect(with_.a.criteria.true).toBe('yes it is');
  });
});

describe('answer translation (AI SDK gateway -> native)', () => {
  test('a boolean answer becomes a noul', () => {
    const answer = fromEvaluationAnswer('refunded', { type: 'boolean', probability: 0.97 });
    expect(answer).toEqual({ type: 'noul', noul: 0.97 });
  });

  test('choice keeps its distribution, which the ranker reads', () => {
    const answer = fromEvaluationAnswer('target', {
      type: 'choice',
      choice: 'c2',
      probabilities: { c0: 0.05, c2: 0.93, none: 0.02 },
    });
    expect(answer.type).toBe('choice');
    expect(answer.choice).toBe('c2');
    expect(answer.probabilities.c2).toBe(0.93);
  });

  test('score keeps its value and legend', () => {
    const answer = fromEvaluationAnswer('severity', { type: 'score', score: 1.4, probabilities: { 0: 0.2, 1: 0.6 } });
    expect(answer.type).toBe('score');
    expect(answer.score).toBeCloseTo(1.4, 6);
  });

  test('a missing discriminant is inferred, not dropped', () => {
    expect(fromEvaluationAnswer('a', { probability: 0.5 })).toEqual({ type: 'noul', noul: 0.5 });
    expect(fromEvaluationAnswer('b', { choice: 'c1' }).choice).toBe('c1');
    expect(fromEvaluationAnswer('c', { score: 2 }).score).toBe(2);
  });

  test('noul is accepted as an alias for probability', () => {
    // The gateway proxies TypeSafe, so the underlying field may survive.
    expect(fromEvaluationAnswer('a', { type: 'boolean', noul: 0.81 })).toEqual({ type: 'noul', noul: 0.81 });
  });

  test('an unknown answer throws with the payload in the message', () => {
    // This is the failure mode that would otherwise score everything zero and
    // silently send the wrong row to the executor.
    expect(() => fromEvaluationAnswer('ready', { type: 'boolean', nonsense: true })).toThrow(/does not understand/);
    expect(() => fromEvaluationAnswer('ready', undefined)).toThrow(/missing/);
  });

  test('a whole answer map is translated', () => {
    const answers = fromEvaluationAnswers({
      target: { type: 'choice', choice: 'c0', probabilities: { c0: 0.9 } },
      ready: { type: 'boolean', probability: 0.88 },
      match_c0: { type: 'boolean', probability: 0.91 },
    });
    expect(answers.ready.noul).toBeCloseTo(0.88, 6);
    expect(answers.match_c0.noul).toBeCloseTo(0.91, 6);
    expect(answers.target.choice).toBe('c0');
  });
});

describe('usage translation', () => {
  test('camelCase gateway usage becomes the native snake_case shape', () => {
    expect(normalizeUsage({ inputTokens: 1400, outputTokens: 0 })).toEqual({ input_tokens: 1400, output_tokens: 0 });
  });

  test('missing usage is zero, never undefined', () => {
    expect(normalizeUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe('round trip', () => {
  test('the internal vocabulary survives a trip through the gateway shape', () => {
    const native = { ready: { type: 'noul', instructions: 'settled?' } };
    const wire = toEvaluationQuestions(native);
    expect(wire.ready.type).toBe('boolean');

    // A real gateway answer for that question, back to what the ranker wants.
    const back = fromEvaluationAnswers({ ready: { type: 'boolean', probability: 0.64 } });
    expect(back.ready).toEqual({ type: 'noul', noul: 0.64 });
  });
});

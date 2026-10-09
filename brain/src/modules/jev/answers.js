/**
 * Translation between this project's questions and the two wire formats.
 *
 * Everything inside the brain speaks TypeSafe's native vocabulary:
 *   question type  'choice' | 'score' | 'noul'
 *   answer field   .choice / .score / .noul
 *
 * The macOS launcher talks to api.typesafe.ai, where that vocabulary *is* the
 * wire format. The Vercel AI Gateway route (model `typesafe-ai/jev` through the
 * AI SDK's experimental_evaluate) uses almost the same vocabulary, with one
 * rename and one shape change:
 *
 *   noul        ->  boolean        (question type)
 *   { noul }    ->  { probability }  (answer field: model-estimated P(true))
 *
 * Keeping the rename in one file means the ranker, the engine and the existing
 * tests never need to know which transport answered.
 */

/** The AI SDK calls the yes/no primitive `boolean` and expects a P(true). */
export function toEvaluationQuestions(questions) {
  const out = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'noul') {
      out[id] = {
        type: 'boolean',
        instructions: question.instructions,
        // A criteria pair sharpens the model's reading of "true". Only added
        // when the caller asked for it, so instructions stay authoritative.
        ...(question.criteria ? { criteria: question.criteria } : {}),
      };
    } else {
      out[id] = question;
    }
  }
  return out;
}

function answerError(id, answer) {
  const received = answer === undefined ? 'missing' : JSON.stringify(answer).slice(0, 200);
  return new Error(
    `Jev returned an answer for "${id}" that this build does not understand: ${received}. ` +
      'Expected { type: "boolean", probability } for a noul/boolean question, ' +
      '{ type: "choice", choice, probabilities } or { type: "score", score }.'
  );
}

/** One gateway answer -> one native answer. Throws rather than scoring zero. */
export function fromEvaluationAnswer(id, answer) {
  if (!answer || typeof answer !== 'object') throw answerError(id, answer);

  switch (answer.type) {
    case 'boolean': {
      const probability = pickProbability(answer);
      if (probability === null) throw answerError(id, answer);
      return { type: 'noul', noul: probability };
    }
    case 'choice':
      return { type: 'choice', choice: answer.choice, probabilities: answer.probabilities ?? {} };
    case 'score':
      return { type: 'score', score: answer.score, probabilities: answer.probabilities ?? {} };
    default:
      // Some providers omit the discriminant. Infer it rather than dropping the
      // answer, but still refuse anything unrecognisable.
      if (typeof answer.probability === 'number') return { type: 'noul', noul: answer.probability };
      if (typeof answer.choice === 'string') return { type: 'choice', choice: answer.choice, probabilities: answer.probabilities ?? {} };
      if (typeof answer.score === 'number') return { type: 'score', score: answer.score, probabilities: answer.probabilities ?? {} };
      throw answerError(id, answer);
  }
}

/**
 * The documented field for a boolean answer is `probability`. `noul` is
 * accepted too because that is what the underlying model call returns, and a
 * bare number because a provider may unwrap a single-value answer.
 */
function pickProbability(answer) {
  const candidates = [answer.probability, answer.noul, answer.probabilityTrue, typeof answer === 'number' ? answer : undefined];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function fromEvaluationAnswers(answers) {
  const out = {};
  for (const [id, answer] of Object.entries(answers ?? {})) {
    out[id] = fromEvaluationAnswer(id, answer);
  }
  return out;
}

/** Gateway usage is camelCase; the raw API is snake_case. Native shape wins. */
export function normalizeUsage(usage) {
  return {
    input_tokens: usage?.inputTokens ?? usage?.input_tokens ?? 0,
    output_tokens: usage?.outputTokens ?? usage?.output_tokens ?? 0,
  };
}

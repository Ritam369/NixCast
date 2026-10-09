/**
 * Vercel AI Gateway transport.
 *
 *   import { experimental_evaluate } from 'ai';
 *   evaluate({ model: gateway.evaluationModel('typesafe-ai/jev'), state, questions })
 *
 * Why the SDK instead of hand-rolled HTTP: the gateway's evaluation route is
 * not the OpenAI chat shape, and `experimental_evaluate` is the supported way
 * to reach it. It also gives retries, abort signals and typed answers.
 *
 * The `ai` package is imported lazily. Without `bun install` the brain must
 * still start and behave as a plain fuzzy launcher, so a missing dependency
 * becomes a clear message rather than a boot failure.
 */

import { createLogger } from '../../common/logger.js';
import { toEvaluationQuestions, fromEvaluationAnswers, normalizeUsage } from './answers.js';

const log = createLogger('jev.gateway');

/** Thrown for gateway failures; client.js converts it into a JevError. */
export class EvaluationError extends Error {
  constructor(message, { status = null, retryable = false, body = null } = {}) {
    super(message);
    this.name = 'EvaluationError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

let sdk = null;

async function loadSdk() {
  if (sdk) return sdk;

  let ai;
  let gatewayProvider;
  try {
    [ai, gatewayProvider] = await Promise.all([import('ai'), import('@ai-sdk/gateway')]);
  } catch (err) {
    throw new EvaluationError(
      `the AI SDK is not installed (${err instanceof Error ? err.message : String(err)}). Run:  cd ~/jev-launcher-nixos/brain && bun install`,
      { retryable: false }
    );
  }

  if (typeof ai.experimental_evaluate !== 'function') {
    throw new EvaluationError(
      `the installed "ai" package (${ai.VERSION ?? 'unknown version'}) has no experimental_evaluate export. Upgrade it:  bun add ai@latest`,
      { retryable: false }
    );
  }
  if (typeof gatewayProvider.createGateway !== 'function') {
    throw new EvaluationError('the installed "@ai-sdk/gateway" package has no createGateway export. Run:  bun add @ai-sdk/gateway@latest', {
      retryable: false,
    });
  }

  sdk = { evaluate: ai.experimental_evaluate, createGateway: gatewayProvider.createGateway, version: ai.VERSION ?? null };
  return sdk;
}

function statusOf(err) {
  return err?.statusCode ?? err?.lastError?.statusCode ?? err?.cause?.statusCode ?? err?.status ?? null;
}

/**
 * The full error body. It is parsed to read the gateway's own error type, so it
 * must not be clipped first — a 500-character slice cuts the JSON mid-string and
 * silently loses the explanation users most need to see.
 */
function fullBodyOf(err) {
  const body = err?.responseBody ?? err?.lastError?.responseBody ?? err?.cause?.responseBody ?? null;
  if (body === null || body === undefined) return null;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/** The same body, clipped for display in logs and error objects. */
function bodyOf(err) {
  const body = fullBodyOf(err);
  return typeof body === 'string' ? body.slice(0, 500) : body;
}

function retryableStatus(status) {
  return status === 408 || status === 429 || (typeof status === 'number' && status >= 500);
}

function parseErrorBody(body) {
  if (typeof body !== 'string') return body ?? null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Turn a gateway failure into something a human can act on.
 *
 * The gateway answers `{"error":{"message","type"}}`, and that message is always
 * more specific than the status code. In particular a 403 is usually *not* an
 * invalid key: the most common one is an unverified account, and blaming the key
 * for it sends people looking in the wrong place. Pure and exported so these
 * branches — the ones users actually hit — are covered by tests with no network.
 */
export function explainGatewayError({ status = null, body = null, fallback = null } = {}) {
  const parsed = parseErrorBody(body);
  const type = parsed?.error?.type ?? null;
  const detail = parsed?.error?.message ?? null;

  if (type === 'customer_verification_required') {
    return {
      message: `the AI Gateway will not serve requests until the Vercel account is verified: ${detail ?? 'a payment method is required on file'}`,
      hint: 'add a payment method to the Vercel account that owns this key, then re-run --check',
      retryable: false,
    };
  }
  if (type === 'authentication_error' || status === 401) {
    return {
      message: `the gateway rejected this API key (${status ?? 'auth error'}): ${detail ?? 'no detail'}`,
      hint: 'check jev.apiKey in ~/.config/jev-launcher/config.json',
      retryable: false,
    };
  }
  if (status === 403) {
    // A 403 from this gateway is usually a plan or account limit, not a bad key.
    // Requesting zero data retention on a plan that lacks it is the easiest one
    // to trip over, because it is a setting we send ourselves.
    const isZdr = /zero data retention|ZDR/i.test(detail ?? '');
    return {
      message: `the gateway refused the request (403): ${detail ?? 'no detail'}`,
      hint: isZdr
        ? 'set jev.zeroDataRetention to false, or upgrade the Vercel plan — ZDR is not on Hobby'
        : 'read the gateway message before suspecting the key — account verification and spend limits look like this too',
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      message: `the gateway does not know this model (404): ${detail ?? 'no detail'}`,
      hint: 'check that jev.model is a model your key can use, e.g. "typesafe-ai/jev"',
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      message: `the gateway is rate limiting this key (429): ${detail ?? 'no detail'}`,
      hint: 'raise jev.debounceMs so fewer requests go out',
      retryable: true,
    };
  }

  return {
    message: detail ?? fallback ?? `gateway call failed (${status ?? 'no status'})`,
    hint: null,
    retryable: retryableStatus(status),
  };
}

function toEvaluationError(err) {
  if (err instanceof EvaluationError) return err;

  const status = statusOf(err);
  const body = bodyOf(err);
  const raw = err instanceof Error ? err.message : String(err);

  // A body that is not the gateway's JSON envelope (a proxy, a TLS failure) has
  // nothing better to offer than the SDK's own wording.
  const explanation = explainGatewayError({ status, body: fullBodyOf(err), fallback: raw });
  const message = explanation.hint ? `${explanation.message} — ${explanation.hint}` : explanation.message;

  return new EvaluationError(message, { status, retryable: explanation.retryable, body });
}

/** Which gateway base URL the provider will use, for the warm-up check. */
export const DEFAULT_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1';

export function gatewayInfo() {
  return sdk ? { loaded: true, aiVersion: sdk.version } : { loaded: false, aiVersion: null };
}

/**
 * Run every question against one state in a single gateway call.
 *
 * @returns {Promise<{answers: object, usage: object, modelId: string, raw: object}>}
 */
export async function evaluateViaGateway({
  apiKey,
  model,
  state,
  questions,
  maxRetries = 2,
  timeoutMs = 15000,
  zeroDataRetention = true,
  baseURL = '',
}) {
  const { evaluate, createGateway } = await loadSdk();

  const gateway = createGateway({
    ...(apiKey ? { apiKey } : {}),
    // Only override the provider's own default when the user set one; a wrong
    // base URL here breaks every call, so the default is "say nothing".
    ...(baseURL ? { baseURL } : {}),
  });

  // Evaluation models must be resolved through the provider: a bare string
  // would go through the default provider, and evaluation never falls back to
  // the gateway implicitly.
  const resolved = typeof gateway.evaluationModel === 'function' ? gateway.evaluationModel(model) : model;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await evaluate({
      model: resolved,
      state,
      questions: toEvaluationQuestions(questions),
      maxRetries,
      abortSignal: controller.signal,
      ...(zeroDataRetention ? { providerOptions: { gateway: { zeroDataRetention: true } } } : {}),
    });

    return {
      answers: fromEvaluationAnswers(result.answers),
      usage: normalizeUsage(result.usage),
      modelId: result.response?.modelId ?? model,
      warnings: result.warnings ?? [],
      raw: result,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new EvaluationError(`the gateway call exceeded the ${timeoutMs} ms timeout (jev.timeoutMs)`, { retryable: true });
    }
    const mapped = toEvaluationError(err);
    log.debug('gateway call failed', String(mapped.message));
    throw mapped;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One cheap question that proves the key, the model id and the answer shape.
 * Used by `bun run src/index.js --check` so the first live call explains itself.
 */
export async function probeGateway(config) {
  const started = performance.now();
  const result = await evaluateViaGateway({
    apiKey: config.jev.apiKey,
    model: config.jev.model,
    state: { note: 'connectivity probe from the Jev Launcher brain', text: 'The support agent issued a full refund.' },
    questions: {
      refunded: { type: 'noul', instructions: 'Was a refund issued?' },
      ready: { type: 'noul', instructions: 'Is this state non-empty?' },
    },
    maxRetries: 0,
    timeoutMs: config.jev.timeoutMs,
    zeroDataRetention: config.jev.zeroDataRetention,
    baseURL: config.jev.gatewayBaseUrl,
  });
  return { ...result, rttMs: Math.round(performance.now() - started) };
}

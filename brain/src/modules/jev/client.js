/**
 * TypeSafe / Jev client, with two transports behind one interface.
 *
 *   gateway  Vercel AI Gateway through the AI SDK's experimental_evaluate:
 *            model `typesafe-ai/jev`, question type `boolean`, answer field
 *            `probability`. This is the transport for an AI Gateway key.
 *   direct   TypeSafe's own HTTP API: POST {baseUrl}{path}, model `jev-latest`,
 *            question type `noul`, answer field `noul`. For a TypeSafe key.
 *
 * Both normalize to the same native answer shape (see answers.js), so the
 * ranker cannot tell them apart. Jev never generates text: it answers typed
 * questions with calibrated probabilities.
 *
 * Two things matter more here than in the macOS original:
 *   1. The connection must stay warm. A cold TLS handshake from India costs
 *      roughly 0.6 s, which would dominate the round trip. A startup warm-up
 *      request and Bun's pooled fetch keep it near 0.3 s.
 *   2. In-flight staleness. Keystrokes produce overlapping requests; each
 *      response carries the caller's sequence number and late answers are
 *      dropped by the caller, not retried here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../common/logger.js';
import { paths, ensureDir } from '../../common/paths.js';
import { evaluateViaGateway, probeGateway, EvaluationError, DEFAULT_GATEWAY_BASE_URL } from './gateway.js';

const log = createLogger('jev');

/** Jev 1.13 pricing: $42 per billion input tokens = $0.042 per million. */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/** Lifetime totals live on disk so the footer's number survives a restart. */
const USAGE_FILE = path.join(paths.stateDir, 'jev-launcher', 'usage.json');

function loadAllTime() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    return {
      decisions: Number(parsed.decisions) || 0,
      inputTokens: Number(parsed.inputTokens) || 0,
      costUsd: Number(parsed.costUsd) || 0,
    };
  } catch {
    return { decisions: 0, inputTokens: 0, costUsd: 0 };
  }
}

export class JevError extends Error {
  constructor(message, { status, retryable = false, body } = {}) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

function retryableStatus(status) {
  return status === 429 || status === 529 || status === 500 || status === 502 || status === 503;
}

export class JevClient {
  #config;
  #stats = {
    decisions: 0,
    inputTokens: 0,
    costUsd: 0,
    lastRttMs: null,
    samples: [],
    errors: 0,
    lastError: null,
    warmedUp: false,
  };

  #allTime = loadAllTime();
  #saveTimer = null;

  constructor(config) {
    this.#config = config;
  }

  /** Session and lifetime totals, for the panel's footer. */
  get usage() {
    return {
      session: { decisions: this.#stats.decisions, inputTokens: this.#stats.inputTokens, costUsd: this.#stats.costUsd },
      allTime: { ...this.#allTime },
    };
  }

  /** Fold one decision into both counters, and schedule a persist. */
  #recordUsage({ inputTokens, costUsd }) {
    this.#stats.decisions += 1;
    this.#stats.inputTokens += inputTokens;
    this.#stats.costUsd += costUsd;
    this.#allTime.decisions += 1;
    this.#allTime.inputTokens += inputTokens;
    this.#allTime.costUsd += costUsd;

    // At most one write per 15 s: a cost counter does not need per-keystroke I/O.
    if (!this.#saveTimer) {
      this.#saveTimer = setTimeout(() => {
        this.#saveTimer = null;
        this.flush();
      }, 15_000);
      this.#saveTimer.unref?.();
    }
  }

  /** Persist the lifetime totals. Safe to call at any time. */
  flush() {
    try {
      ensureDir(path.dirname(USAGE_FILE));
      fs.writeFileSync(USAGE_FILE, `${JSON.stringify(this.#allTime)}\n`, { mode: 0o600 });
    } catch (err) {
      log.debug('could not persist usage', String(err));
    }
  }

  get stats() {
    const samples = this.#stats.samples;
    const sorted = [...samples].sort((a, b) => a - b);
    const pick = (q) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
    return {
      ...this.#stats,
      p50Ms: pick(0.5),
      p95Ms: pick(0.95),
      samples: undefined,
    };
  }

  get #url() {
    const base = this.#config.jev.baseUrl.replace(/\/+$/, '');
    const path = this.#config.jev.path.startsWith('/') ? this.#config.jev.path : `/${this.#config.jev.path}`;
    return `${base}${path}`;
  }

  #headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.#config.jev.apiKey}`,
      'User-Agent': 'jev-launcher-nixos/0.1 (+gnome-shell-extension)',
      ...(this.#config.jev.extraHeaders ?? {}),
    };
  }

  /**
   * Establish TLS and verify credentials before the first keystroke.
   * Never throws: a failed warm-up just means the first query pays the cost.
   */
  async warmup() {
    if (!this.#config.jev.warmup) return { ok: false, reason: 'disabled' };

    // For the gateway transport the warm-up does two jobs: prime the connection
    // pool, and fail fast on a bad key before the first keystroke. A model list
    // is the cheapest authenticated call either endpoint offers.
    const base =
      this.#config.jev.transport === 'gateway'
        ? (this.#config.jev.gatewayBaseUrl || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, '')
        : this.#config.jev.baseUrl.replace(/\/+$/, '');

    // The gateway's own default base URL already ends in /v1 while the direct
    // API does not, so appending blindly produced /v1/v1/models and a 404.
    const modelsUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;

    // One retry: this runs a second after the session starts, which is exactly
    // when a just-reconnected network can still fail DNS. A cold pool is not an
    // error, but a wasted round trip on the first keystroke is worth avoiding.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await fetch(modelsUrl, {
          headers: this.#headers(),
          signal: AbortSignal.timeout(this.#config.jev.timeoutMs),
        });
        const ok = res.ok;
        this.#stats.warmedUp = ok;
        if (!ok) {
          const body = await res.text().catch(() => '');
          log.warn(`warm-up returned ${res.status}`, body.slice(0, 300));
          return { ok: false, status: res.status, body: body.slice(0, 300) };
        }
        log.info('warm-up ok, connection pool primed');
        return { ok: true };
      } catch (err) {
        if (attempt < 2) {
          log.debug('warm-up failed, retrying once', String(err));
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        log.warn('warm-up failed', String(err));
        return { ok: false, reason: String(err) };
      }
    }
    return { ok: false, reason: 'unreachable' };
  }

  /**
   * One real evaluation that proves the key, the model id and the answer shape.
   * `--check` runs this so the first live call explains itself instead of
   * failing silently inside the panel.
   */
  async probe() {
    if (this.#config.jev.transport === 'gateway') {
      return probeGateway(this.#config);
    }

    const result = await this.ask({
      state: { note: 'connectivity probe from the Jev Launcher brain', text: 'The support agent issued a full refund.' },
      questions: { refunded: { type: 'noul', instructions: 'Was a refund issued?' } },
    });
    return { ...result, raw: { answers: result.answers } };
  }

  async ask(payload) {
    if (this.#config.jev.transport === 'gateway') return this.#askViaGateway(payload);
    return this.#askDirect(payload);
  }

  /**
   * Vercel AI Gateway path. Retries and abort handling live inside the AI SDK
   * call, so this wrapper only records stats and converts errors.
   */
  async #askViaGateway(payload) {
    const { maxRetries = 2, timeoutMs = 15000, model, zeroDataRetention } = this.#config.jev;
    const started = performance.now();

    try {
      const result = await evaluateViaGateway({
        apiKey: this.#config.jev.apiKey,
        model,
        state: payload.state,
        questions: payload.questions,
        maxRetries,
        timeoutMs,
        zeroDataRetention,
        baseURL: this.#config.jev.gatewayBaseUrl,
      });

      const rttMs = Math.round(performance.now() - started);
      const inputTokens = result.usage?.input_tokens ?? 0;
      // Cross-checked against the gateway's own `marketCost`: this arithmetic
      // matched it exactly, so the footer's figure is the real list price.
      const costUsd = inputTokens * USD_PER_INPUT_TOKEN;
      this.#stats.lastRttMs = rttMs;
      this.#stats.samples.push(rttMs);
      if (this.#stats.samples.length > 200) this.#stats.samples.shift();
      this.#recordUsage({ inputTokens, costUsd });

      return {
        answers: result.answers,
        usage: result.usage,
        model: result.modelId,
        rttMs,
        costUsd,
      };
    } catch (err) {
      this.#stats.errors += 1;
      this.#stats.lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof EvaluationError) {
        throw new JevError(err.message, { status: err.status, retryable: err.retryable, body: err.body });
      }
      throw err;
    }
  }

  /**
   * Direct TypeSafe API path — the transport the macOS launcher uses.
   */
  async #askDirect(payload) {
    const { maxRetries = 1, timeoutMs = 6000 } = this.#config.jev;
    let attempt = 0;
    let lastError;

    while (attempt <= maxRetries) {
      const started = performance.now();
      try {
        const res = await fetch(this.#url, {
          method: 'POST',
          headers: this.#headers(),
          body: JSON.stringify({
            model: this.#config.jev.model,
            state: payload.state,
            questions: payload.questions,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new JevError(`Jev returned ${res.status}`, {
            status: res.status,
            retryable: retryableStatus(res.status),
            body: body.slice(0, 500),
          });
        }

        const json = await res.json();
        const rttMs = Math.round(performance.now() - started);
        const inputTokens = json.usage?.input_tokens ?? 0;
        const costUsd = inputTokens * USD_PER_INPUT_TOKEN;

        this.#stats.lastRttMs = rttMs;
        this.#stats.samples.push(rttMs);
        if (this.#stats.samples.length > 200) this.#stats.samples.shift();
        this.#recordUsage({ inputTokens, costUsd });

        return { answers: json.answers ?? {}, usage: json.usage ?? {}, model: json.model, rttMs, costUsd };
      } catch (err) {
        lastError = err;
        const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        const retryable = err instanceof JevError ? err.retryable : isTimeout;
        if (!retryable || attempt === maxRetries) break;
        const backoff = 150 * 2 ** attempt;
        log.debug(`retrying after ${backoff}ms`, String(err));
        await new Promise((r) => setTimeout(r, backoff));
        attempt += 1;
      }
    }

    this.#stats.errors += 1;
    this.#stats.lastError = lastError instanceof Error ? lastError.message : String(lastError);
    throw lastError;
  }
}

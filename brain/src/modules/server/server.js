/**
 * Unix-socket server speaking newline-delimited JSON to the GNOME Shell
 * extension.
 *
 * A unix socket in $XDG_RUNTIME_DIR is deliberate: no TCP port to collide with
 * anything, and the socket is only reachable by this user's session.
 *
 * Message shapes (both directions, `v` is the protocol version):
 *
 *   -> {v:1, id:7, type:"hello"}
 *   <- {v:1, id:7, type:"hello", index:{...}, jev:{...}}
 *
 *   -> {v:1, id:8, seq:41, type:"query", text:"the pdf I", context:{frontmost_app:"Firefox"}}
 *   <- {v:1, id:8, seq:41, type:"results", phase:"local", rows:[...]}
 *   <- {v:1, id:8, seq:41, type:"results", phase:"jev",   rows:[...], stats:{...}}
 *
 *   -> {v:1, id:9, seq:41, type:"execute", rowId:"c3", query:"the pdf I"}
 *   <- {v:1, id:9, type:"executed", ok:true, message:"Opened Q3.pdf"}
 *
 *   -> {v:1, id:10, type:"stats"}       <- {type:"stats", jev:{...}, index:{...}}
 *   -> {v:1, id:11, type:"reindex"}     <- {type:"reindexed", index:{...}}
 *   -> {v:1, id:12, type:"config"}      <- {type:"config", config:{...no secrets...}}
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../common/logger.js';
import { paths, ensureDir } from '../../common/paths.js';
import { jevIsConfigured } from '../../common/config.js';

const log = createLogger('server');
export const PROTOCOL_VERSION = 1;

class Connection {
  #socket;
  #server;
  #buffer = '';
  #latestSeq = 0;
  #lastRows = new Map();
  #lastGroups = new Map();
  #inFlight = 0;

  constructor(socket, server) {
    this.#socket = socket;
    this.#server = server;
  }

  send(message) {
    try {
      this.#socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, ...message })}\n`);
    } catch (err) {
      log.debug('write failed, client went away', String(err));
    }
  }

  handleChunk(text) {
    this.#buffer += text;
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.send({ type: 'error', error: 'malformed json' });
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    const { id, type } = message;
    switch (type) {
      case 'hello':
        return this.send({ id, type: 'hello', index: this.#server.indexSummary(), jev: this.#server.jevSummary(), protocol: PROTOCOL_VERSION });
      case 'query':
        return this.#query(message);
      case 'execute':
        return this.#execute(message);
      case 'stats':
        return this.send({ id, type: 'stats', jev: this.#server.jevStats(), index: this.#server.indexSummary() });
      case 'reindex':
        return this.#server.reindex().then(
          (index) => this.send({ id, type: 'reindexed', index }),
          (err) => this.send({ id, type: 'error', error: String(err) })
        );
      case 'config':
        return this.send({ id, type: 'config', config: this.#server.safeConfig() });
      default:
        return this.send({ id, type: 'error', error: `unknown message type: ${type}` });
    }
  }

  async #query(message) {
    const { id, seq = 0, text = '', context = {}, debounceMs = null } = message;

    // Newest answer wins: an answer for an older sequence number is discarded
    // on arrival, and the debounce timer below is restarted on every
    // keystroke, so a burst of typing produces exactly one Jev request.
    this.#latestSeq = Math.max(this.#latestSeq, seq);

    const local = this.#server.engine.local(text, context);
    this.#rememberRows(local.view.rows);

    // The fuzzy phase is sent before any network work, which is what keeps
    // typing instant even though a warm Jev round trip is ~300 ms.
    this.send({ id, seq, type: 'results', ...local.view });

    if (!this.#server.jevConfigured()) {
      return;
    }

    if (this._jevTimer) clearTimeout(this._jevTimer);
    const delay = Math.max(0, debounceMs ?? this.#server.jevSummary().debounceMs ?? 180);
    this._jevTimer = setTimeout(() => {
      this._jevTimer = null;
      this.#askJev({ id, seq, text, local });
    }, delay);
  }

  async #askJev({ id, seq, text, local }) {
    // A newer keystroke arrived while we were waiting; it owns the answer.
    if (seq < this.#latestSeq) {
      log.debug(`skipping superseded query seq=${seq} (latest=${this.#latestSeq})`);
      return;
    }

    // Identical text repeated (fast typists, backspace) costs nothing.
    if (this.#server.isDuplicateQuery(text)) {
      log.debug(`duplicate query skipped: ${JSON.stringify(text)}`);
      return;
    }

    this.#inFlight += 1;
    try {
      const result = await this.#server.jev.ask(local.payload);
      if (seq < this.#latestSeq) {
        log.debug(`dropping stale answer seq=${seq} (latest=${this.#latestSeq})`);
        return;
      }
      const ranked = this.#server.engine.ranked(local, result);
      this.#rememberRows(ranked.view.rows);
      // `usage` carries the session and lifetime totals the footer shows.
      this.send({ id, seq, type: 'results', ...ranked.view, stats: ranked.stats, usage: this.#server.jev.usage });
    } catch (err) {
      log.warn('jev request failed', String(err));
      this.send({ id, seq, type: 'jev_error', error: err instanceof Error ? err.message : String(err), detail: err?.body ?? null });
    } finally {
      this.#inFlight -= 1;
    }
  }

  async #execute(message) {
    const { id, rowId, query = '' } = message;
    try {
      const row = this.#lastRows.get(rowId);
      if (!row) throw new Error(`unknown row: ${rowId}`);

      let message_out;
      if (row.isGroup) {
        const members = this.#lastGroups.get(rowId) ?? [];
        message_out = await this.#server.executor.executeSet(members, { query });
      } else {
        message_out = await this.#server.executor.executeRow(row, { query });
      }

      // Toggle titles flip, so the next query re-reads the index.
      if (row.kind === 'system_toggle') this.#server.refreshTogglesSoon();

      // `kind` lets the extension keep the panel open for a toggle, which has no
      // visible window to confirm it worked.
      this.send({ id, type: 'executed', ok: true, message: message_out, rowId, kind: row.kind });
    } catch (err) {
      log.warn(`execute failed for ${rowId}`, String(err));
      this.send({ id, type: 'executed', ok: false, message: err instanceof Error ? err.message : String(err), rowId });
    }
  }

  #rememberRows(rows) {
    for (const row of rows) {
      this.#lastRows.set(row.id, row);
      if (row.isGroup) {
        // The group row's members were attached by orderForDisplay.
        this.#lastGroups.set(row.id, row.members ?? []);
      }
    }
  }
}

export class BrainServer {
  #config;
  #indexer;
  #engine;
  #executor;
  #jev;
  #listener;
  #recentQueries = new Map();
  #stats = { connections: 0, queries: 0, bytes: 0 };

  constructor({ config, indexer, engine, executor, jev }) {
    this.#config = config;
    this.#indexer = indexer;
    this.#engine = engine;
    this.#executor = executor;
    this.#jev = jev;
  }

  get engine() {
    return this.#engine;
  }

  get executor() {
    return this.#executor;
  }

  get jev() {
    return this.#jev;
  }

  jevConfigured() {
    return jevIsConfigured(this.#config);
  }

  /**
   * Coalesces repairs of the exact same query within a short window. The macOS
   * original fires on every keystroke; from India that is money spent on
   * answers nobody reads.
   */
  isDuplicateQuery(text) {
    const now = Date.now();
    for (const [key, at] of this.#recentQueries) {
      if (now - at > 1500) this.#recentQueries.delete(key);
    }
    if (this.#recentQueries.has(text)) return true;
    this.#recentQueries.set(text, now);
    return false;
  }

  indexSummary() {
    const s = this.#indexer.snapshot;
    return { ready: s.ready, builtAt: s.builtAt, counting: s.counting, sources: s.sources, stats: this.#stats };
  }

  jevSummary() {
    const configured = this.jevConfigured();
    // `mode` lets the panel say the right thing: 'local' is a deliberate choice,
    // 'no-key' is a setup step. The old single message told a working local setup
    // to add a key it already had.
    const transport = this.#config.jev.transport;
    const mode = !this.#config.jev.enabled || transport === 'off' ? 'local' : configured ? 'jev' : 'no-key';

    return {
      mode,
      configured,
      enabled: this.#config.jev.enabled,
      transport,
      model: this.#config.jev.model,
      baseUrl: this.#config.jev.baseUrl,
      debounceMs: this.#config.jev.debounceMs,
      hint: configured ? null : 'Set jev.apiKey in ~/.config/jev-launcher/config.json',
    };
  }

  jevStats() {
    return this.#jev.stats;
  }

  safeConfig() {
    // Never leak the key over the socket, even to our own extension.
    const { apiKey, extraHeaders, ...rest } = this.#config.jev;
    return {
      jev: { ...rest, apiKey: apiKey ? '***set***' : '' },
      search: this.#config.search,
      weights: this.#config.weights,
      thresholds: this.#config.thresholds,
      ui: this.#config.ui,
    };
  }

  async reindex() {
    await this.#indexer.refresh();
    return this.indexSummary();
  }

  refreshTogglesSoon() {
    setTimeout(() => {
      this.#indexer.refresh().catch((err) => log.debug('post-execute refresh failed', String(err)));
    }, 250);
  }

  listen(socketPath = paths.socketPath) {
    ensureDir(path.dirname(socketPath));
    if (fs.existsSync(socketPath)) fs.rmSync(socketPath, { force: true });

    this.#listener = Bun.listen({
      unix: socketPath,
      socket: {
        open: () => {
          this.#stats.connections += 1;
          log.debug('extension connected');
        },
        data: (socket, data) => {
          this.#stats.bytes += data.length;
          const conn = socket.__jevConn ?? (socket.__jevConn = new Connection(socket, this));
          conn.handleChunk(data.toString('utf8'));
        },
        close: () => log.debug('extension disconnected'),
        error: (socket, err) => log.debug('socket error', String(err)),
      },
    });

    fs.chmodSync(socketPath, 0o600);
    log.info(`listening on ${socketPath}`);
    return socketPath;
  }

  async close() {
    try {
      this.#listener?.stop(true);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(paths.socketPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

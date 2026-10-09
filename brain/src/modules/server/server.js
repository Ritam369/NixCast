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
 *   <- {v:1, id:7, type:"hello", app:{...}, index:{...}}
 *
 *   -> {v:1, id:8, seq:41, type:"query", text:"the pdf I", context:{frontmost_app:"Firefox"}}
 *   <- {v:1, id:8, seq:41, type:"results", phase:"local", rows:[...], ready, set}
 *
 *   -> {v:1, id:9, seq:41, type:"execute", rowId:"c3", query:"the pdf I"}
 *   <- {v:1, id:9, type:"executed", ok:true, message:"Opened Q3.pdf"}
 *
 *   -> {v:1, id:10, type:"stats"}       <- {type:"stats", index:{...}}
 *   -> {v:1, id:11, type:"reindex"}     <- {type:"reindexed", index:{...}}
 *   -> {v:1, id:12, type:"config"}      <- {type:"config", config:{...no secrets...}}
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../common/logger.js';
import { paths, ensureDir } from '../../common/paths.js';
const log = createLogger('server');
export const PROTOCOL_VERSION = 1;

/** Reported to the panel so it can name itself and show a version. */
export const APP = { name: 'NixCast', version: '1.0.0' };

class Connection {
  #socket;
  #server;
  #buffer = '';
  #latestSeq = 0;
  #lastRows = new Map();
  #lastGroups = new Map();

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
        return this.send({ id, type: 'hello', app: APP, index: this.#server.indexSummary(), protocol: PROTOCOL_VERSION });
      case 'query':
        return this.#query(message);
      case 'execute':
        return this.#execute(message);
      case 'stats':
        return this.send({ id, type: 'stats', index: this.#server.indexSummary() });
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

  #query(message) {
    const { id, seq = 0, text = '', context = {} } = message;

    // Answered immediately and entirely from the local index. `seq` is echoed
    // back so the panel can ignore an answer that a newer keystroke has already
    // superseded.
    this.#latestSeq = Math.max(this.#latestSeq, seq);

    const local = this.#server.engine.local(text, context);
    this.#rememberRows(local.view.rows);
    this.send({ id, seq, type: 'results', ...local.view });
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

      // A toggle changes its own title, so the next query re-reads the index.
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
        // The members are attached by groupRow() in set-detection.js.
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
  #listener;
  #stats = { connections: 0, queries: 0, bytes: 0 };

  constructor({ config, indexer, engine, executor }) {
    this.#config = config;
    this.#indexer = indexer;
    this.#engine = engine;
    this.#executor = executor;
  }

  get engine() {
    return this.#engine;
  }

  get executor() {
    return this.#executor;
  }

  indexSummary() {
    const s = this.#indexer.snapshot;
    return { ready: s.ready, builtAt: s.builtAt, counting: s.counting, sources: s.sources, stats: this.#stats };
  }

  /** The parts of the config that are safe to send over the socket. */
  safeConfig() {
    return {
      search: this.#config.search,
      index: {
        searchRoots: this.#config.index?.searchRoots ?? [],
        plocate: this.#config.index?.plocate ?? {},
        liveWalk: this.#config.index?.liveWalk ?? {},
      },
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
          const conn = socket.__nixcastConn ?? (socket.__nixcastConn = new Connection(socket, this));
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

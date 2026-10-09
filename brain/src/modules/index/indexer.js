/**
 * Index aggregator.
 *
 * Providers are split into a fast group (apps, files, recently-used — all
 * plain filesystem reads) and a slow group (browser history needs a SQLite
 * copy per profile; toggles need to spawn gsettings). The fast group runs
 * once at startup so the launcher is usable immediately, the slow group
 * follows and is refreshed on a timer.
 */

import { createLogger } from '../../common/logger.js';
import { loadApps } from './apps.js';
import { loadFiles } from './files.js';
import { loadRecent } from './recent.js';
import { loadHistory } from './browser-history.js';
import { loadBookmarks } from './bookmarks.js';
import { loadToggles } from './toggles.js';

const log = createLogger('indexer');

export class Indexer {
  #config;
  #listeners = new Set();
  #snapshot;
  #refreshing = null;
  #timer = null;

  constructor(config) {
    this.#config = config;
    this.#snapshot = {
      apps: [],
      files: [],
      recent: [],
      history: [],
      bookmarks: [],
      toggles: [],
      actions: this.#actionRows(),
      sources: [],
      builtAt: 0,
      counting: { apps: 0, files: 0, recent: 0, history: 0, bookmarks: 0 },
      ready: false,
    };
  }

  #actionRows() {
    return (this.#config.actions ?? []).map((action) => ({
      id: `action:${action.id}`,
      kind: 'run_action',
      title: action.title,
      detail: action.description ?? 'Custom action',
      keywords: `${action.keywords ?? ''} action command script`,
      icon_kind: 'named',
      icon: action.icon ?? 'utilities-terminal-symbolic',
      action,
    }));
  }

  get snapshot() {
    return this.#snapshot;
  }

  onUpdate(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.#listeners) {
      try {
        fn(this.#snapshot);
      } catch (err) {
        log.warn('index listener failed', String(err));
      }
    }
  }

  /** Phase one: everything that is a plain file read. */
  refreshFast() {
    const config = this.#config;
    this.#snapshot = {
      ...this.#snapshot,
      apps: loadApps(config),
      files: loadFiles(config),
      recent: loadRecent(config),
      actions: this.#actionRows(),
      builtAt: Date.now(),
    };
    this.#snapshot.counting = {
      ...this.#snapshot.counting,
      apps: this.#snapshot.apps.length,
      files: this.#snapshot.files.length,
      recent: this.#snapshot.recent.length,
    };
    this.#emit();
    return this.#snapshot;
  }

  /** Phase two: history, bookmarks + toggle state. Safe to call repeatedly. */
  refreshSlow() {
    const config = this.#config;
    let history = [];
    let sources = [];
    try {
      const result = loadHistory(config);
      history = result.rows;
      sources = result.sources;
    } catch (err) {
      log.warn('history indexing failed; continuing without it', String(err));
    }

    // Bookmarks ride along with history: same copy-on-read cost, same refresh.
    let bookmarks = [];
    try {
      bookmarks = loadBookmarks(config);
    } catch (err) {
      log.warn('bookmark indexing failed; continuing without it', String(err));
    }

    this.#snapshot = {
      ...this.#snapshot,
      history,
      bookmarks,
      sources,
      builtAt: Date.now(),
      counting: { ...this.#snapshot.counting, history: history.length, bookmarks: bookmarks.length },
      ready: true,
    };
    this.#emit();

    // Toggles are async because each state read spawns a process.
    return loadToggles(config)
      .then((toggles) => {
        // Counted so the startup log says whether toggles made it in — this bug
        // was invisible precisely because nothing reported the count.
        this.#snapshot = { ...this.#snapshot, toggles, counting: { ...this.#snapshot.counting, toggles: toggles.length } };
        this.#emit();
        return this.#snapshot;
      })
      .catch((err) => {
        log.warn('toggle state read failed', String(err));
        return this.#snapshot;
      });
  }

  async refresh() {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      try {
        this.refreshFast();
        return await this.refreshSlow();
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  async start({ awaitFirst = false } = {}) {
    const first = this.refresh();
    if (awaitFirst) await first;

    const interval = Math.max(15_000, this.#config.index.refreshMs ?? 120_000);
    this.#timer = setInterval(() => {
      this.refresh().catch((err) => log.warn('periodic refresh failed', String(err)));
    }, interval);
    if (this.#timer.unref) this.#timer.unref();
    return first;
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** All rows that can be searched, newest-first maintained per provider. */
  allRows() {
    const s = this.#snapshot;
    return [...s.apps, ...s.recent, ...s.files, ...s.toggles, ...s.actions, ...s.bookmarks, ...s.history];
  }
}

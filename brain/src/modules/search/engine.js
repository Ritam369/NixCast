/**
 * Search engine — turns one keystroke into the rows the panel draws.
 *
 * Everything here is local and synchronous on purpose: this file makes no
 * network call at any point. The pipeline is
 *
 *   1. parse a time window out of the phrase
 *   2. fuzzy-prefilter the index
 *   3. if that came up weak, look wider — a live walk of the configured roots,
 *      then plocate's whole-disk database
 *   4. decide confidence and set membership deterministically
 *   5. hand the rows to the UI; only Enter executes anything
 */

import { evaluate, looksLikeMath } from './calculator.js';
import { parseTimeWindow } from './time-window.js';
import { isConfidentMatch, scoreRow, sortByFuzzy } from './fuzzy.js';
import { walkForQuery } from '../index/live-walk.js';
import { searchByName } from '../index/plocate.js';
import { detectSet, groupRow } from './set-detection.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('engine');

const DEFAULT_ROW_LIMIT = 12;

export class SearchEngine {
  #config;
  #indexer;

  constructor({ config, indexer }) {
    this.#config = config;
    this.#indexer = indexer;
  }

  /** Rows shown when nothing has been typed yet. */
  #defaultRows(context) {
    const { apps, recent, toggles, actions } = this.#indexer.snapshot;
    const preferred = ['firefox', 'brave', 'code', 'kitty', 'gnome-terminal', 'nautilus', 'neovim', 'files'];
    const scored = sortByFuzzy(apps, context?.frontmost_app ?? '');
    const appsPick = scored.filter((r) => preferred.some((p) => r.title.toLowerCase().includes(p))).slice(0, 5);
    const base = [...(appsPick.length > 0 ? appsPick : scored.slice(0, 5)), ...recent.slice(0, 4), ...toggles.slice(0, 3), ...actions];
    return base.slice(0, DEFAULT_ROW_LIMIT).map((row) => ({ ...row, fuzzy: 0 }));
  }

  #searchPool(timeWindow) {
    const snap = this.#indexer.snapshot;
    if (!timeWindow) {
      return [...snap.apps, ...snap.recent, ...snap.files, ...snap.bookmarks, ...snap.history, ...snap.toggles, ...snap.actions];
    }

    // With a time window the query is almost always about files or visited
    // pages, so apps and toggles are dropped rather than mixed in.
    const recent = snap.recent.filter((r) => (r.mtime ?? 0) >= timeWindow.since);
    const files = snap.files.filter((r) => (r.mtime ?? 0) >= timeWindow.since);
    const history = snap.history.filter((r) => (r.visitedAt ?? 0) >= timeWindow.since);
    return [...history, ...recent, ...files];
  }

  /**
   * The same file arrives as both a recently-used entry and a directory scan
   * result, and the same URL from two browser profiles. Keep whichever scored
   * higher so the duplicate does not consume a candidate slot.
   */
  #uniqueByTarget() {
    const seen = new Set();
    return ({ row }) => {
      const key = row.path ?? row.url ?? row.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };
  }

  /**
   * Rows from plocate's prebuilt whole-disk database.
   *
   * Gated exactly like the live walk — only when the local index produced no
   * confident match — so a normal keystroke never pays for a lookup, and a
   * whole-disk search never competes with a good local answer. plocate matches
   * names, not contents, and only knows what its database last saw.
   */
  #plocateSearch(query, scored) {
    const { plocate = {} } = this.#config.index ?? {};
    if (plocate.enabled === false) return [];
    if (query.trim().length < (plocate.minQueryLength ?? 3)) return [];

    // Stand down only when the index already has a *confident* match. A merely
    // decent one (0.65, say) used to suppress this lookup — which is how a
    // mediocre history row hid a folder that matches by name exactly.
    const strong = plocate.strongMatch ?? 0.85;
    if (scored.some(({ fuzzy }) => fuzzy >= strong)) return [];

    const known = new Set(scored.map(({ row }) => row.path).filter(Boolean));
    const { rows, stats } = searchByName({ query, config: plocate });
    const fresh = rows.filter((row) => !known.has(row.path));
    if (fresh.length > 0) log.debug(`plocate: ${fresh.length} hit(s) in ${stats.elapsedMs} ms`);
    return fresh;
  }

  /**
   * Rows from an on-demand walk of index.searchRoots.
   *
   * Only runs when the indexed folders produced no confident match, so the
   * common case stays instant and a walk never competes with a good answer.
   */
  #liveWalk(query, scored) {
    const { searchRoots = [], liveWalk = {} } = this.#config.index ?? {};
    if (searchRoots.length === 0 || liveWalk.enabled === false) return [];
    if (query.trim().length < (liveWalk.minQueryLength ?? 3)) return [];

    const strong = liveWalk.strongMatch ?? 0.85;
    if (scored.some(({ fuzzy }) => fuzzy >= strong)) return [];

    const known = new Set(scored.map(({ row }) => row.path).filter(Boolean));
    const { rows, stats } = walkForQuery({ roots: searchRoots, query, config: liveWalk });
    const fresh = rows.filter((row) => !known.has(row.path));

    if (fresh.length > 0) {
      log.debug(
        `live walk: ${fresh.length} hit(s) in ${stats.elapsedMs} ms (dirs=${stats.dirs}, scanned=${stats.scanned}${stats.truncated ? ', truncated' : ''})`
      );
    }
    return fresh;
  }

  /**
   * Small, honest nudges on top of the fuzzy score: a file whose extension
   * the user named should not sit below a web page that merely shares a few
   * letters, and a build artefact should not outrank a real document.
   */
  #localBonus(row, searchText) {
    const tokens = String(searchText).toLowerCase().split(/\s+/).filter(Boolean);
    let bonus = 0;

    if (row.path) {
      const ext = row.path.split('.').pop()?.toLowerCase();
      if (ext && tokens.includes(ext)) bonus += 0.35;
    }
    // "recently used" beats "recently modified": recently-used.xbel records
    // what the user actually opened.
    if (row.id?.startsWith('recent:')) bonus += 0.12;
    if (row.id?.startsWith('url:') && row.visitedAt && Date.now() - row.visitedAt < 86_400_000) bonus += 0.06;
    // A bookmark is a deliberate choice, so it should win a tie against the same
    // URL merely seen in history — otherwise the folder name never surfaces and
    // "open the ChaiCode bookmarks" cannot group them into a set.
    if (row.bookmark) bonus += 0.1;
    // plocate sees every build artefact on the machine, so a name search for
    // "holiday" otherwise surfaces node_modules first. Penalised, not hidden.
    if (row.noisy) bonus -= this.#config.index?.plocate?.noisyPenalty ?? 0.35;
    return bonus;
  }

  /**
   * @returns {{view: object, meta: object}}
   */
  local(text, context = {}) {
    const query = String(text ?? '');
    const timeWindow = parseTimeWindow(query, Date.now());
    const searchText = timeWindow ? timeWindow.strippedQuery : query;

    const isMath = looksLikeMath(searchText || query);
    const mathResult = isMath ? evaluate(searchText || query) : null;

    let poolRows;
    // Held outside the branch so set detection can see the whole scored pool,
    // not only the slice that becomes the visible candidate list.
    let scoredPool = [];
    if (query.trim().length === 0) {
      poolRows = this.#defaultRows(context);
    } else {
      const scored = this.#searchPool(timeWindow)
        .map((row) => ({ row, fuzzy: Math.max(scoreRow(searchText, row), scoreRow(query, row)) }))
        .filter(({ fuzzy }) => fuzzy > 0)
        .map(({ row, fuzzy }) => ({ row, fuzzy: Math.min(1, fuzzy + this.#localBonus(row, searchText)) }));

      // The index covers fixed folders only. If it could not answer this query,
      // look wider: first a live walk of the configured roots (a removable drive,
      // an unindexed tree), then plocate's whole-disk database.
      // Rows from outside the index go through the same scoring as the indexed
      // ones. Without this they bypassed #localBonus entirely — which is how the
      // noisy-path penalty silently did nothing, and how any future ranking
      // adjustment would have missed whole-disk hits too.
      const scoreExternal = (row) => ({
        row,
        fuzzy: Math.min(1, scoreRow(searchText, row) + this.#localBonus(row, searchText)),
      });
      for (const row of this.#liveWalk(searchText, scored)) scored.push(scoreExternal(row));
      for (const row of this.#plocateSearch(searchText, scored)) scored.push(scoreExternal(row));

      scoredPool = scored;
      poolRows = scored
        .sort((a, b) => b.fuzzy - a.fuzzy)
        .filter(this.#uniqueByTarget())
        .slice(0, timeWindow ? this.#config.search.maxCandidatesWithWindow : this.#config.search.maxCandidates)
        .map(({ row, fuzzy }) => ({ ...row, fuzzy }));
    }

    // Display order is pure fuzzy, with the calculator on top when the text is
    // arithmetic.
    const localRows = [...poolRows];
    if (mathResult) {
      localRows.unshift({
        id: 'synthetic:calculate',
        kind: 'calculate',
        title: mathResult.display,
        detail: `Calculated from “${mathResult.expression}” · Enter copies it`,
        keywords: mathResult.expression,
        icon_kind: 'named',
        icon: 'accessories-calculator-symbolic',
        value: mathResult.value,
        fuzzy: 1,
        synthetic: true,
      });
    }

    const syntheticRows = [];
    if (mathResult) syntheticRows.push(localRows[0]);

    if (query.trim().length > 0) {
      const searchRow = {
        id: 'synthetic:web_search',
        kind: 'web_search',
        title: `Search the web for “${query.trim()}”`,
        detail: 'Opens your default browser',
        keywords: query,
        icon_kind: 'named',
        icon: 'system-search-symbolic',
        query: query.trim(),
        fuzzy: 0,
        synthetic: true,
      };
      syntheticRows.push(searchRow);
    }

    // Synthetic rows — the calculator result and the web-search fallback — are
    // ordinary rows of the list, just not part of the index.
    const realRows = poolRows;
    const synthetics = syntheticRows;

    // What a set means, decided from the index rather than asked of a model:
    // a named folder, an explicit "all", or a time window.
    const setInfo = detectSet({ query: searchText, timeWindow, scored: scoredPool });
    const setRow = setInfo.active && setInfo.members.length >= 2 ? groupRow(setInfo) : null;
    const isMember = (row) => Boolean(setInfo.active) && setInfo.members.some((member) => member.id === row.id);

    const displayRows = [
      ...(setRow ? [setRow] : []),
      ...(mathResult ? [synthetics[0]] : []),
      ...realRows,
      ...synthetics.filter((r) => r.kind === 'web_search'),
    ]
      .filter(Boolean)
      .slice(0, this.#config.search.maxRows ?? 7);

    // The green Enter, in code: the top row is confident when every word typed
    // appears in it. A set row is confident by construction, and a calculator
    // result needs no confirmation.
    const topRow = displayRows[0] ?? null;
    const ready = Boolean(topRow && (topRow.isGroup || topRow.kind === 'calculate' || isConfidentMatch(searchText, topRow)));

    return {
      view: {
        rows: displayRows.map((r, index) => ({
          ...r,
          inSet: isMember(r),
          ready: index === 0 ? ready : false,
        })),
        ready,
        set: setInfo.active ? { active: true, size: setInfo.members.length, rule: setInfo.rule } : { active: false },
        phase: 'local',
      },
      meta: { query, timeWindow, mathResult, candidateCount: realRows.length, hasSynthetic: synthetics.length > 0 },
    };
  }
}

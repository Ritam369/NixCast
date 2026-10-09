/**
 * Fuzzy prefilter — a port of the macOS launcher's Fuzzy.swift.
 *
 * Scoring ladder, strongest first: exact, target-prefix, word-prefix,
 * in-order token match, then a compactness-weighted subsequence. Natural
 * language filler ("open", "the", "pages") is stripped before matching so
 * that "open the pdf I just downloaded" behaves like "pdf downloaded".
 */

import { DEFAULT_CONFIG } from '../../common/config.js';

export function normalize(input) {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_\-/.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(input) {
  const norm = normalize(input);
  return norm.length === 0 ? [] : norm.split(' ');
}

export function stripFillers(tokens, fillers = DEFAULT_CONFIG.search.nlFillers) {
  const set = new Set(fillers);
  const kept = tokens.filter((t) => !set.has(t));
  return kept.length > 0 ? kept : tokens;
}

function isSubsequence(needle, haystack) {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

function wordInitials(text) {
  return text
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('');
}

/**
 * Initial matching only means something for a short abbreviation: "pd" for
 * "Plan Details". Applied to a sentence it matches far too much, because
 * eventually every word's first letter lines up with something.
 */
function isAbbreviation(text) {
  return text.replace(/ /g, '').length <= 6;
}

/**
 * Whether a query token and a target word are the same word.
 *
 * Both directions of prefix, plus a naive plural strip: people type "bookmarks"
 * for "bookmark" and "files" for "file" constantly. Without this, a query like
 * "open my ChaiCode bookmarks" matched every bookmark row equally — each one
 * satisfied one token — and the ranking then picked one arbitrarily.
 */
function stem(word) {
  return word.replace(/(es|s)$/, '');
}

function wordsMatch(token, word) {
  // Ordinary prefix: "term" matches "terminal".
  if (word.startsWith(token)) return true;
  if (word === token) return true;
  // Inflection only: "bookmarks" matches "bookmark". Deliberately NOT a reverse
  // prefix, because that made any short word match any longer token — the "d" in
  // "opened 1 d ago" matched the query "dark" and put every recent file above
  // Toggle Dark Mode, and the "b" in "W.B." matched "bluetooth".
  const a = stem(word);
  return a.length > 1 && a === stem(token);
}

/**
 * @returns {number} 0..1 relevance of `haystack` for `query`
 */
export function fuzzyScore(query, haystack) {
  const q = normalize(query);
  const h = normalize(haystack);
  if (q.length === 0) return 0;
  if (h.length === 0) return 0;

  if (q === h) return 1;

  // Penalise long haystacks so "Slack" beats "Slack Builds Toolchain".
  const lengthPenalty = Math.min(0.2, Math.max(0, (h.length - q.length) / 100));

  if (h.startsWith(q)) return 0.95 - lengthPenalty;

  const words = h.split(' ');
  if (words.some((w) => wordsMatch(q, w))) return 0.85 - lengthPenalty;

  const qTokens = stripFillers(tokenize(q));
  const compactQuery = q.replace(/ /g, '');

  // "pd" for "Plan Details": a short query whose letters are the initials of
  // the target's first words. Gated to short queries, because applied to a
  // sentence this matches almost anything.
  if (isAbbreviation(q)) {
    const initials = wordInitials(h);
    if (compactQuery === initials.slice(0, compactQuery.length)) return 0.6 - lengthPenalty;
  }

  // `>= 1`, not `> 1`: filler stripping can leave a single token ("bookmarks
  // files" -> "bookmarks"), and that token deserves the same inflection match.
  if (qTokens.length >= 1) {
    const allWordPrefix = qTokens.every((t) => words.some((w) => wordsMatch(t, w)));
    if (allWordPrefix) return 0.72 - lengthPenalty;
  }

  // Compact subsequence: reward matches whose characters sit close together.
  // Length-gated for the same reason as the initials rule above — a long
  // phrase is a subsequence of far too many strings.
  if (compactQuery.length <= 12 && isSubsequence(compactQuery, h.replace(/ /g, ''))) {
    const span = h.replace(/ /g, '').length;
    const compactness = Math.max(0, 1 - (span - q.replace(/ /g, '').length) / 30);
    return 0.3 + 0.25 * compactness;
  }

  // Last resort: score on how much of the target the query's letters cover.
  const covered = qTokens.filter((t) => words.some((w) => w.includes(t))).length;
  if (covered > 0) return 0.15 + 0.2 * (covered / qTokens.length);

  return 0;
}

/** Best score across a row's title, keywords and detail. */
export function scoreRow(query, row) {
  const parts = [row.title, row.keywords, row.detail].filter(Boolean);
  let best = 0;
  for (const part of parts) best = Math.max(best, fuzzyScore(query, part));
  return best;
}

export function sortByFuzzy(rows, query) {
  return rows
    .map((row) => ({ row, fuzzy: scoreRow(query, row) }))
    .sort((a, b) => b.fuzzy - a.fuzzy)
    .map(({ row, fuzzy }) => ({ ...row, fuzzy }));
}

/**
 * Whether every meaningful word the user typed appears in this row.
 *
 * This is what the green Enter means now that Jev is not asked: not a model's
 * opinion that the intent is settled, but the plain fact that the query's words
 * are all present in the row's name, keywords or subtitle. A prefix counts, so
 * "dar" greens the row once "dark" is its best match — but a query shorter than
 * three characters never does, because that is typing rather than intent.
 */
export function isConfidentMatch(query, row) {
  if (String(query ?? '').replace(/\s/g, '').length < 3) return false;
  const tokens = stripFillers(tokenize(query));
  if (tokens.length === 0) return false;

  const words = [row.title, row.keywords, row.detail]
    .filter(Boolean)
    .flatMap((part) => normalize(part).split(' '))
    .filter(Boolean);

  return tokens.every((token) => words.some((word) => wordsMatch(token, word)));
}

/**
 * Question construction.
 *
 * This mirrors JevQuestions.swift from the macOS launcher: the same single
 * request per keystroke carries five kinds of judgement.
 *
 *   target    Choice over c0..cN plus "none"         — which row the user means
 *   action    Choice over the action kinds           — what to do with it
 *   ready     Noul                                   — is Enter safe to offer
 *   scope     Choice one|all                         — one item or the whole set
 *   match_cN  Noul, one per real candidate           — set membership
 *
 * Code keeps control: Jev only answers questions, `ranker.js` combines the
 * probabilities with the fuzzy score, and `executor.js` is the only thing that
 * touches the system.
 */

export const ACTION_KINDS = [
  'open_app',
  'open_file',
  'open_url',
  'web_search',
  'calculate',
  'system_toggle',
  'run_action',
  'unclear',
];

const ACTION_CRITERIA = {
  open_app: 'Launch an installed application',
  open_file: 'Open a file or folder that exists on disk',
  open_url: 'Open a web page that already exists in history or as a candidate',
  web_search: 'Search the web for the typed text because it names no local thing',
  calculate: 'Evaluate the typed text as arithmetic and copy the result',
  system_toggle: 'Change a system setting such as dark mode, Wi-Fi or Do Not Disturb',
  run_action: 'Run one of the user-configured custom commands',
  unclear: 'The text is too incomplete or ambiguous to act on',
};

export const QUERY_NOTE =
  'Text the user has typed so far into a Spotlight-style launcher on Linux (GNOME). It is often an incomplete prefix or a short natural-language phrase.';

/**
 * Rows the user can see in the list, mapped to the shape Jev reads.
 * Only a short id, kind, title and detail: the launcher's own README sends
 * exactly this and nothing more.
 */
export function buildCandidateState(rows) {
  return rows.map((row) => ({
    id: row.candidateId,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
  }));
}

export function buildEventsState({ query, context, timeWindow, rows, synthetic }) {
  return {
    query,
    query_note: QUERY_NOTE,
    context: {
      frontmost_app: context?.frontmost_app ?? null,
      recent_apps: context?.recent_apps ?? [],
      clipboard_kind: context?.clipboard_kind ?? 'unknown',
      time_of_day: context?.time_of_day ?? null,
      weekday: context?.weekday ?? null,
    },
    time_window: timeWindow ? { label: timeWindow.label, since: new Date(timeWindow.since).toISOString(), until: new Date(timeWindow.until).toISOString() } : null,
    candidates: buildCandidateState(rows),
    synthetic_candidates: synthetic.map((row) => ({ id: row.candidateId, kind: row.kind, title: row.title, detail: row.detail })),
  };
}

/**
 * @param {object} args
 * @param {Array}  args.rows      real candidates, already assigned candidateId
 * @param {Array}  args.synthetic calculator / web-search rows
 * @returns {{questions: object, targetOptions: string[]}}
 */
export function buildQuestions({ rows, synthetic, query = '' }) {
  const realIds = rows.map((r) => r.candidateId);
  const allIds = [...realIds, ...synthetic.map((r) => r.candidateId)];

  const targetCriteria = {};
  for (const row of [...rows, ...synthetic]) {
    targetCriteria[row.candidateId] = `${row.kind} — ${row.title}${row.detail ? ` (${row.detail})` : ''}`;
  }
  targetCriteria.none = 'None of these candidates matches what the user means';

  const questions = {
    target: {
      type: 'choice',
      instructions:
        'Which candidate, if any, does the user most likely mean? Choose "none" when no candidate matches, when the query is an incomplete prefix with several plausible matches, or when the user is asking for something that is not in the list.',
      criteria: targetCriteria,
    },
    action: {
      type: 'choice',
      instructions: 'What should happen if the user presses Enter on the row they mean?',
      criteria: ACTION_CRITERIA,
    },
    ready: {
      type: 'noul',
      instructions:
        'Is the user\'s intent clear enough that pressing Enter would do the right thing? Answer high only when one row is clearly and unambiguously what the user wants; answer low for short prefixes, several equally plausible rows, or when the top row is only a fuzzy guess.',
    },
    scope: {
      type: 'choice',
      instructions:
        'Does the user want a single item, or all of the matching items at once? Phrases like "all", "every", "the links I visited today" or "open all of these" mean all; a single named thing means one.',
      criteria: {
        one: 'Act on exactly one item',
        all: 'Act on every matching item as a set',
      },
    },
  };

  // One yes/no per candidate is what makes "open all of these" work, but it is
  // the most expensive part of the request: up to 30 questions restating what the
  // model can already read in `state`. So they are asked only when the query
  // could plausibly be about a set. A single named thing needs no membership
  // test, and omitting them cuts roughly a fifth of the input tokens — which is
  // most of the inference time.
  if (rows.length >= 2 && wantsSet(query)) {
    for (const row of rows) {
      questions[`match_${row.candidateId}`] = {
        type: 'noul',
        instructions: `Is candidate ${row.candidateId} one of the items the user is asking for? Answer high when it belongs to the requested set, low when it merely shares keywords.`,
      };
    }
  }

  return { questions, targetOptions: [...allIds, 'none'] };
}

/** Deterministic combination of Jev probabilities, fuzzy score and kind. */
export function actionMatchesKind(actionKind, rowKind) {
  if (!actionKind) return 0;
  if (actionKind === rowKind) return 1;
  if (actionKind === 'web_search' && rowKind !== 'open_url') return 0.4;
  if (actionKind === 'unclear') return 0;
  // Opening a file vs an app vs a url are all "open something" actions.
  const opens = new Set(['open_app', 'open_file', 'open_url']);
  if (opens.has(actionKind) && opens.has(rowKind)) return 0.5;
  return 0;
}

/**
 * Words that suggest the user wants a set rather than one item.
 *
 * Filler such as "the" and "my" is deliberately absent: it appears in almost
 * every single-item query, and including it would mean paying for membership
 * questions on every keystroke — precisely the cost this exists to avoid.
 */
const SET_HINTS =
  /\b(all|every|each|both|these|those|them|links?|pages?|bookmarks?|sites?|files?|photos?|images?|videos?|downloads?|tabs?|history|today|tonight|yesterday|tomorrow|week|month|year|hours?|days?|morning|afternoon|evening|last|past|recent)\b/i;

export function wantsSet(query) {
  return SET_HINTS.test(String(query ?? ''));
}

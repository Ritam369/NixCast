/**
 * Time-window parsing — a port of the macOS launcher's TimeWindow.swift.
 *
 * Resolves phrases like "past 24 hours", "yesterday", "this morning" against
 * the local clock, returns the window, and removes the phrase from the query
 * so the remainder can be fuzzy matched.
 *
 * Times are epoch milliseconds throughout.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  a: 1,
  an: 1,
  few: 3,
  couple: 2,
};

const UNITS = [
  { re: 'seconds?|secs?|s', ms: 1000 },
  { re: 'minutes?|mins?|m', ms: MINUTE },
  { re: 'hours?|hrs?|h', ms: HOUR },
  { re: 'days?|d', ms: DAY },
  { re: 'weeks?|w', ms: WEEK },
  { re: 'months?', ms: 30 * DAY },
  { re: 'years?|y', ms: 365 * DAY },
];

const UNIT_PATTERN = UNITS.map((u) => u.re).join('|');

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function unitToMs(unitText) {
  const found = UNITS.find((u) => new RegExp(`^(?:${u.re})$`, 'i').test(unitText));
  return found ? found.ms : null;
}

function parseCount(text) {
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  const word = text.toLowerCase();
  return word in NUMBER_WORDS ? NUMBER_WORDS[word] : null;
}

const PATTERNS = [
  {
    // "in the past 24 hours", "last 3 days", "past 90 minutes"
    re: new RegExp(`\\b(?:in\\s+the\\s+)?(?:past|last|previous)\\s+(\\d+|${Object.keys(NUMBER_WORDS).join('|')})\\s*(${UNIT_PATTERN})\\b`, 'i'),
    resolve: (m, now) => {
      const count = parseCount(m[1]);
      const ms = unitToMs(m[2]);
      if (count === null || ms === null) return null;
      return { since: now - count * ms, label: `past ${count} ${m[2].replace(/s$/, '')}${count === 1 ? '' : 's'}` };
    },
  },
  {
    // "last hour", "this week", "last month"
    re: new RegExp(`\\b(?:last|this|past|current)\\s+(${UNIT_PATTERN})\\b`, 'i'),
    resolve: (m, now) => {
      const ms = unitToMs(m[1]);
      if (ms === null) return null;
      const unit = m[1].toLowerCase().replace(/s$/, '');
      if (/^(week|month|year)/.test(unit)) {
        const d = new Date(now);
        if (unit.startsWith('week')) {
          const day = (d.getDay() + 6) % 7; // Monday-based
          const start = startOfDay(d) - day * DAY;
          return { since: start, label: 'this week' };
        }
        if (unit.startsWith('month')) {
          return { since: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), label: 'this month' };
        }
        return { since: new Date(d.getFullYear(), 0, 1).getTime(), label: 'this year' };
      }
      return { since: now - ms, label: `last ${unit}` };
    },
  },
  {
    re: /\b(?:a\s+few|few|couple\s+of)\s+(days?|hours?|weeks?|minutes?)\s+ago\b/i,
    resolve: (m, now) => {
      const ms = unitToMs(m[1]);
      if (ms === null) return null;
      return { since: now - 3 * ms, label: `past 3 ${m[1].replace(/s$/, '')}s` };
    },
  },
  {
    re: /\b(?:earlier\s+today|today)\b/i,
    resolve: (_m, now) => ({ since: startOfDay(now), label: 'today' }),
  },
  {
    re: /\byesterday\b/i,
    resolve: (_m, now) => {
      const start = startOfDay(now) - DAY;
      return { since: start, label: 'yesterday' };
    },
  },
  {
    re: /\b(?:this|last)\s+(morning|afternoon|evening|night|tonight)\b/i,
    resolve: (m, now) => {
      const d = new Date(now);
      const part = m[1].toLowerCase();
      const startHour = part === 'morning' ? 5 : part === 'afternoon' ? 12 : part === 'evening' || part === 'tonight' ? 17 : 21;
      const isLast = /^last/i.test(m[0]) && now - startOfDay(now) < startHour * HOUR;
      d.setHours(startHour, 0, 0, 0);
      const since = isLast ? d.getTime() - DAY : d.getTime();
      return { since, label: `this ${part}` };
    },
  },
];

/**
 * @returns {{since: number, until: number, label: string, strippedQuery: string} | null}
 */
export function parseTimeWindow(query, now = Date.now()) {
  const text = String(query ?? '');
  if (text.trim().length === 0) return null;

  for (const pattern of PATTERNS) {
    const match = text.match(pattern.re);
    if (!match) continue;
    const resolved = pattern.resolve(match, now);
    if (!resolved) continue;

    const strippedQuery = text.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
    return {
      since: resolved.since,
      until: now,
      label: resolved.label,
      // "links I visited in the past 24 hours" -> "links I visited"
      strippedQuery,
      matched: match[0],
    };
  }

  return null;
}

/** ms -> "2 h ago", used for history-row subtitles. */
export function visitAge(ms, now = Date.now()) {
  const delta = Math.max(0, now - ms);
  if (delta < HOUR) return `${Math.max(1, Math.round(delta / MINUTE))} min ago`;
  if (delta < DAY) return `${Math.round(delta / HOUR)} h ago`;
  const days = Math.round(delta / DAY);
  return `${days} d ago`;
}

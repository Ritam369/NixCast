/**
 * Ranker — a port of the macOS launcher's Ranker.swift.
 *
 *   score = 0.65 * P(target) + 0.20 * P(action matches kind) + 0.15 * fuzzy
 * plus, for members of a set: 0.25 * P(all) * P(match_cN)
 *
 * Every threshold here is hand-tuned in the original too; they live in
 * config.thresholds so they can be moved without touching code.
 */

import { actionMatchesKind } from '../jev/questions.js';

export function rankRows({ rows, synthetic = [], answers, weights, thresholds }) {
  const target = answers?.target;
  const action = answers?.action;
  const readyAnswer = answers?.ready;
  const scopeAnswer = answers?.scope;

  const pAll = scopeAnswer?.probabilities?.all ?? 0;
  const pOne = scopeAnswer?.probabilities?.one ?? 1;

  const scored = [];

  for (const row of [...rows, ...synthetic]) {
    const pTarget = target?.probabilities?.[row.candidateId] ?? 0;
    const pAction = action ? actionMatchesKind(action.choice, row.kind) : 0;
    const fuzzy = row.fuzzy ?? 0;
    const pMatch = answers?.[`match_${row.candidateId}`]?.noul ?? null;

    let score = weights.target * pTarget + weights.action * pAction * (action ? 1 : 0) + weights.fuzzy * fuzzy;
    if (pMatch !== null) score += weights.setMember * pAll * pMatch;

    scored.push({
      ...row,
      score,
      pTarget,
      pMatch,
      isSynthetic: synthetic.includes(row),
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // Which rows count as members of a requested set?
  const members = scored.filter(
    (r) => !r.isSynthetic && r.pMatch !== null && r.pMatch >= thresholds.matchMember && r.kind !== 'system_toggle'
  );
  const setCapped = members.slice(0, thresholds.maxSetSize);
  const hasSet = setCapped.length >= thresholds.minSetSize && pAll >= thresholds.tornAll;

  const best = scored[0];
  const readyProb = readyAnswer?.noul ?? 0;

  // The green Enter is offered when Jev says the intent is settled, or when a
  // single target is overwhelming (the macOS version uses the same two rules).
  let ready = readyProb >= thresholds.ready;
  if (!ready && best && best.pTarget >= thresholds.readyDirectTarget) ready = true;
  if (hasSet) ready = ready && pAll >= thresholds.readyAll;

  const topIsMember = hasSet && best && setCapped.some((m) => m.id === best.id);

  return {
    rows: scored,
    members: setCapped,
    set: {
      active: hasSet,
      size: setCapped.length,
      pAll,
      pOne,
      // Placement rules from the original: offer the group row first when the
      // model is confident, just below the best single hit when it is torn,
      // and not at all when pAll is negligible.
      placement: pAll >= thresholds.offerAll ? 'top' : pAll >= thresholds.tornAll ? 'after-top' : 'hidden',
      ready: pAll >= thresholds.readyAll,
      topIsMember,
    },
    ready,
    readyProb,
    action: action?.choice ?? null,
    targetId: target?.choice ?? 'none',
    pTarget: target?.probabilities ?? {},
    model: action?.confidence ?? null,
  };
}

/** Rows re-ordered for display: set members, then everything by score. */
export function orderForDisplay({ ranked, maxRows }) {
  const out = [];
  const set = ranked.set;

  if (set.active) {
    const members = ranked.members;
    const groupRow = {
      id: '__set__',
      // The members decide the action, not the model's `action` answer: a set of
      // page visits has to execute as open_url even when the model hedged.
      kind: members[0]?.kind ?? 'open_url',
      title: `Open all ${set.size} ${set.size === 1 ? 'item' : 'items'}`,
      detail: set.ready ? 'Press Enter to open the whole set' : 'Still deciding — press Enter to open them all',
      icon_kind: 'named',
      icon: 'view-list-symbolic',
      isGroup: true,
      ready: set.ready,
      score: 1,
      // The executor resolves a group by id and needs the real rows. Without
      // this the panel offered "Open all 7 items" with a green ↵ and then failed
      // with "set is empty", because server.js reads row.members ?? [].
      members,
    };
    if (set.placement === 'top') out.push(groupRow);
    else if (set.placement === 'after-top' && ranked.rows.length > 0) out.push(ranked.rows[0]), out.push(groupRow);
  }

  for (const row of ranked.rows) {
    if (row.isSynthetic && row.kind !== 'calculate' && row.kind !== 'web_search') continue;
    if (out.length >= maxRows) break;
    out.push({
      ...row,
      inSet: ranked.set.active && ranked.members.some((m) => m.id === row.id),
      inSetCheck: ranked.set.active && ranked.members.some((m) => m.id === row.id),
    });
  }

  return out;
}

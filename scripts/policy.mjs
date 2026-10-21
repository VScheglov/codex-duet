// The stopping policy for codex-duet negotiations.
//
// duet.mjs calls decideNextStep() after each Codex reply and follows its decision:
//   continue — Claude responds to open issues, followed by another round;
//   done     — negotiations are complete, and Claude presents the result;
//   escalate — stop: Claude brings the owner the `issues` with both sides' positions.
//
// Safeguards in duet.mjs (no need to repeat them here):
//   • continue on the last round (round >= maxRounds) becomes escalate;
//   • continue with no open issues becomes done (or escalate if there are parked issues);
//   • an exception or malformed result here becomes escalate with the error text.

export const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

const MAX_DISPUTES = 2; // This many rejected disputes on one issue mean a deadlock.
const STALL_ROUNDS = 2; // This many rounds without fewer open issues mean a stall.

const isBlocking = (issue) => SEVERITY_RANK[issue.severity] >= SEVERITY_RANK.high;
const ids = (issues) => issues.map((issue) => issue.id);

/**
 * @typedef {object} Issue
 * @property {string} id               C1, C2, …
 * @property {'critical'|'high'|'medium'|'low'} severity
 * @property {string} title
 * @property {number} disputes         How often Claude disputed an issue and Codex still left it open.
 * @property {null|'fixed'|'disputed'|'needs-user'|'owner-decided'} lastAction  Claude's last response.
 * @property {number} openedRound      The round in which Codex raised the issue.
 *
 * @param {object} view
 * @param {number} view.round          The Codex round just completed (starting at 1).
 * @param {number} view.maxRounds
 * @param {'approve'|'revise'} view.verdict  Codex's overall verdict for this round.
 * @param {Issue[]} view.open          Open issues Claude must answer (most severe first).
 * @param {Issue[]} view.parked        Issues parked for the owner (Claude answered needs-user).
 * @param {Issue[]} view.closedThisRound  Issues closed this round (resolved or withdrawn).
 * @param {{round: number, open: number}[]} view.history  The number of open issues after each round.
 * @returns {{action: 'continue'|'done'|'escalate', reason: string, issues?: string[]}}
 *          issues — Which issues to show the owner on escalation (all open and parked by default).
 */
export function decideNextStep({ verdict, open, parked, history }) {
  // 1. Ask the owner for important decisions before Claude polishes the rest.
  const urgent = parked.filter(isBlocking);
  if (urgent.length) return { action: 'escalate', reason: 'critical/high decision parked: owner input needed', issues: ids(urgent) };

  // 2. The reviewer approves and no blockers remain: report medium/low issues and escalate parked ones.
  if (verdict === 'approve' && !open.some(isBlocking)) {
    if (parked.length) return { action: 'escalate', reason: 'reviewer approved; owner decisions remain', issues: ids(parked) };
    return { action: 'done', reason: `reviewer approved; no open critical/high issues${open.length ? `; report: ${ids(open).join(', ')}` : ''}` };
  }

  // 3. Deadlock: Codex rejected Claude's disputes MAX_DISPUTES times.
  const deadlocked = open.filter((i) => i.disputes >= MAX_DISPUTES);
  if (deadlocked.length) return { action: 'escalate', reason: `deadlock: reviewer rejected the author's disputes ${MAX_DISPUTES} times`, issues: ids(deadlocked) };

  // 4. Stall: the open issue count has not fallen for STALL_ROUNDS consecutive rounds.
  const recent = history.slice(-(STALL_ROUNDS + 1)).map((h) => h.open);
  const stalled = open.length > 0 && recent.length > STALL_ROUNDS && recent.every((n, k) => k === 0 || n >= recent[k - 1]);
  if (stalled) return { action: 'escalate', reason: `stall: open issue count has not fallen for ${STALL_ROUNDS} consecutive rounds`, issues: ids(open) };

  return { action: 'continue', reason: `open: ${open.length}, including critical/high: ${open.filter(isBlocking).length}` };
}

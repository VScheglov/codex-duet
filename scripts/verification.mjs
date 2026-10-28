// Verification is information for the owner, separate from the stop policy.
import fs from 'node:fs';
import { createInterface } from 'node:readline';

export function verificationClaims(raw) {
  // Older replies have only a free-text tests claim, or no verification fields at all.
  if (!Object.hasOwn(raw, 'checks')) return {};
  const checks = [];
  const gaps = [];
  if (Array.isArray(raw.checks)) {
    for (const check of raw.checks) {
      if (check && typeof check.command === 'string' && check.command.trim()
        && ['passed', 'failed', 'skipped'].includes(check.outcome) && typeof check.note === 'string') {
        checks.push({ command: check.command, outcome: check.outcome, note: check.note.trim() });
      }
    }
    const dropped = raw.checks.length - checks.length;
    if (dropped) gaps.push(`(${dropped} malformed check${dropped === 1 ? '' : 's'} dropped)`);
  } else gaps.push('(malformed checks ignored: expected an array)');
  if (Array.isArray(raw.gaps)) {
    gaps.push(...raw.gaps.filter((gap) => typeof gap === 'string').map((gap) => gap.trim()).filter(Boolean));
    const dropped = raw.gaps.filter((gap) => typeof gap !== 'string').length;
    if (dropped) gaps.push(`(${dropped} malformed gap${dropped === 1 ? '' : 's'} dropped)`);
  } else if (raw.gaps !== undefined) {
    gaps.push('(malformed gaps ignored: expected an array)');
  }
  return { checks, gaps };
}

// Decode one shell word without evaluating it. Codex wraps commands in /bin/zsh -lc '…'
// (also bash/sh, with or without a path); embedded quotes use shell escaping/concatenation.
function unwrapCommand(raw) {
  const command = raw.trim();
  const wrapped = /^(?:\/\S*\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/.exec(command);
  if (!wrapped) return command;
  let quote = '';
  let decoded = '';
  const word = wrapped[1];
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i];
    if (c === '\\' && quote !== "'") {
      const next = word[i + 1];
      if (next === undefined) return command;
      if (!quote || '\\"$`\n'.includes(next)) {
        if (next !== '\n') decoded += next;
        i += 1;
      } else decoded += c;
    } else if (c === quote) quote = '';
    else if (!quote && (c === "'" || c === '"')) quote = c;
    else if (!quote && /[\s;&|<>]/.test(c)) return command; // more than one shell word
    else decoded += c;
  }
  return quote ? command : decoded.trim();
}

const oneLine = (command) => command.replace(/\s+/g, ' ').trim();

// A shell reading its script from a here-document runs the body as commands, so the body's own
// masking (`|| true`, a later echo) decides the exit; any other program reads the body as data.
const SHELL = /^(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|mksh|fish)$/;

// Split only top-level shell operators, not quoted arguments or substitutions. Unsupported
// syntax keeps an exact-match key, but cannot prove a verification's outcome. A here-document
// body (`python3 - <<'PY' … PY`) stays verbatim in its segment, so only the same script
// matches, and its lines are never read as shell.
function commandParts(raw) {
  const command = unwrapCommand(raw);
  const segments = [];
  const operators = [];
  const opaque = () => ({ key: command.replace(/[^\S\n]+/g, ' ').trim(), segments: [], operators: [], unsupported: true });
  let quote = '';
  let depth = 0;
  let start = 0;
  let simple = true;
  let unsupported = false;
  let heredocs = []; // here-documents opened on the current line; their bodies follow its newline
  const addSegment = (end) => {
    const text = oneLine(command.slice(start, end));
    if (text) segments.push({ command: text, simple });
    simple = true;
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === '\\' && quote !== "'") { i += 1; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if ((c === '#' && (i === 0 || /\s/.test(command[i - 1]))) || command.startsWith("$'", i)) return opaque();
    if (command.startsWith('<<<', i)) { simple = false; i += 2; continue; } // a here-string: one word of data
    if (command.startsWith('<<', i)) {
      const doc = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\?)([^\s;&|<>()'"`]+))/.exec(command.slice(i));
      if (!doc || depth) return opaque();
      heredocs.push({ delimiter: doc[2] ?? doc[3] ?? doc[5], tabs: doc[1] === '-', quoted: doc[5] === undefined || doc[4] === '\\' });
      simple = false;
      i += doc[0].length - 1;
      continue;
    }
    if (c === '\n' && heredocs.length && !depth) {
      // The bodies come in the order they were opened, each up to a line holding only its delimiter.
      const head = oneLine(command.slice(start, i));
      let pos = i + 1;
      for (const doc of heredocs) {
        for (;;) {
          if (pos > command.length) return opaque();
          const end = command.indexOf('\n', pos);
          const line = command.slice(pos, end === -1 ? command.length : end);
          pos = end === -1 ? command.length + 1 : end + 1;
          if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
          if (end === -1) return opaque(); // the delimiter never comes
          // an unquoted body still runs $(…) and `…` in the outer shell, out of the exit's sight
          if (!doc.quoted && /\$\(|`/.test(line)) unsupported = true;
        }
      }
      if (SHELL.test(head.replace(/^(?:[A-Za-z_]\w*=\S*\s+)*/, '').split(' ')[0])) unsupported = true;
      segments.push({ command: `${head}\n${command.slice(i + 1, pos - 1)}`, simple: false });
      simple = true;
      heredocs = [];
      // the newline after the last delimiter separates commands like any other
      if (command.slice(pos).trim()) operators.push('\n');
      start = pos;
      i = pos - 1;
      continue;
    }
    if (c === '(' || c === '{') { depth += 1; simple = false; unsupported = true; continue; }
    if (c === ')' || c === '}') { if (!depth) return opaque(); depth -= 1; continue; }
    if (depth) continue;
    const op = ['&&', '||'].find((value) => command.startsWith(value, i))
      ?? ([';', '|', '\n'].includes(c) ? c : null);
    if (op) {
      addSegment(i);
      operators.push(op);
      i += op.length - 1;
      start = i + 1;
    } else if ('<>&'.includes(c)) {
      simple = false; // redirects/backgrounding are not extra arguments
      // Descriptor duplication (2>&1) and &> redirects preserve the program's
      // exit. A background list's exit can instead come from another command.
      if (c === '&' && !['<', '>'].includes(command[i - 1]) && command[i + 1] !== '>') unsupported = true;
    }
  }
  if (quote || depth || heredocs.length) return opaque();
  addSegment(command.length);
  return { key: JSON.stringify([segments.map((s) => s.command), operators]), segments, operators, unsupported };
}

// An event reports the whole shell command's exit, not each segment's. Only use it
// for a segment when that segment's outcome follows from the operators and exit.
function segmentExitKnown(event, index) {
  const { segments, operators, exit_code } = event;
  if (segments.length === 1 && !operators.length) return true;
  if (exit_code === null || operators.length !== segments.length - 1) return false;
  // Backgrounding, grouping and redirects are not represented by the operator
  // list alone, so do not infer a component's outcome from those compound events.
  if (segments.some((part) => !part.simple)) return false;
  if (!operators.every((op) => ['&&', ';', '\n'].includes(op))) return false;
  // A successful AND chain proves every component passed. A failing one does
  // not identify the failed component, or show whether later components ran.
  if (exit_code === 0 && operators.every((op) => op === '&&')) return true;
  if (index !== segments.length - 1) return false;
  // The last command in a sequence supplies its exit. With an AND before it,
  // only success proves it actually ran; failure may have stopped the chain.
  return exit_code === 0 || operators.every((op) => op === ';' || op === '\n');
}

function matchingCommands(claim, commands) {
  const exact = commands.findLast((event) => event.key === claim.key);
  if (exact) return [exact];
  if (claim.segments.length === 1) {
    const command = claim.segments[0].command;
    const matches = (part) => part.command === command || (part.simple && part.command.startsWith(`${command} `));
    const segment = commands.findLast((event) => event.segments.some(matches));
    // Keep the latest segment attempt; an ambiguous exit cannot revive an older success.
    return segment && segment.segments.some((part, index) => matches(part) && segmentExitKnown(segment, index)) ? [segment] : [];
  }
  // A single short event cannot stand for a compound claim. Every component needs its
  // own exact event, in order; repeated components cannot reuse the same event.
  if (!claim.segments.length) return [];
  const matches = [];
  let before = commands.length;
  for (const part of [...claim.segments].reverse()) {
    let index = before - 1;
    while (index >= 0 && !(commands[index].segments.length === 1 && !commands[index].operators.length
      && commands[index].segments[0].command === part.command)) index -= 1;
    if (index < 0) return [];
    matches.unshift(commands[index]);
    before = index;
  }
  return matches;
}

function succeeded(claim, events) {
  if (!events.length || events.some((event) => event.exit_code === null)) return null;
  const { segments, operators, unsupported } = claim;
  if (unsupported || !segments.length || operators.length !== segments.length - 1
    || !operators.every((op) => ['&&', ';', '\n'].includes(op))) return null;
  // A matching command is not necessarily evidence that its checks passed:
  // tail, || true, and later commands can hide verification failures.
  if (!operators.length) return events[0].exit_code === 0;
  if (events.length === 1 && events[0].key === claim.key) {
    if (events[0].exit_code !== 0) return false;
    return operators.every((op) => op === '&&') ? true : null;
  }
  // Every component of an AND claim has its own exact event. A sequence's
  // final success still cannot prove the verification passed without masking.
  if (operators.every((op) => op === '&&')) return events.every((event) => event.exit_code === 0);
  if (operators.every((op) => op === ';' || op === '\n')) return events.at(-1).exit_code !== 0 ? false : null;
  return null;
}

const eventEvidence = ({ command, exit_code, status }) => ({ command, exit_code, status });

async function completedCommands(file) {
  const commands = [];
  const lines = createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const item = event?.item;
      if (event?.type !== 'item.completed' || item?.type !== 'command_execution'
        || typeof item.command !== 'string' || !item.command.trim()) continue;
      commands.push({
        command: unwrapCommand(item.command),
        ...commandParts(item.command),
        exit_code: Number.isInteger(item.exit_code) ? item.exit_code : null,
        status: typeof item.status === 'string' ? item.status : null,
      });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return commands;
}

export const unknownVerification = () => ({ label: 'unknown', checks: [], gaps: [] });

export async function confirmVerification(reply, file) {
  if (!Array.isArray(reply.checks)) return unknownVerification();
  const commands = reply.checks.length ? await completedCommands(file) : [];
  const checks = reply.checks.map((check) => {
    if (check.outcome === 'skipped') return { ...check, confirmation: 'skipped' };
    const claim = commandParts(check.command);
    const events = matchingCommands(claim, commands);
    const success = succeeded(claim, events);
    let confirmation = 'unconfirmed';
    if (success !== null) confirmation = success === (check.outcome === 'passed') ? 'confirmed' : 'contradicted';
    return {
      ...check,
      confirmation,
      ...(events.length === 1 ? { event: eventEvidence(events[0]) }
        : events.length ? { events: events.map(eventEvidence) } : {}),
    };
  });
  const gaps = reply.gaps ?? [];
  const confirmed = checks.filter((c) => c.confirmation === 'confirmed').length;
  const label = !confirmed ? 'static-analysis-only'
    : confirmed === checks.length && !gaps.length ? 'executed' : 'partial';
  return { label, checks, gaps };
}

export function verificationLines(receipt, heading = 'Verification', legacyTests = '') {
  const { label, checks, gaps } = receipt ?? unknownVerification();
  const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();
  const lines = [`${heading}: ${label}`, ''];
  if (label === 'unknown') {
    lines.push(legacyTests ? `- Legacy Tests claim (unconfirmed): ${oneLine(legacyTests)}` : '- Checks not reported.');
  } else if (!checks.length) lines.push('- No verification checks reported.');
  for (const check of checks) {
    const evidence = (check.event ? [check.event] : check.events ?? []).map((event) =>
      `; ${check.events ? `${oneLine(event.command)}: ` : ''}exit ${event.exit_code ?? 'unknown'}${event.status ? `; ${event.status}` : ''}`).join('');
    const confirmation = check.outcome === 'skipped' ? '' : ` [${check.confirmation}${evidence}]`;
    lines.push(`- ${check.outcome}${confirmation}: ${oneLine(check.command)}${check.note ? ` — ${oneLine(check.note)}` : ''}`);
  }
  lines.push(...gaps.map((gap) => `- Gap: ${oneLine(gap)}`));
  return lines;
}

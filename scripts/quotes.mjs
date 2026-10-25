// Quote checks read only the reviewed tree objects or the round's saved document copies.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function needlesFor(quote) {
  const lines = [...new Set(quote.split('\n').map((line) => line.trim()).filter((line) => line.length >= 12))];
  return lines.length ? lines.sort((a, b) => b.length - a.length).slice(0, 3)
    : quote.trim().length >= 6 ? [quote.trim()] : [];
}

const variants = (needle) => /^[+\- ]/.test(needle) ? [needle, needle.slice(1).trim()] : [needle];
const content = (text) => text.includes('\0') ? { binary: true } : { text };

// Also handles the short-quote fallback spanning multiple lines. Lines are 1-based.
function hitLines(text, needle) {
  const hits = [];
  let from = 0;
  let line = 1;
  for (let hit = text.indexOf(needle, from); hit !== -1; hit = text.indexOf(needle, from)) {
    for (let i = from; i < hit; i += 1) if (text[i] === '\n') line += 1;
    hits.push(line);
    from = hit + 1;
    if (text[hit] === '\n') line += 1;
  }
  return hits;
}

function quoteSource(st, snapshot) {
  const cache = new Map();
  const cached = (file, read) => {
    if (!cache.has(file)) {
      try { cache.set(file, read()); } catch { cache.set(file, {}); }
    }
    return cache.get(file);
  };
  if (['code', 'build'].includes(st.kind)) {
    const tree = snapshot?.tree;
    if (!/^[\da-f]{40,64}$/.test(tree ?? '')) return null;
    const cwd = st.kind === 'build' && !fs.existsSync(st.cwd) ? st.subject.repo : st.cwd;
    const git = (args) => {
      try { return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }); }
      catch { return { status: null, stdout: '' }; }
    };
    const searches = new Map();
    return {
      resolve(file) {
        if (!file || path.isAbsolute(file) || file.includes('\0')) return null;
        const normalized = path.posix.normalize(file);
        return normalized === '.' || normalized === '..' || normalized.startsWith('../') ? null : normalized;
      },
      label: (file) => file,
      read: (file) => cached(file, () => {
        const type = git(['cat-file', '-t', `${tree}:${file}`]);
        if (type.status !== 0 || type.error || type.stdout.trim() !== 'blob') return {};
        const r = git(['show', '--no-ext-diff', '--no-textconv', `${tree}:${file}`]);
        return r.status === 0 && !r.error ? content(r.stdout) : {};
      }),
      others(needle) {
        if (!searches.has(needle)) {
          const r = git(['grep', '--no-color', '--no-textconv', '--full-name', '-F', '-n', '-I', '-z', '-e', needle, tree, '--']);
          let files = null;
          if (!r.error && [0, 1].includes(r.status)) {
            files = new Set();
            // -z separates filename, line number and content. A filename can itself contain a newline.
            for (let start = 0; start < r.stdout.length;) {
              const nameEnd = r.stdout.indexOf('\0', start);
              const lineEnd = r.stdout.indexOf('\0', nameEnd + 1);
              if (nameEnd < 0 || lineEnd < 0) { files = null; break; }
              files.add(r.stdout.slice(start, nameEnd).slice(tree.length + 1));
              const end = r.stdout.indexOf('\n', lineEnd + 1);
              start = end < 0 ? r.stdout.length : end + 1;
            }
          }
          searches.set(needle, files ? [...files] : null);
        }
        return searches.get(needle);
      },
    };
  }
  if (!Array.isArray(snapshot?.docs)) return null;
  const docs = snapshot.docs;
  return {
    resolve(file) {
      if (!file) return docs.length === 1 ? docs[0].path : null;
      if (file.includes('\0')) return null;
      const absolute = path.resolve(st.cwd, file);
      return docs.find((d) => file === d.listed || absolute === d.path
        || (d.listed && d.listed !== '-' && absolute === path.resolve(st.cwd, d.listed)))?.path ?? null;
    },
    label: (file) => {
      const d = docs.find((d) => d.path === file);
      return d?.listed && d.listed !== '-' ? d.listed : file;
    },
    read: (file) => cached(file, () => {
      const d = docs.find((d) => d.path === file);
      return d?.exists && d.snap ? content(fs.readFileSync(d.snap, 'utf8')) : {};
    }),
    others: () => docs.filter((d) => d.exists).map((d) => d.path),
  };
}

function checkQuote(source, file, needles, line) {
  if (!source || !file || !needles.length) return 'unchecked';
  const body = source.read(file);
  if (body.text == null) return 'unchecked';
  const hits = [];
  for (const needle of needles) {
    for (const variant of variants(needle)) {
      const found = hitLines(body.text, variant);
      if (found.length) { hits.push(...found); break; }
    }
  }
  if (hits.length) return line === 0 || hits.some((hit) => Math.abs(hit - line) <= 3) ? 'ok' : `moved:${hits[0]}`;
  let unreadable = false;
  for (const needle of needles) {
    for (const variant of variants(needle)) {
      const others = source.others(variant);
      if (!others) { unreadable = true; continue; }
      for (const other of others) {
        if (other === file) continue;
        const body = source.read(other);
        if (body.binary) continue;
        if (body.text == null) { unreadable = true; continue; }
        // git grep treats a multiline needle as alternative patterns; verify the whole fallback quote.
        if (body.text.includes(variant)) return `other_file:${source.label(other)}`;
      }
    }
  }
  return unreadable ? 'unchecked' : 'MISSING';
}

// A repeated citation describes the snapshot where it was raised, even after the author fixes the line.
export function recitesQuote(issue, previous) {
  return issue.status === 'open' && Boolean(issue.quote.trim())
    && (!previous || issue.quote !== (previous.quote ?? '') || issue.path !== (previous.path ?? ''));
}

// Mutate only the reply's evidence. Neither issue status nor the stop policy depends on these marks.
export function checkQuotes(st, reply, snapshot, round) {
  let source;
  const checks = {};
  for (const issue of reply.issues) {
    const previous = st.issues[issue.id];
    const recited = recitesQuote(issue, previous);
    if (previous && !recited) {
      issue.quoteCheck = previous.quoteCheck ?? { mark: 'unchecked', round, path: previous.path ?? '' };
    } else {
      if (recited) source ??= quoteSource(st, snapshot);
      const file = recited ? source?.resolve(issue.path) : null;
      issue.quoteCheck = {
        mark: recited ? checkQuote(source, file, needlesFor(issue.quote), issue.line) : 'unchecked',
        round,
        path: file ? source.label(file) : issue.path,
        ...(snapshot?.tree ? { tree: snapshot.tree } : {}),
      };
    }
    checks[issue.id] = issue.quoteCheck;
  }
  return checks;
}

export function quoteCheckLine(issue, { includeOk = false, includeUnchecked = false } = {}) {
  const check = issue.quoteCheck;
  const mark = check?.mark ?? 'unchecked';
  if ((mark === 'ok' && !includeOk) || (mark === 'unchecked' && !includeUnchecked)) return '';
  const file = check?.path || issue.path;
  const at = check?.tree ? ` at snapshot ${check.tree.slice(0, 10)}` : check?.round ? ` at snapshot r${check.round}` : '';
  const detail = mark === 'MISSING' ? `not found${file ? ` in ${file}` : ''}`
    : mark.startsWith('moved:') ? `moved to line ${mark.slice(6)}${file ? ` in ${file}` : ''}`
      : mark.startsWith('other_file:') ? `found in ${mark.slice(11)}${file ? ` instead of ${file}` : ''}`
        : file || '';
  const context = `${detail}${at}`.trim();
  return `Quote check: ${mark}${context ? ` — ${context}` : ''}`;
}

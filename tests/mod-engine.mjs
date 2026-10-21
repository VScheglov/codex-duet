// A stand-in engine for hooks/register.tsx: the real module, transpiled, runs its hooks as written; only $ is
// faked. $.fs reads the real disk, so the sessions a test makes with scripts/duet.mjs are what the mod sees.
// The idea comes from plan-progress (github.com/zycck/claude-mods, tests/engine.mjs).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) });

export const BELOW = { type: 'Below', props: {}, children: [] }; // what other mods drew: must survive ours

// esbuild (the one tsx carries will do) or TypeScript; neither type-checks, both strip types and JSX.
function transpiler() {
  const require = createRequire(import.meta.url);
  const esbuilds = [process.env.ESBUILD, 'esbuild'];
  try {
    esbuilds.push(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'tsx', 'node_modules', 'esbuild'));
  } catch {}
  for (const name of esbuilds.filter(Boolean)) {
    try {
      const esbuild = require(name);
      return (code) => esbuild.transformSync(code, { loader: 'tsx', jsxFactory: 'h', format: 'esm', target: 'es2022' }).code;
    } catch {}
  }
  for (const name of [process.env.TYPESCRIPT, 'typescript'].filter(Boolean)) {
    try {
      const ts = require(name);
      const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h' };
      return (code) => ts.transpileModule(code, { compilerOptions }).outputText;
    } catch {}
  }
  throw new Error('the mod tests need esbuild or typescript: install tsx (npm i -g tsx) or point ESBUILD/TYPESCRIPT at the package');
}

// Writes the module's static import graph and a stub of the engine's library into dir. Imports are found
// after transpilation, so type-only imports need no runtime files. Both transpilers use the same path.
export function compile(source, dir) {
  const transpile = transpiler();
  const compiled = new Map();
  const visit = (file) => {
    file = path.resolve(file);
    if (compiled.has(file)) return compiled.get(file);
    const output = path.join(dir, compiled.size ? `module-${compiled.size}.mjs` : 'register.mjs');
    compiled.set(file, output);
    const js = transpile(fs.readFileSync(file, 'utf8')).replace(
      /(\bfrom\s*|\bimport\s*)(['"])([^'"\n]+)\2/g,
      (match, prefix, quote, specifier) => {
        if (specifier === 'claude-code') return `${prefix}${quote}./claude-code.mjs${quote}`;
        if (!specifier.startsWith('.')) return match;
        const dependency = visit(path.resolve(path.dirname(file), specifier));
        return `${prefix}${quote}./${path.basename(dependency)}${quote}`;
      },
    );
    fs.writeFileSync(output, js);
    return output;
  };
  fs.writeFileSync(path.join(dir, 'claude-code.mjs'), [
    'export const atom = (ref, initial) => ({ ref, initial });',
    'export const read = async ($, a) => $.__get(a);',
    'export const update = async ($, a, fn) => $.__update(a, fn);',
  ].join('\n'));
  return visit(source);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

function entry(dir, d) {
  const full = path.join(dir, d.name);
  const kind = d.isSymbolicLink() ? 'other' : d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other';
  const st = kind === 'file' ? fs.statSync(full) : null;
  // as the engine spells it: size and time for a regular file only, 0 for a directory
  return { name: d.name, kind, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0, isLink: d.isSymbolicLink() };
}

// root: where the plugin is installed, as $.plugin.root tells the module; the test's checkout by default
export async function boot(file, { env, cwd, options = {}, defaultsResult = { exitCode: 1, stdout: '', stderr: '' }, sessionId = 'claude-me', root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }) {
  // a fresh module instance per boot, so its module-level state starts empty, as after a reload
  const mod = await import(`${pathToFileURL(file).href}?n=${Math.random()}`);
  const hooks = [];
  mod.register((event, a, b) => hooks.push(b ? { event, matcher: a, fn: b } : { event, matcher: null, fn: a }), options);

  const atoms = new Map();
  const stored = new Map();
  const timers = [];
  // sounds: an afplay'd file by its name, an engine-played clip by its asset path
  const seen = { toasts: [], sounds: [], statuses: [], opened: [], suggested: [], submitted: [], procs: [] };
  // files the test decides exist or not, whatever the disk says (the Claude app's sounds)
  const fakeFiles = new Map();
  let afplayExit = 0;
  let sessionCwd = cwd;
  const $ = {
    __get(a) {
      return atoms.has(a.ref.key) ? atoms.get(a.ref.key) : a.initial;
    },
    __update(a, fn) {
      const value = fn(this.__get(a));
      atoms.set(a.ref.key, value);
      return value;
    },
    plugin: { name: 'codex-duet', root },
    env: { get: async (name) => env[name] },
    // the id the runner records as a review's owner, from the CLAUDE_CODE_SESSION_ID of its Bash call
    session: { cwd: async () => sessionCwd, id: async () => sessionId },
    clock: {
      now: async () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      every: (ms, fn) => {
        const t = { ms, fn, isOn: true };
        timers.push(t);
        return () => { t.isOn = false; };
      },
    },
    fs: {
      list: async (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((d) => entry(dir, d)),
      stat: async (p) => {
        if (fakeFiles.has(p)) {
          if (!fakeFiles.get(p)) throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
          return { kind: 'file', size: 1, mtimeMs: 1, isLink: false };
        }
        const st = fs.statSync(p);
        return { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size, mtimeMs: st.mtimeMs, isLink: false };
      },
      read: async (p) => {
        if (fs.statSync(p).size > 4_194_304) throw new Error(`${p}: over 4 MiB`); // as the engine refuses
        return fs.readFileSync(p, 'utf8');
      },
      write: async (p, text) => fs.writeFileSync(p, text),
    },
    // kill -0 asks whether a pid lives; other signals are only recorded, never sent; afplay plays nothing
    process: {
      run: async (argv) => {
        seen.procs.push(argv.join(' '));
        if (argv[0] === 'defaults') {
          if (defaultsResult instanceof Error) throw defaultsResult;
          return defaultsResult;
        }
        if (['tail', 'head', 'grep'].includes(argv[0])) { // how the mod reads a stream past $.fs.read's 4 MiB: for real
          const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
          return { exitCode: r.status ?? 1, stdout: r.stdout.slice(0, 4_194_304), stderr: r.stderr };
        }
        if (argv[0] === 'afplay') {
          if (afplayExit === 0) seen.sounds.push(path.basename(argv[1]));
          return { exitCode: afplayExit, stdout: '', stderr: afplayExit ? 'afplay: cannot play' : '' };
        }
        let isAlive = false;
        if (argv[0] === 'kill') {
          try {
            process.kill(Number(argv.at(-1)), 0);
            isAlive = true;
          } catch {}
        }
        return { exitCode: argv[0] !== 'kill' || isAlive ? 0 : 1, stdout: '', stderr: '' };
      },
    },
    store: { get: async (key) => stored.get(key), set: async (key, value) => void stored.set(key, value) },
    command: { register: async () => {} },
    audio: { play: async (clip) => void seen.sounds.push(clip.asset) },
    prompt: {
      suggest: async ({ text }) => void seen.suggested.push(text),
      submit: async ({ text }) => void seen.submitted.push(text),
    },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button', Markdown: 'Markdown' }),
      toast: (text) => void seen.toasts.push(text),
      status: (text) => void seen.statuses.push(text),
      open: async (pane) => void seen.opened.push(pane.id),
    },
  };

  const matches = (matcher, e) => !matcher || Object.entries(matcher).every(([k, v]) => e[k] === v);
  const dispatch = (event, e, core) => {
    const chain = hooks.filter((x) => x.event === event && matches(x.matcher, e));
    const run = (i, ev) => (i < chain.length ? chain[i].fn($, ev, (next) => run(i + 1, next)) : Promise.resolve(core(ev)));
    return run(0, e);
  };
  let uses = 0;

  const api = {
    ...seen,
    stored,
    settle,
    setCwd: (dir) => { sessionCwd = dir; },
    setFile: (file, isThere) => { fakeFiles.set(file, isThere); },
    setAfplayExit: (code) => { afplayExit = code; },
    // one period of every live timer, awaited, then whatever it set off without waiting (a sound)
    tick: async () => {
      for (const t of [...timers]) if (t.isOn) await t.fn();
      await settle();
    },
    bash: (command, extra = {}) =>
      dispatch('tool.call', { tool: 'Bash', command, tool_use_id: `u${++uses}`, ...extra }, () => ({ result: 'core reached' })),
    // resolves with the prompt as the engine would send it on, context included
    prompt: (text, kind = 'composer', extra = {}) =>
      dispatch('prompt.submit', { text, origin: { kind }, wait: false, ...extra }, (e) => e),
    stop: (fields = {}) =>
      dispatch('classic.Stop', {
        hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Готово.', background_tasks: [], session_crons: [], ...fields,
      }, () => ({})),
    command: (name, args = '') => dispatch('command.run', { command: name, args }, () => ({})),
    render: (component, { surface = 'desktop', isFullscreen = false } = {}) =>
      dispatch('ui.render', {
        component,
        surface,
        requestId: component === 'Pane' ? 'codex-duet' : undefined,
        viewport: { columns: 120, rows: 40, isFullscreen },
        props: component === 'SessionMode' ? { modes: [] } : { bodyColumns: 120, hasSurvey: false },
      }, () => BELOW),
    // presses the Button with this key in a drawn tree
    press: async (tree, key) => {
      const button = nodes(tree).find((n) => n.type === 'Button' && n.props.key === key);
      if (!button) throw new Error(`no button ${key}`);
      button.props.onPress();
      await settle();
    },
  };
  await dispatch('session.start', {}, () => ({}));
  await settle(); // the first read that session.start fires without waiting
  return api;
}

export function nodes(tree) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    out.push(n);
    n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

// What the person reads, line by line: each Text's words, each Button as [label], each Markdown's text.
export function lines(tree) {
  return nodes(tree).flatMap((n) => {
    if (n.type === 'Button') return [`[${n.props.label}]`];
    if (n.type === 'Markdown') return [n.props.text];
    if (n.type === 'Text') return [n.children.filter((c) => typeof c !== 'object').join('')];
    return [];
  });
}

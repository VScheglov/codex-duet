#!/usr/bin/env node
// Synthesizes the pane's three cues into this folder: node sounds/make.mjs
// Soft bell tones (a fundamental with two quiet overtones and an exponential decay), 16-bit mono WAV.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RATE = 22050;
const PEAK = 0.45; // well below full scale: a cue, not an alarm

// [frequency Hz, start s]; every note rings with the same decay
const CUES = {
  decision: { notes: [[659.25, 0], [987.77, 0.14]], decay: 0.32, length: 0.9 }, // rising: "your turn"
  done: { notes: [[523.25, 0], [659.25, 0.11], [783.99, 0.22], [1046.5, 0.33]], decay: 0.35, length: 1.1 }, // major arpeggio
  error: { notes: [[440, 0], [349.23, 0.18]], decay: 0.4, length: 1.0 }, // falling: something broke
};

function render({ notes, decay, length }) {
  const out = new Float64Array(Math.round(RATE * length));
  for (const [freq, start] of notes) {
    const from = Math.round(start * RATE);
    for (let i = from; i < out.length; i += 1) {
      const t = (i - from) / RATE;
      const envelope = Math.min(1, t / 0.008) * Math.exp(-t / decay);
      const w = 2 * Math.PI * freq * t;
      out[i] += envelope * (Math.sin(w) + 0.25 * Math.sin(2 * w) + 0.08 * Math.sin(3 * w));
    }
  }
  const fade = Math.round(RATE * 0.05); // no click at the cut
  for (let i = 0; i < fade; i += 1) out[out.length - 1 - i] *= i / fade;
  const max = Math.max(...out.map(Math.abs));
  return out.map((v) => (v / max) * PEAK);
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(v * 32767), i * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); // fmt chunk size
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28); // bytes per second
  head.writeUInt16LE(2, 32); // bytes per frame
  head.writeUInt16LE(16, 34); // bits per sample
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

for (const [name, cue] of Object.entries(CUES)) {
  const file = path.join(HERE, `${name}.wav`);
  fs.writeFileSync(file, wav(render(cue)));
  console.log(`${path.relative(process.cwd(), file)}: ${cue.length}s`);
}

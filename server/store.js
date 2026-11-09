// Tiny JSON persistence: bot state survives restarts. Writes are atomic (tmp + rename).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DATA_DIR lets a cloud host point this at a persistent disk (e.g. /var/data on Render).
const DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = path.join(DIR, 'state.json');

export function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

export function save(state) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('save failed:', e.message);
  }
}

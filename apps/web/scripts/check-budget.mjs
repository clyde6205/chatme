/**
 * Performance budget gate (runs after `vite build`, fails CI on regression).
 * Measures what a first visit must download before the shell is interactive:
 * index.html + the entry JS + entry CSS + the modules it statically imports, gzip-compressed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET = {
  criticalGzipKB: 20, // shell JS + CSS + HTML
  largestLazyChunkGzipKB: 15, // any single screen or locale chunk
};

const dist = new URL('../dist/', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8'));
const gz = (file) => gzipSync(readFileSync(join(dist, file)), { level: 9 }).length / 1024;

const entry = Object.values(manifest).find((c) => c.isEntry);
const critical = new Set(['index.html', entry.file, ...(entry.css ?? [])]);
const walk = (key) => {
  const chunk = manifest[key];
  critical.add(chunk.file);
  for (const css of chunk.css ?? []) critical.add(css);
  for (const imp of chunk.imports ?? []) walk(imp);
};
for (const imp of entry.imports ?? []) walk(imp);

const criticalKB = [...critical].reduce((sum, f) => sum + gz(f), 0);
const lazy = Object.values(manifest)
  .filter((c) => !critical.has(c.file) && c.file.endsWith('.js'))
  .map((c) => ({ file: c.file, kb: gz(c.file) }))
  .sort((a, b) => b.kb - a.kb);

console.log(`critical path (gzip): ${criticalKB.toFixed(1)} KB / ${BUDGET.criticalGzipKB} KB`);
for (const f of critical) console.log(`  ${f}  ${gz(f).toFixed(1)} KB`);
console.log(`largest lazy chunk: ${lazy[0]?.file} ${lazy[0]?.kb.toFixed(1)} KB / ${BUDGET.largestLazyChunkGzipKB} KB`);

let failed = false;
if (criticalKB > BUDGET.criticalGzipKB) { console.error('✗ critical path budget exceeded'); failed = true; }
if (lazy[0] && lazy[0].kb > BUDGET.largestLazyChunkGzipKB) { console.error('✗ lazy chunk budget exceeded'); failed = true; }
process.exit(failed ? 1 : 0);

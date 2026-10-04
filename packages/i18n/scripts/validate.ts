/**
 * CI gate: `pnpm i18n:check`. Exits non-zero on any structural issue and
 * prints which locales are still drafts (not a failure, but never "production quality").
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalogs } from '../src/validate.js';
import { LOCALE_MANIFEST } from '../src/manifest.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'locales');
const raw: Record<string, unknown> = {};
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  raw[file.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, file), 'utf8'));
}

const issues = validateCatalogs(raw);
for (const i of issues) console.error(`✗ [${i.locale}]${i.key ? ` ${i.key}` : ''}: ${i.problem}`);

const drafts = Object.entries(LOCALE_MANIFEST).filter(([, m]) => m.status === 'draft').map(([l]) => l);
console.log(`${Object.keys(raw).length} catalogs checked, ${issues.length} issue(s).`);
if (drafts.length) console.log(`Draft (not human-reviewed): ${drafts.join(', ')}`);
process.exit(issues.length ? 1 : 0);

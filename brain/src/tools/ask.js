/**
 * Ask the brain a question from the terminal — the fastest way to iterate on
 * ranking without opening the panel.
 *
 *   bun run src/tools/ask.js "the pdf I just downloaded"
 *   bun run src/tools/ask.js --explain "dark"
 */

import { loadConfig } from '../common/config.js';
import { Indexer } from '../modules/index/indexer.js';
import { SearchEngine } from '../modules/search/engine.js';

const argv = process.argv.slice(2);
const explain = argv.includes('--explain');
const text = argv.filter((a) => !a.startsWith('--')).join(' ');

const config = loadConfig();
const indexer = new Indexer(config);
await indexer.refresh();
const engine = new SearchEngine({ config, indexer });

const started = Date.now();
const { view, meta } = engine.local(text, { frontmost_app: 'terminal' });

console.log(`query     : ${JSON.stringify(text)}`);
console.log(`timing    : ${Date.now() - started} ms   time window: ${meta.timeWindow?.label ?? 'none'}   candidates: ${meta.candidateCount}`);
if (explain) console.log(`set       : ${JSON.stringify(view.set)}`);
console.log('─'.repeat(78));

view.rows.forEach((row, i) => {
  const marks = [row.ready ? '↵' : ' ', row.inSet ? '✓' : ' ', row.isGroup ? '§' : ' '].join('');
  console.log(`${marks} ${String(i + 1).padStart(2)}. ${row.title}   [${row.kind}]`);
  console.log(`            ${row.detail ?? ''}`);
});

if (view.ready) console.log('\nEnter is green: the top row matched every word you typed.');
process.exit(0);

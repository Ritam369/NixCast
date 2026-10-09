/**
 * Ask the brain a question from the terminal — the fastest way to iterate on
 * the ranking without logging out of GNOME.
 *
 *   bun run src/tools/ask.js "the pdf I just downloaded"
 *   bun run src/tools/ask.js --no-jev "dark"
 *   bun run src/tools/ask.js --explain "links I visited today"
 */

import { loadConfig, jevIsConfigured } from '../common/config.js';
import { Indexer } from '../modules/index/indexer.js';
import { SearchEngine } from '../modules/search/engine.js';
import { JevClient } from '../modules/jev/client.js';

const argv = process.argv.slice(2);
const noJev = argv.includes('--no-jev');
const explain = argv.includes('--explain');
const text = argv.filter((a) => !a.startsWith('--')).join(' ');

const config = loadConfig();
const indexer = new Indexer(config);
await indexer.refresh();

const engine = new SearchEngine({ config, indexer });
const jev = new JevClient(config);

function printRows(label, rows, ready) {
  console.log(`\n${label}${ready ? '  [Enter is green]' : ''}`);
  console.log('─'.repeat(78));
  rows.forEach((row, i) => {
    const marks = [row.ready ? '↵' : ' ', row.inSet ? '✓' : ' ', row.isGroup ? '§' : ' '].join('');
    const score = typeof row.score === 'number' ? row.score.toFixed(3) : (row.fuzzy ?? 0).toFixed(3);
    console.log(`${marks} ${String(i + 1).padStart(2)}. ${score}  ${row.title}`);
    console.log(`            ${row.detail ?? ''}   [${row.kind}]`);
  });
}

console.log(`query: ${JSON.stringify(text)}`);
const started = Date.now();
const local = engine.local(text, { frontmost_app: 'Firefox', time_of_day: 'afternoon', weekday: 'Sunday' });
console.log(`local phase: ${Date.now() - started} ms  (candidates=${local.meta.candidateCount}, timeWindow=${local.meta.timeWindow?.label ?? 'none'})`);

if (explain) {
  console.log('\nstate sent to Jev:');
  console.log(JSON.stringify(local.payload.state, null, 2).slice(0, 4000));
  console.log('\nquestion ids:', Object.keys(local.payload.questions).join(', '));
}

printRows('LOCAL ORDER (what the panel shows immediately)', local.view.rows, false);

if (!noJev && jevIsConfigured(config)) {
  try {
    const result = await jev.ask(local.payload);
    const ranked = engine.ranked(local, result);
    printRows(`JEV ORDER  target=${ranked.view.targetId} action=${ranked.view.action}`, ranked.view.rows, ranked.view.ready);
    console.log(
      `\nmodel=${result.model} rtt=${result.rttMs}ms in=${result.usage.input_tokens} tok cost=$${result.costUsd.toFixed(6)}`
    );
    console.log(`set: ${JSON.stringify(ranked.view.set)}`);
  } catch (err) {
    console.error('\nJev request failed:', err instanceof Error ? err.message : String(err));
    if (err?.body) console.error('body:', err.body);
  }
} else if (!noJev) {
  console.log('\n(skipping Jev: no API key configured — see bun run src/index.js --check)');
}

process.exit(0);

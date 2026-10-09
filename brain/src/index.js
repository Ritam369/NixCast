/**
 * NixCast brain — entry point.
 *
 *   bun run src/index.js              start the socket server
 *   bun run src/index.js --reindex    build the index, print counts, exit
 *   bun run src/index.js --check      print local diagnostics, exit
 */

import fs from 'node:fs';
import { loadConfig, ensureConfigFile } from './common/config.js';
import { createLogger } from './common/logger.js';
import { paths, dataDirs } from './common/paths.js';
import { plocateBinary } from './modules/index/plocate.js';
import { Indexer } from './modules/index/indexer.js';
import { SearchEngine } from './modules/search/engine.js';
import { Executor } from './modules/exec/executor.js';
import { BrainServer, APP } from './modules/server/server.js';

const log = createLogger('main');

/** Everything needed to diagnose a setup. Needs no key, because there is none. */
function check() {
  const config = loadConfig();

  console.log(`${APP.name} ${APP.version} — local diagnostics`);
  console.log('config file   :', paths.configFile);
  console.log('socket        :', paths.socketPath);
  console.log('downloads     :', config.index.downloadsDir);
  console.log('also indexed  :', (config.index.extraDirs ?? []).join(', '));
  console.log('app dirs      :', dataDirs().length, 'XDG data directories');

  const roots = config.index.searchRoots ?? [];
  console.log('search roots  :', roots.length === 0 ? '(none configured)' : '');
  for (const root of roots) {
    console.log('               ', fs.existsSync(root) ? root : `${root}   (missing — skipped, e.g. a drive that is not mounted)`);
  }

  console.log('plocate       :', plocateBinary() ?? 'not installed — whole-disk name search is off');
  console.log('              ', 'run `sudo systemctl start update-locatedb` after installing it');

  const browsers = (config.index.browsers ?? []).join(', ');
  console.log('browsers      :', browsers || '(none configured)');
  return 0;
}

async function reindex() {
  const config = loadConfig();
  const indexer = new Indexer(config);
  const started = Date.now();
  const snapshot = await indexer.refresh();
  console.log(`indexed in ${Date.now() - started} ms`);
  console.log('counting :', JSON.stringify(snapshot.counting));
  console.log('sources  :', JSON.stringify(snapshot.sources));
  console.log('\nsample apps:');
  for (const app of snapshot.apps.slice(0, 5)) console.log(`  ${app.title}  (${app.detail})`);
  console.log('sample files:');
  for (const file of [...snapshot.recent, ...snapshot.files].slice(0, 5)) console.log(`  ${file.title}  (${file.detail})`);
  return 0;
}

async function serve() {
  const { created, file } = ensureConfigFile();
  const config = loadConfig();
  if (created) log.info(`created default config at ${file}`);

  const indexer = new Indexer(config);
  const engine = new SearchEngine({ config, indexer });
  const executor = new Executor(config);
  const server = new BrainServer({ config, indexer, engine, executor });

  indexer.onUpdate((snapshot) => {
    log.debug(`index updated: ${JSON.stringify(snapshot.counting)}`);
  });

  // Listen first so the extension never races the index, then build the index
  // in the background.
  server.listen();
  indexer
    .start({ awaitFirst: false })
    .then(() => log.info(`index ready: ${JSON.stringify(indexer.snapshot.counting)}`))
    .catch((err) => log.error('initial index failed', String(err)));

  const shutdown = async (signal) => {
    log.info(`${signal} received, shutting down`);
    indexer.stop();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return new Promise(() => {});
}

const arg = process.argv[2];
const exitCode = arg === '--check' ? check() : arg === '--reindex' ? await reindex() : await serve();
if (typeof exitCode === 'number') process.exit(exitCode);

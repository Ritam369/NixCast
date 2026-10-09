/**
 * Jev Launcher brain — entry point.
 *
 *   bun run src/index.js              start the socket server
 *   bun run src/index.js --reindex    build the index, print counts, exit
 *   bun run src/index.js --check      verify config + Jev credentials, exit
 */

import { loadConfig, ensureConfigFile, jevIsConfigured } from './common/config.js';
import { createLogger } from './common/logger.js';
import { paths } from './common/paths.js';
import { Indexer } from './modules/index/indexer.js';
import { SearchEngine } from './modules/search/engine.js';
import { Executor } from './modules/exec/executor.js';
import { JevClient } from './modules/jev/client.js';
import { BrainServer } from './modules/server/server.js';

const log = createLogger('main');

async function check() {
  const config = loadConfig();
  const jev = new JevClient(config);

  console.log('config file      :', paths.configFile);
  console.log('socket           :', paths.socketPath);
  console.log('transport        :', config.jev.transport);
  console.log('jev enabled      :', config.jev.enabled);
  console.log('jev configured   :', jevIsConfigured(config));
  console.log('model            :', config.jev.model);
  if (config.jev.transport === 'direct') {
    console.log('endpoint         :', `${config.jev.baseUrl.replace(/\/+$/, '')}${config.jev.path}`);
  } else {
    console.log('gateway base url :', config.jev.gatewayBaseUrl || '(AI SDK default)');
    console.log('zero data retain :', config.jev.zeroDataRetention);
  }

  if (!jevIsConfigured(config)) {
    console.log('\nNo API key yet. The launcher still works as a fuzzy launcher.');
    console.log('Put your key in jev.apiKey in the config file above (chmod 600).');
    return 0;
  }

  console.log('\nsending one two-question evaluation to prove the whole path...');
  try {
    const probe = await jev.probe();
    console.log(`  round trip     : ${probe.rttMs} ms`);
    console.log(`  model answered : ${probe.modelId ?? probe.model ?? config.jev.model}`);
    console.log(`  input tokens   : ${probe.usage?.input_tokens ?? 0}`);
    console.log(`  normalized     : ${JSON.stringify(probe.answers)}`);
    console.log('\nraw answer shapes (confirm the fields this build reads):');
    console.log(JSON.stringify(probe.raw?.answers ?? probe.raw, null, 2).slice(0, 1200));
    console.log('\nNote: "ready" is just "is this state non-empty" — a connectivity probe, not a real judgment.');
    return 0;
  } catch (err) {
    console.error(`\nprobe failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err?.body) console.error('response body:', typeof err.body === 'string' ? err.body : JSON.stringify(err.body));
    console.error('\nChecks: is the key right for this transport, does jev.model exist for it,');
    console.error('and is the AI Gateway product enabled on your Vercel account?');
    return 1;
  }
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
  const jev = new JevClient(config);
  const server = new BrainServer({ config, indexer, engine, executor, jev });

  indexer.onUpdate((snapshot) => {
    log.debug(`index updated: ${JSON.stringify(snapshot.counting)}`);
  });

  // Start listening first so the extension never races the index, then build
  // the index and warm the HTTPS connection in the background.
  server.listen();

  indexer
    .start({ awaitFirst: false })
    .then(() => log.info(`index ready: ${JSON.stringify(indexer.snapshot.counting)}`))
    .catch((err) => log.error('initial index failed', String(err)));

  if (jevIsConfigured(config)) {
    jev.warmup().catch(() => {});
  } else {
    log.warn('no Jev API key set — running in fuzzy-only mode');
  }

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
const exitCode = arg === '--check' ? await check() : arg === '--reindex' ? await reindex() : await serve();
if (typeof exitCode === 'number') process.exit(exitCode);

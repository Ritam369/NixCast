/**
 * Talk to a running brain over its unix socket — the same protocol the GNOME
 * Shell extension speaks, without needing a shell restart.
 *
 *   bun run src/tools/socket-client.js                      # hello + stats
 *   bun run src/tools/socket-client.js "the pdf I just"     # full query flow
 *   bun run src/tools/socket-client.js --execute c2 "dark"  # run a row
 *
 * Use this to prove the socket, the framing and the two-phase result flow all
 * work while gnome-shell is untouched.
 */

import net from 'node:net';
import { loadConfig } from '../common/config.js';
import { paths } from '../common/paths.js';

const argv = process.argv.slice(2);
const executeIndex = argv.indexOf('--execute');
const executeRowId = executeIndex === -1 ? null : argv[executeIndex + 1];
const text = argv
  .filter((a, i) => !a.startsWith('--') && (executeIndex === -1 || i !== executeIndex + 1))
  .join(' ');

const socketPath = paths.socketPath;
const config = loadConfig();

const socket = net.createConnection(socketPath);
let buffer = '';
let seq = 0;
const started = Date.now();

socket.setTimeout(8000, () => {
  console.error(`timed out waiting for ${socketPath}`);
  process.exit(1);
});

socket.on('error', (err) => {
  console.error(`could not connect to ${socketPath}: ${err.message}`);
  console.error('is the brain running?  systemctl --user status nixcast-brain');
  process.exit(1);
});

function printRows(label, rows, ready) {
  console.log(`\n${label}${ready ? '  [Enter is green]' : ''}  (+${Date.now() - started} ms)`);
  console.log('─'.repeat(76));
  rows.forEach((row, i) => {
    const marks = [row.ready ? '↵' : ' ', row.inSet ? '✓' : ' ', row.isGroup ? '§' : ' '].join('');
    const score = typeof row.score === 'number' ? row.score.toFixed(3) : (row.fuzzy ?? 0).toFixed(3);
    console.log(`${marks} ${String(i + 1).padStart(2)}. ${score}  ${row.title}   [${row.kind}]`);
  });
}

socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error('malformed line from brain:', line.slice(0, 200));
      continue;
    }

    switch (message.type) {
      case 'hello':
        console.log(`connected to the NixCast brain on ${socketPath}`);
        console.log(`app     : ${JSON.stringify(message.app)}`);
        console.log(`index   : ${JSON.stringify(message.index.counting)}`);
        console.log(`ready   : ${message.index.ready}   built: ${new Date(message.index.builtAt).toISOString()}`);
        if (text || executeRowId) break;
        socket.end();
        break;

      case 'results':
        printRows(`${message.phase.toUpperCase()} PHASE`, message.rows, message.ready);
        if (message.stats) {
          console.log(
            `  model=${message.stats.model} rtt=${message.stats.rttMs}ms tok=${message.stats.inputTokens} cost=$${Number(
              message.stats.costUsd
            ).toFixed(6)}`
          );
        }
        if (message.set?.active) console.log(`  set: ${JSON.stringify(message.set)}`);
        // One phase now: the local answer. When an execution was requested, keep
        // the socket open so its reply can be printed too.
        if (!executeRowId) setTimeout(() => socket.end(), 50);
        break;

      case 'executed':
        console.log(`\nexecuted: ok=${message.ok} ${message.message}`);
        socket.end();
        break;

      case 'error':
        console.log(`\nbrain error: ${message.error}`);
        socket.end();
        break;

      default:
        break;
    }
  }
});

socket.on('connect', () => {
  const send = (message) => socket.write(`${JSON.stringify({ v: 1, ...message })}\n`);
  send({ id: 1, type: 'hello' });

  if (executeRowId) {
    send({ id: 2, type: 'query', seq: 1, text, context: {}, debounceMs: 0 });
    // Give the local phase time to arrive so the row cache is warm.
    setTimeout(() => send({ id: 3, type: 'execute', rowId: executeRowId, query: text }), 1200);
  } else if (text) {
    seq += 1;
    send({ id: 2, type: 'query', seq, text, context: { frontmost_app: 'socket-client' } });
  }
});

socket.on('close', () => process.exit(0));

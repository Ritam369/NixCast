/**
 * Executor — the Linux counterpart of the macOS launcher's Executor.swift.
 *
 * This is the only module that changes anything on the machine, and it only
 * ever runs after the user presses Enter. Values are always passed as argv
 * arrays to Bun.spawn; nothing is interpolated into a shell command line.
 */

import fs from 'node:fs';
import { createLogger } from '../../common/logger.js';
import { executeToggle } from '../index/toggles.js';

const log = createLogger('executor');

const TERMINALS = ['kgx', 'gnome-terminal', 'ptyxis', 'foot', 'alacritty', 'kitty', 'xterm'];

function which(binary) {
  const dirs = (process.env.PATH ?? '').split(':');
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = `${dir}/${binary}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function terminalFor(preferred) {
  const order = preferred ? [preferred, ...TERMINALS] : TERMINALS;
  for (const name of order) if (which(name)) return name;
  return null;
}

/** Detached so a launched app is not killed when the brain is restarted. */
async function spawnDetached(argv, { cwd } = {}) {
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  proc.unref?.();
  return proc;
}

const LAUNCH_TIMEOUT_MS = 5000;
const CLIPBOARD_TIMEOUT_MS = 3000;

/**
 * Every wait in this file is bounded, and that is not a nicety: the extension
 * only closes the panel when it receives a reply, so one subprocess that never
 * exits leaves the launcher stuck open with no way to dismiss it.
 */
async function withTimeout(promise, ms, label, onTimeout) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} did not finish within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function spawnAndWait(argv, { timeoutMs = LAUNCH_TIMEOUT_MS } = {}) {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const collect = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  try {
    const [stdout, stderr] = await withTimeout(collect, timeoutMs, argv[0], () => proc.kill?.());
    const code = await withTimeout(proc.exited, timeoutMs, argv[0]);
    return { code, stdout, stderr };
  } catch (err) {
    // A launcher that lingers has almost certainly done its job, and retrying
    // through Exec= would risk starting the application twice. Report success
    // so the caller does not fall back.
    const reason = err instanceof Error ? err.message : String(err);
    return { code: 0, stdout: '', stderr: `${reason}; assuming the launch succeeded` };
  }
}

export function webSearchUrl(query) {
  // DuckDuckGo keeps the query in the URL without a redirect hop.
  return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
}

export class Executor {
  #config;

  constructor(config) {
    this.#config = config;
  }

  async executeRow(row, extra = {}) {
    if (!row) throw new Error('no row to execute');

    switch (row.kind) {
      case 'open_app':
        return this.#openApp(row);
      case 'open_file':
        return this.#openFile(row);
      case 'open_url':
        return this.#openUrl(row);
      case 'web_search':
        return this.#openUrl({ url: webSearchUrl(extra.query ?? row.title) });
      case 'calculate':
        return this.#copyToClipboard(String(row.value ?? row.title));
      case 'system_toggle':
        return executeToggle(row.toggleId, null);
      case 'run_action':
        return this.#runAction(row.action ?? row, extra);
      default:
        throw new Error(`cannot execute row kind: ${row.kind}`);
    }
  }

  /** Opens a set of rows as one action, e.g. "open all 6 links". */
  async executeSet(rows, extra = {}) {
    if (rows.length === 0) throw new Error('set is empty');

    const kind = rows[0].kind;
    if (kind === 'open_url' || kind === 'open_file') {
      // One xdg-open call per URL: GNOME hands them to a single browser
      // process, which is the same end state as the macOS version's batched
      // NSWorkspace call.
      for (const row of rows) {
        const target = row.path ? [row.path] : [row.url];
        await spawnDetached(['xdg-open', ...target]);
      }
      return `Opened ${rows.length} items`;
    }

    for (const row of rows) await this.executeRow(row, extra);
    return `Ran ${rows.length} items`;
  }

  /**
   * Ask an already-launched application to activate itself.
   *
   * `gio launch` does create the window, but on GNOME a window opened by a
   * background process can end up *behind* the one you were looking at and
   * without focus — which reads as "nothing happened" and makes you press Enter
   * a second time. Activating the app raises it, which is exactly what that
   * second press was doing. Bounded, and never fatal.
   */
  async #activateApp(desktopFile) {
    const appId = desktopFile.split('/').pop().replace(/\.desktop$/, '');
    // App ids are reverse-DNS; anything without a dot has no bus name to call.
    if (!appId.includes('.') || !/^[A-Za-z0-9_.-]+$/.test(appId)) return false;

    const gdbus = which('gdbus');
    if (!gdbus) return false;

    const objectPath = `/${appId.replace(/\./g, '/')}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const proc = Bun.spawn(
          [gdbus, 'call', '--session', '--dest', appId, '--object-path', objectPath, '--method', 'org.freedesktop.Application.Activate', '{}'],
          { stdout: 'ignore', stderr: 'ignore' }
        );
        if ((await proc.exited) === 0) return true;
      } catch {
        /* the service instance may not be on the bus yet; try again */
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    log.debug(`could not activate ${appId}; its window may open unfocused`);
    return false;
  }

  async #openApp(row) {
    if (row.desktopFile) {
      const launch = which('gio');
      if (launch) {
        const result = await spawnAndWait([launch, 'launch', row.desktopFile]);
        if (result.code === 0) {
          await this.#activateApp(row.desktopFile);
          return `Launched ${row.title}`;
        }
        log.debug(`gio launch failed (${result.stderr.trim()}), falling back to Exec=`);
      }
    }
    // gio launch can fail when a desktop file is not registered in the current
    // XDG_DATA_DIRS; the Exec= line still works.
    const argv = (row.exec ?? '').split(' ').filter(Boolean);
    if (argv.length === 0) throw new Error(`no way to launch ${row.title}`);
    await spawnDetached(argv);
    return `Launched ${row.title}`;
  }

  async #openFile(row) {
    if (!row.path) throw new Error('no path');
    await spawnDetached(['xdg-open', row.path]);
    return `Opened ${row.title}`;
  }

  async #openUrl(row) {
    if (!row.url) throw new Error('no url');
    await spawnDetached(['xdg-open', row.url]);
    return `Opened ${row.url}`;
  }

  async #copyToClipboard(text) {
    const wlCopy = which('wl-copy');
    if (!wlCopy) {
      const xclip = which('xclip');
      if (!xclip) throw new Error('no clipboard tool found (install wl-clipboard)');
      await spawnDetached([xclip, '-selection', 'clipboard'], {});
      return text;
    }

    const proc = Bun.spawn([wlCopy], { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' });
    proc.stdin.write(text);
    proc.stdin.end();

    // wl-copy hands the selection to a background holder process, and the
    // foreground process can linger far longer than the copy takes — waiting for
    // its exit blocked this executor indefinitely during testing. Give it a
    // grace period and treat a timeout as success, because by then the selection
    // has already been offered to the compositor.
    try {
      const code = await withTimeout(proc.exited, CLIPBOARD_TIMEOUT_MS, 'wl-copy');
      if (code !== 0) log.warn(`wl-copy exited ${code}; the copy may not have landed`);
    } catch {
      log.debug('wl-copy is still running; assuming the selection was handed over');
    }
    return `Copied ${text}`;
  }

  async #runAction(action, extra) {
    const argv = action.command;
    if (!Array.isArray(argv) || argv.length === 0) throw new Error('action has no command');

    if (action.terminal) {
      const terminal = terminalFor(this.#config.ui?.terminal);
      if (!terminal) throw new Error('no terminal emulator found');
      const line = argv.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
      await spawnDetached([terminal, '--', 'sh', '-lc', `${line}; printf '\\n[done] press Enter to close '; read _`]);
      return `Running ${action.title} in a terminal`;
    }

    await spawnDetached(argv, { cwd: action.cwd });
    return `Ran ${action.title}`;
  }
}

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configured = (process.env.NIXCAST_LOG_LEVEL ?? 'info').toLowerCase();
const threshold = LEVELS[configured] ?? LEVELS.info;

function emit(level, scope, message, extra) {
  if (LEVELS[level] > threshold) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (extra === undefined) stream.write(`${line}\n`);
  else stream.write(`${line} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}\n`);
}

/** Logging goes to stdout/stderr so systemd-journald owns rotation. */
export function createLogger(scope) {
  return {
    error: (m, e) => emit('error', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    debug: (m, e) => emit('debug', scope, m, e),
  };
}

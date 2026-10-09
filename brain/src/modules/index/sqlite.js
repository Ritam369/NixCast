/**
 * Copy-on-read helpers for the SQLite databases browsers keep open.
 *
 * A running browser holds its history and bookmark databases locked, so both
 * providers read from a temporary copy — including any -wal/-shm companions,
 * which hold the most recent transactions. The database never leaves the
 * machine, and only the handful of rows that survive filtering are ever sent to
 * Jev.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';

/** Chromium timestamps are microseconds since 1601-01-01. */
export const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000;

/**
 * Open a throwaway copy of `file` and hand the connection to `fn`, cleaning up
 * afterwards whether or not `fn` throws.
 */
export function withDatabase(file, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-sqlite-'));
  const copy = path.join(tmpDir, path.basename(file));
  let db;

  try {
    fs.copyFileSync(file, copy);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${file}${suffix}`)) {
        try {
          fs.copyFileSync(`${file}${suffix}`, `${copy}${suffix}`);
        } catch {
          /* a missing WAL only costs us the newest rows */
        }
      }
    }

    db = new Database(copy, { readonly: true });
    return fn(db);
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

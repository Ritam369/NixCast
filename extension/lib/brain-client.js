/**
 * Brain client — newline-delimited JSON over a unix socket.
 *
 * Kept deliberately dumb: it owns the connection, the framing and reconnect
 * backoff, and nothing else. All judgement about what to send lives in
 * extension.js so the shell code stays small.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const PROTOCOL_VERSION = 1;

export class BrainClient {
  constructor({ socketPath = null, onMessage = () => {}, onStateChange = () => {} } = {}) {
    this._socketPath = socketPath;
    this._onMessage = onMessage;
    this._onStateChange = onStateChange;

    this._connection = null;
    this._input = null;
    this._output = null;
    this._readCancellable = null;
    this._reconnectId = 0;
    this._reconnectDelayMs = 1000;
    this._closed = false;
    this._nextId = 1;

    this.state = 'disconnected';
  }

  get socketPath() {
    if (this._socketPath) return this._socketPath;
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'nixcast', 'brain.sock']);
  }

  #setState(state, detail = null) {
    if (this.state === state) return;
    this.state = state;
    // destroy() closes the stream, and the pending read callback can still land
    // here afterwards — by which point the owner has torn its widgets down, so
    // calling back into it would throw "this._panel is null".
    if (this._closed) return;
    this._onStateChange(state, detail);
  }

  connect() {
    this._closed = false;
    this.#open();
  }

  #open() {
    const path = this.socketPath;

    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
      this.#setState('no-socket', path);
      this.#scheduleReconnect();
      return;
    }

    try {
      const address = new Gio.UnixSocketAddress({ path });
      const client = new Gio.SocketClient();
      this._connection = client.connect(address, null);
      const input = new Gio.DataInputStream({ base_stream: this._connection.get_input_stream() });
      const output = new Gio.DataOutputStream({ base_stream: this._connection.get_output_stream() });
      this._input = input;
      this._output = output;
      this._reconnectDelayMs = 1000;
      this.#setState('connected');
      this.#readNext();
      this.send({ type: 'hello' });
    } catch (err) {
      this.#setState('error', String(err));
      this.#scheduleReconnect();
    }
  }

  #readNext() {
    if (!this._input || this._closed) return;

    this._input.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
      let line = null;
      try {
        const [text] = stream.read_line_finish_utf8(result);
        line = text;
      } catch (err) {
        // EOF or a broken connection: both end up here.
        this.#handleDisconnect(String(err));
        return;
      }

      if (line === null) {
        this.#handleDisconnect('end of stream');
        return;
      }

      this.#handleLine(line);
      this.#readNext();
    });
  }

  #handleLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      logError(new Error(`brain sent malformed json: ${trimmed.slice(0, 200)}`));
      return;
    }

    try {
      this._onMessage(message);
    } catch (err) {
      logError(err, 'brain message handler failed');
    }
  }

  #handleDisconnect(reason) {
    this._connection = null;
    this._input = null;
    this._output = null;
    this.#setState('disconnected', reason);
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this._closed || this._reconnectId !== 0) return;
    this._reconnectId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._reconnectDelayMs, () => {
      this._reconnectId = 0;
      this._reconnectDelayMs = Math.min(this._reconnectDelayMs * 2, 15000);
      this.#open();
      return GLib.SOURCE_REMOVE;
    });
  }

  /** Fire-and-forget: the socket is local and writes are tiny. */
  send(message) {
    if (!this._output) return false;
    const payload = `${JSON.stringify({ v: PROTOCOL_VERSION, id: this._nextId++, ...message })}\n`;
    try {
      this._output.write_all(payload, null);
      this._output.flush(null);
      return true;
    } catch (err) {
      this.#handleDisconnect(String(err));
      return false;
    }
  }

  query(text, context, seq) {
    return this.send({ type: 'query', seq, text, context });
  }

  execute(rowId, query) {
    return this.send({ type: 'execute', rowId, query });
  }

  /** Ask for a fresh index summary; the reply arrives as a `stats` message. */
  requestStats() {
    return this.send({ type: 'stats' });
  }

  destroy() {
    this._closed = true;
    if (this._reconnectId !== 0) {
      GLib.source_remove(this._reconnectId);
      this._reconnectId = 0;
    }
    try {
      this._input?.close(null);
    } catch {
      /* already gone */
    }
    try {
      this._connection?.close(null);
    } catch {
      /* already gone */
    }
    this._input = null;
    this._output = null;
    this._connection = null;
    this.#setState('closed');
  }
}

/**
 * Jev Launcher — GNOME Shell extension entry point.
 *
 * Responsibilities, deliberately small:
 *   - own the keybinding through the shell's keybinding manager, so the
 *     shortcut can be changed in GNOME Settings without touching code
 *   - connect to the Bun brain over a unix socket and forward keystrokes
 *   - hand rows from the brain to the panel, dropping stale answers
 *   - send the Enter press and report what happened
 *
 * Everything else — indexing, fuzzy matching, arithmetic, time windows, the
 * Jev request, ranking and execution — lives in the brain process, out of the
 * shell's address space. A bug there cannot take down the desktop.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { BrainClient } from './lib/brain-client.js';
import { JevPanel } from './lib/panel.js';

const KEYBINDING_NAME = 'toggle-launcher';

export default class JevLauncherExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._seq = 0;
    this._index = null;
    this._jev = null;
    this._stats = null;

    this._panel = new JevPanel({
      settings: this._settings,
      onQuery: (text) => this.#onQuery(text),
      onExecute: (row) => this.#onExecute(row),
      onClose: () => {},
    });
    Main.uiGroup.add_child(this._panel.actor);

    this._brain = new BrainClient({
      socketPath: this._settings.get_string('brain-socket') || null,
      onMessage: (message) => this.#onMessage(message),
      onStateChange: (state, detail) => this._panel?.setBrainState(state, detail),
    });
    this._panel.setBrainState('connecting');
    this._brain.connect();

    this.#addKeybinding();

    // Printed once per enable(), so the journal always says which shortcut is
    // live — and during development it answers whether re-enabling actually
    // re-read the files, which on GNOME 49 it does not (see README §10).
    log(`jev-launcher enabled: shortcut ${this._settings.get_strv(KEYBINDING_NAME).join(', ') || '(none)'}`);
  }

  disable() {
    Main.wm.removeKeybinding(KEYBINDING_NAME);

    this._brain?.destroy();
    this._brain = null;

    this._panel?.destroy();
    this._panel = null;

    this._settings = null;
    this._seq = 0;
  }

  #addKeybinding() {
    Main.wm.addKeybinding(
      KEYBINDING_NAME,
      this._settings,
      Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
      Shell.ActionMode.ALL,
      () => {
        // An exception thrown here surfaces as a bare JS ERROR in the journal
        // and the shortcut silently does nothing — which is exactly how one
        // bogus settings read in panel.js made Alt+Space look dead. Catch it,
        // log it with context, and leave the shell usable.
        try {
          this._panel?.toggle();
        } catch (err) {
          logError(err, 'jev-launcher: toggling the panel failed');
        }
      }
    );
  }

  /** Minimal context, matching the macOS version's state fields. */
  #context() {
    let frontmostApp = null;
    try {
      const win = global.display.focus_window;
      frontmostApp = win ? win.get_wm_class() : null;
    } catch {
      frontmostApp = null;
    }

    let recentApps = [];
    try {
      recentApps = Shell.AppSystem.get_default()
        .get_running()
        .slice(0, 5)
        .map((app) => app.get_name());
    } catch {
      recentApps = [];
    }

    const now = new Date();
    const hours = now.getHours();
    const timeOfDay = hours < 5 ? 'late night' : hours < 12 ? 'morning' : hours < 17 ? 'afternoon' : hours < 21 ? 'evening' : 'night';

    return {
      frontmost_app: frontmostApp,
      recent_apps: recentApps,
      // Reading clipboard contents needs a helper process; the kind of the
      // current selection is enough for Jev and is what the original sends.
      clipboard_kind: 'unknown',
      time_of_day: timeOfDay,
      weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()],
    };
  }

  #onQuery(text) {
    if (!this._brain) return;
    // Every keystroke goes out. The brain answers the fuzzy phase
    // immediately and debounces its own Jev call, so the list never waits
    // on the network and stale answers are discarded by sequence number.
    this._seq += 1;
    const sent = this._brain.query(text, this.#context(), this._seq, this._settings.get_int('debounce-ms'));
    if (!sent) this._panel.setBrainState(this._brain.state);
  }

  #onExecute(row) {
    if (!this._brain) return;
    this._brain.execute(row.id, this._panel?.text ?? '');
  }

  #onMessage(message) {
    // A last message can arrive after disable() has destroyed the panel.
    if (!this._panel) return;

    switch (message.type) {
      case 'hello':
        this._index = message.index;
        this._jev = message.jev;
        this._panel.setJevConfigured(message.jev);
        break;

      case 'results': {
        // Newest answer wins: an answer for an older keystroke is ignored.
        if (typeof message.seq === 'number' && message.seq < this._seq) return;
        this._panel.setRows(message.rows ?? [], {
          phase: message.phase,
          stats: message.stats ?? this._stats,
          usage: message.usage ?? this._usage,
          set: message.set ?? null,
          targetId: message.targetId ?? null,
          action: message.action ?? null,
        });
        if (message.stats) this._stats = message.stats;
        if (message.usage) this._usage = message.usage;
        break;
      }

      case 'jev_error':
        this._panel.setWarning(`Jev error: ${message.error}`);
        break;

      case 'executed':
        if (!message.ok) {
          this._panel.setWarning(`Could not run that: ${message.message}`);
          break;
        }

        if (message.kind === 'system_toggle') {
          // A toggle changes something with no window to look at, so closing the
          // panel leaves you guessing — and pressing Enter again would flip it
          // straight back. Confirm it in place, then re-ask so the subtitles show
          // the new state.
          this._panel.setNotice(message.message);
          GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            if (this._panel) this.#onQuery(this._panel.text);
            return GLib.SOURCE_REMOVE;
          });
          break;
        }

        this._panel.close();
        break;

      case 'index':
        this._index = message.index;
        break;

      case 'error':
        this._panel.setWarning(`Brain error: ${message.error}`);
        break;

      default:
        break;
    }
  }
}

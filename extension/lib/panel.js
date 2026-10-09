/**
 * The panel: a Spotlight-style overlay built from St widgets.
 *
 * Why not a normal GTK window: GNOME's Mutter does not implement
 * wlr-layer-shell, so no toolkit can anchor a window to the screen or keep it
 * above other windows. A shell-owned actor is the only way to get a real
 * always-on-top palette on stock GNOME — which is exactly what the macOS
 * original gets from NSVisualEffectView plus a window level.
 *
 * The actor is added to Main.uiGroup and takes a modal grab while open, so
 * every keystroke reaches the entry and Escape always closes it.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ROW_ICON_SIZE = 22;

export class JevPanel {
  constructor({ settings, onQuery = () => {}, onExecute = () => {}, onClose = () => {} }) {
    this._settings = settings;
    this._onQuery = onQuery;
    this._onExecute = onExecute;
    this._onClose = onClose;

    this._rows = [];
    this._selected = 0;
    this._grab = null;
    this._isOpen = false;
    this._meta = { phase: 'local', jevConfigured: null, brainState: 'disconnected', stats: null, warning: null };

    this.#buildUI();
  }

  get actor() {
    return this._actor;
  }

  get text() {
    return this._entry.get_text();
  }

  get isOpen() {
    return this._isOpen;
  }

  // ---------------------------------------------------------------- widgets

  #buildUI() {
    this._actor = new St.Widget({
      style_class: 'jev-overlay',
      reactive: true,
      visible: false,
      layout_manager: new Clutter.BinLayout(),
      can_focus: true,
    });

    this._panel = new St.BoxLayout({
      style_class: 'jev-panel',
      vertical: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.START,
    });

    // Search entry
    const entryRow = new St.BoxLayout({ style_class: 'jev-entry-row' });
    entryRow.add_child(new St.Icon({ icon_name: 'system-search-symbolic', style_class: 'jev-entry-icon' }));

    this._entry = new St.Entry({
      style_class: 'jev-entry',
      can_focus: true,
      x_expand: true,
      hint_text: 'Type a command, an app, a file, or a question…',
    });
    entryRow.add_child(this._entry);
    this._panel.add_child(entryRow);

    // Rows
    this._rowsBox = new St.BoxLayout({ style_class: 'jev-rows', vertical: true, x_expand: true });
    this._panel.add_child(this._rowsBox);

    // Footer
    this._footer = new St.BoxLayout({ style_class: 'jev-footer', x_expand: true });
    // Two labels, deliberately: an error must appear *next to* the stats rather
    // than replacing them. With one label, a single failed action hid the
    // rtt/cost line for the rest of the panel's life.
    this._footerWarning = new St.Label({
      style_class: 'jev-footer-warn',
      text: '',
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
    });
    this._footerStats = new St.Label({
      style_class: 'jev-footer-label',
      text: '',
      y_align: Clutter.ActorAlign.CENTER,
    });
    // Third label: the running cost, so the per-decision figure has context.
    // x_expand + END alignment pushes it flush to the right edge of the footer.
    this._footerUsage = new St.Label({
      style_class: 'jev-footer-label',
      text: '',
      y_align: Clutter.ActorAlign.CENTER,
      x_align: Clutter.ActorAlign.END,
      x_expand: true,
    });
    this._footer.add_child(this._footerWarning);
    this._footer.add_child(this._footerStats);
    this._footer.add_child(this._footerUsage);
    this._panel.add_child(this._footer);

    this._actor.add_child(this._panel);

    this.#connectKeys();
  }

  #connectKeys() {
    const clutterText = this._entry.clutter_text;

    clutterText.connect('text-changed', () => this.#emitQuery());

    // Return is consumed here rather than through Clutter.Text::activate so
    // that a single code path decides what Enter means.
    clutterText.connect('key-press-event', (_actor, event) => {
      const symbol = event.get_key_symbol();
      switch (symbol) {
        case Clutter.KEY_Escape:
          this.close();
          return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
          this.activate();
          return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
          this.moveSelection(-1);
          return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
          this.moveSelection(1);
          return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
          this.moveSelection(-5);
          return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
          this.moveSelection(5);
          return Clutter.EVENT_STOP;
        default:
          return Clutter.EVENT_PROPAGATE;
      }
    });

    // Escape still closes when focus has wandered off the entry (for example
    // after clicking a row).
    this._actor.connect('key-press-event', (_actor, event) => {
      if (event.get_key_symbol() === Clutter.KEY_Escape) {
        this.close();
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });
  }

  // ---------------------------------------------------------------- lifecycle

  open() {
    if (this._isOpen) return;

    if (Main.overview?.visible) Main.overview.hide();

    const monitor = Main.layoutManager.primaryMonitor;
    if (monitor) {
      this._actor.set_position(monitor.x, monitor.y);
      this._actor.set_size(monitor.width, monitor.height);
      // How far down the panel sits, as a fraction of the monitor height. A
      // constant on purpose: this used to read a GSettings key that the schema
      // never declared, and because it ran inside the keybinding handler the
      // throw meant Alt+Space silently did nothing. Panel geometry is not worth
      // a schema key. (PANEL_TOP_FRACTION would be the tidier form if it is ever
      // read twice.)
      this._panel.set_margin_top(Math.round(monitor.height * 0.15));
    }

    this._actor.show();
    this._isOpen = true;

    // A modal grab is what makes this behave like the macOS panel: the
    // launcher owns the keyboard while it is open.
    try {
      this._grab = Main.pushModal(this._actor, { actionMode: Shell.ActionMode.NORMAL });
    } catch (err) {
      this._grab = null;
      logError(err, 'jev-launcher: could not take a modal grab');
    }

    this._entry.set_text('');
    this._entry.grab_key_focus();
    this._selected = 0;

    this.#emitQuery();
  }

  close() {
    if (!this._isOpen) return;
    this._isOpen = false;

    if (this._grab) {
      try {
        Main.popModal(this._grab);
      } catch (err) {
        logError(err, 'jev-launcher: could not release the modal grab');
      }
      this._grab = null;
    }

    this._actor.hide();
    this._onClose();
  }

  toggle() {
    if (this._isOpen) this.close();
    else this.open();
  }

  destroy() {
    this.close();
    this._actor?.destroy();
    this._actor = null;
  }

  // ---------------------------------------------------------------- data in

  setRows(rows, meta = {}) {
    this._rows = Array.isArray(rows) ? rows : [];
    // Fresh results mean the previous action's outcome is stale — including any
    // error, which must not keep the footer's stats hidden.
    this._meta = { ...this._meta, ...meta, warning: null };
    if (this._selected >= this._rows.length) this._selected = 0;
    this.#render();
  }

  setBrainState(state, detail = null) {
    this._meta.brainState = state;
    this._meta.brainDetail = detail;
    this.#renderFooter();
  }

  setJevConfigured(jev) {
    this._meta.jevConfigured = jev;
    this.#renderFooter();
  }

  /** A confirmation that must not close the panel (a toggle has no window). */
  setNotice(message) {
    this._meta.notice = message;
    this._meta.warning = null;
    this.#renderFooter();
  }

  setWarning(message) {
    this._meta.warning = message;
    this.#renderFooter();
  }

  get selectedRow() {
    return this._rows[this._selected] ?? null;
  }

  // ---------------------------------------------------------------- input out

  #emitQuery() {
    // Typing is a new intention, so a previous action's confirmation goes away.
    if (this._meta.notice) this._meta.notice = null;
    this._onQuery(this._entry.get_text());
  }

  moveSelection(delta) {
    if (this._rows.length === 0) return;
    const next = (this._selected + delta + this._rows.length) % this._rows.length;
    this._selected = next;
    this.#refreshSelection();
  }

  activate() {
    const row = this.selectedRow;
    if (!row) return;
    this._onExecute(row);
  }

  // ---------------------------------------------------------------- rendering

  #render() {
    this._rowsBox.destroy_all_children();

    if (this._rows.length === 0) {
      const label = new St.Label({
        text: this.#emptyMessage(),
        style_class: 'jev-row-detail',
        x_align: Clutter.ActorAlign.START,
      });
      label.set_margin_top(6);
      label.set_margin_bottom(6);
      label.set_margin_left(10);
      this._rowsBox.add_child(label);
      this.#renderFooter();
      return;
    }

    this._rows.forEach((row, index) => {
      this._rowsBox.add_child(this.#buildRow(row, index));
    });

    this.#renderFooter();
  }

  #emptyMessage() {
    if (this._meta.brainState !== 'connected') {
      return 'The Jev brain is not running. Start it with:  systemctl --user start jev-brain';
    }
    return 'Nothing matched. Try an app name, a file, or “15% of 240”.';
  }

  #buildRow(row, index) {
    const styleClasses = ['jev-row'];
    if (index === this._selected) styleClasses.push('jev-row-selected');
    if (row.isGroup) styleClasses.push('jev-row-group');

    const box = new St.BoxLayout({
      style_class: styleClasses.join(' '),
      reactive: true,
      x_expand: true,
    });

    box.add_child(this.#iconFor(row));

    const text = new St.BoxLayout({ vertical: true, x_expand: true });
    const title = new St.Label({ text: String(row.title ?? ''), style_class: 'jev-row-title', x_align: Clutter.ActorAlign.START });
    title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    title.set_x_expand(true);
    text.add_child(title);

    if (row.detail) {
      const detail = new St.Label({ text: String(row.detail), style_class: 'jev-row-detail', x_align: Clutter.ActorAlign.START });
      detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      detail.set_x_expand(true);
      text.add_child(detail);
    }
    box.add_child(text);

    if (row.inSet) box.add_child(new St.Label({ text: '✓', style_class: 'jev-row-set-mark' }));
    if (row.ready) box.add_child(new St.Label({ text: '↵', style_class: 'jev-row-enter' }));

    box.connect('button-press-event', () => {
      this._selected = index;
      this.#refreshSelection();
      this.activate();
      return Clutter.EVENT_STOP;
    });
    box.connect('motion-event', () => {
      if (this._selected !== index) {
        this._selected = index;
        this.#refreshSelection();
      }
      return Clutter.EVENT_PROPAGATE;
    });

    return box;
  }

  #iconFor(row) {
    const fallback = () =>
      new St.Icon({ icon_name: 'application-x-executable', icon_size: ROW_ICON_SIZE, style_class: 'jev-row-icon' });

    try {
      const name = row.icon;
      if (name && typeof name === 'string' && name.startsWith('/')) {
        return new St.Icon({ gicon: Gio.icon_new_for_string(name), icon_size: ROW_ICON_SIZE, style_class: 'jev-row-icon' });
      }
      if (name && (row.icon_kind === 'named' || row.icon_kind === 'fallback')) {
        return new St.Icon({ icon_name: name, icon_size: ROW_ICON_SIZE, style_class: 'jev-row-icon' });
      }
      // Real file icons for anything with a path, the way the macOS version
      // uses Finder icons.
      if (row.path) {
        const file = Gio.File.new_for_path(row.path);
        const info = file.query_info('standard::icon', Gio.FileQueryInfoFlags.NONE, null);
        return new St.Icon({ gicon: info.get_icon(), icon_size: ROW_ICON_SIZE, style_class: 'jev-row-icon' });
      }
    } catch {
      /* fall through to the generic icon */
    }
    return fallback();
  }

  /** Cheaper than a full re-render: only the highlight changes. */
  #refreshSelection() {
    const children = this._rowsBox.get_children();
    // The first child is the empty-state label when there are no rows.
    if (this._rows.length === 0) return;

    children.forEach((child, index) => {
      if (index >= this._rows.length) return;
      if (index === this._selected) child.add_style_class_name('jev-row-selected');
      else child.remove_style_class_name('jev-row-selected');
    });

    this.#renderFooter();
  }

  #renderFooter() {
    if (!this._footerStats) return;

    // Error or confirmation, both in the slot left of the stats. A warning wins
    // if somehow both are set.
    const warning = this._meta.warning ?? '';
    const notice = warning ? '' : this._meta.notice ?? '';
    this._footerWarning.set_text(warning || notice);
    this._footerWarning.visible = Boolean(warning || notice);
    this._footerWarning.set_style_class_name(warning ? 'jev-footer-warn' : 'jev-footer-notice');

    if (this._meta.brainState !== 'connected') {
      this._footerStats.set_text(this.#brainStateText());
      this._footerStats.set_style_class_name('jev-footer-warn');
      return;
    }

    // 'local' means Jev is deliberately off; 'no-key' means it is wanted but
    // unconfigured. The old text conflated them.
    const jev = this._meta.jevConfigured;
    const mode = jev && typeof jev === 'object' ? jev.mode ?? (jev.configured ? 'jev' : 'no-key') : jev === false ? 'no-key' : 'jev';

    if (mode === 'local') {
      this._footerStats.set_text(`Local mode — instant search, no AI re-ranking (${this._rows.length} results)`);
      this._footerStats.set_style_class_name('jev-footer-label');
      return;
    }

    if (mode === 'no-key') {
      this._footerStats.set_text('Jev needs a key: add jev.apiKey to ~/.config/jev-launcher/config.json');
      this._footerStats.set_style_class_name('jev-footer-warn');
      return;
    }

    this._footerStats.set_style_class_name('jev-footer-label');

    const stats = this._meta.stats;
    const model = this._meta.jevConfigured?.model ?? 'jev-latest';

    // Running totals, whenever the brain has reported any.
    const usage = this._meta.usage;
    if (this._footerUsage) {
      if (usage) {
        const session = Number(usage.session?.costUsd ?? 0);
        const allTime = Number(usage.allTime?.costUsd ?? 0);
        this._footerUsage.set_text(
          `session $${session.toFixed(4)} · all-time $${allTime.toFixed(4)} · ${usage.allTime?.decisions ?? 0} decisions`
        );
        this._footerUsage.visible = true;
      } else {
        this._footerUsage.visible = false;
      }
    }

    if (this._meta.phase === 'jev' && stats) {
      const cost = `$${Number(stats.costUsd ?? 0).toFixed(6)}`;
      this._footerStats.set_text(`${model} · ${stats.rttMs} ms · ${stats.inputTokens ?? 0} tok · ${cost} this decision`);
      return;
    }

    if (this._meta.jevConfigured) {
      this._footerStats.set_text(`${model} is thinking…  (local results shown instantly)`);
      return;
    }

    this._footerStats.set_text('Type to search');
  }

  #brainStateText() {
    switch (this._meta.brainState) {
      case 'no-socket':
        return 'Brain socket not found — start it: systemctl --user start jev-brain';
      case 'disconnected':
        return 'Brain connection lost — retrying…';
      case 'error':
        return `Brain error: ${this._meta.brainDetail ?? 'unknown'}`;
      default:
        return 'Connecting to the Jev brain…';
    }
  }
}

export function logError(err, prefix = 'jev-launcher') {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${prefix}: ${message}`);
}

# NixCast

**A launcher for GNOME, built the NixOS way — a Spotlight-style palette over your own machine, with no account and no cloud.**

Press <kbd>Alt</kbd>+<kbd>Space</kbd> and type. NixCast answers from a local
index of your apps, files, browser history and bookmarks, and it does the small
things a launcher should: arithmetic, system toggles, opening a folder of
bookmarks in one go, running a command you configured once.

Nothing is uploaded. The brain makes no network request at any point — there is
no API key to set, no quota to watch, and no session that can expire.

<!--
When you have a screenshot, add it here and delete this comment:

<p align="center"><img src="docs/images/panel.png" alt="NixCast panel" width="720"></p>
-->

---

## What it does

| | |
|---|---|
| **Launch apps** | Every installed application, by name or by what it does |
| **Find files** | Recently used files, `~/Downloads`, `~/Desktop`, `~/Documents`, plus a live walk of any folder you add and a whole-disk name search through plocate |
| **Jump back** | Firefox and Brave history and bookmarks — including "open all 12 bookmarks in this folder" with one Enter |
| **System toggles** | Dark mode, Wi-Fi, Bluetooth, Do Not Disturb, hidden files, empty trash, sleep, lock |
| **Calculator** | `15% of 240`, `12*12`, `sqrt(2)` — the result is the top row, Enter copies it |
| **Your own commands** | Anything from `nixos-rebuild build` to a `fzf` file picker, as first-class rows |
| **Sets** | Type a folder name and Enter acts on the whole group, not one row |

Search is instant because the answer comes from an in-memory index; the wider
searches only run when the index has nothing confident to offer.

## How it works

```
   Alt+Space
       │
       ▼
  GNOME Shell extension  (extension/)      keybinding, panel, zero logic
       │   newline-delimited JSON over $XDG_RUNTIME_DIR/nixcast/brain.sock
       ▼
  NixCast brain  (brain/)                  Bun, one process, systemd --user
       ├─ index    apps · recently used · Downloads/Desktop/Documents ·
       │           Firefox/Brave history + bookmarks · system toggles
       ├─ search   fuzzy scoring · time windows · calculator · sets
       └─ exec     launch, open, toggle, run
```

Two deliberate choices:

* **A shell extension, not a window.** GNOME's compositor does not implement
  `wlr-layer-shell`, so no toolkit can anchor a window above everything else. A
  shell-owned actor is the only way to get a real always-on-top palette.
* **A sidecar process, not code in the shell.** Indexing, SQLite, fuzzy
  matching and process spawning all live in the brain. A bug there cannot take
  down your desktop, and it can be restarted without logging out.

The shell side owns nothing but a socket, a text entry and a list.

## Requirements

* GNOME Shell **45+** (Wayland or X11)
* [Bun](https://bun.sh) — `nix profile install nixpkgs#bun`
* NixOS is the tested platform: the installer, the optional Nix module and the
  drive-mounting guide assume it. Nothing in the extension or the brain is
  NixOS-specific.

Optional, both covered in [docs/nixos.md](docs/nixos.md):

* **plocate** for whole-disk name search — `services.locate.enable = true;`
* **Mounted drives** (external, NTFS, network) if you want NixCast to search them

## Install

```bash
git clone https://github.com/<you>/nixcast ~/nixcast
cd ~/nixcast
./install.sh
```

Then **log out and back in once** and press <kbd>Alt</kbd>+<kbd>Space</kbd>.

That logout is a GNOME limitation, not a shortcut: on Wayland the shell cannot
reload an extension in place, and a freshly installed extension is not scanned
until the next session. `install.sh` is idempotent — run it again after any
change.

What the installer does:

1. checks GNOME Shell and Bun, and installs the brain's dependencies
2. compiles the extension's GSettings schema (`glib-compile-schemas`)
3. symlinks `extension/` into `~/.local/share/gnome-shell/extensions/nixcast@ritam.local`
4. creates `~/.config/nixcast/config.json` at mode `600`
5. renders and starts the `nixcast-brain.service` systemd **user** unit
6. frees <kbd>Alt</kbd>+<kbd>Space</kbd> from GNOME's window-menu binding

Useful flags: `./install.sh --dry-run` prints every step and changes nothing;
`./install.sh --skip-keybinding` leaves GNOME's shortcut alone.

Check it without logging out:

```bash
gnome-extensions info nixcast@ritam.local
systemctl --user status nixcast-brain
cd ~/nixcast/brain && bun run src/index.js --check   # index counts, roots, plocate
```

To remove it: `./uninstall.sh` (`--keep-config` to keep your settings,
`--restore-hotkey` to give <kbd>Alt</kbd>+<kbd>Space</kbd> back to GNOME).

## Using it

| Key | |
|---|---|
| <kbd>Alt</kbd>+<kbd>Space</kbd> | open or close the panel |
| <kbd>↑</kbd> / <kbd>↓</kbd> | move the selection (or <kbd>PgUp</kbd>/<kbd>PgDn</kbd> by five) |
| <kbd>Enter</kbd> | run the selected row — a green `↵` means the top row is what you typed |
| <kbd>Esc</kbd> | close |

A `✓` marks rows that are part of a **set** (a named folder, "all", or a time
window). With a set row selected, Enter acts on every member: opening the
bookmarks inside a folder, for instance.

Typing a phrase with a time window works too — `the pdf I opened today`,
`files from this morning`.

## Configuration

One file, `~/.config/nixcast/config.json`, merged over the defaults. It holds no
secrets; mode `600` keeps your folder paths private.

```jsonc
{
  "search": {
    "maxCandidates": 13,        // rows scored before display
    "maxCandidatesWithWindow": 30,
    "maxRows": 7                // rows shown
  },
  "index": {
    "maxPerFolder": 400,
    "nestedDepth": 1,
    "historyDays": 90,          // browser history window
    "historyRows": 3000,
    "browsers": ["firefox", "brave", "chrome", "chromium", "edge", "vivaldi"],
    "refreshMs": 120000,        // how often the index rebuilds itself

    // Folders walked on demand instead of indexed up front. This is where an
    // external drive, a photo library or a project tree belongs.
    "searchRoots": [],

    // Whole-disk name search, when the index has nothing confident.
    "plocate": {
      "enabled": true, "timeoutMs": 400, "maxResults": 10,
      "minQueryLength": 3, "strongMatch": 0.85, "noisyPenalty": 0.35
    },

    // On-demand walk of searchRoots, same gate as plocate.
    "liveWalk": {
      "enabled": true, "timeoutMs": 120, "maxDepth": 6, "maxResults": 8,
      "minQueryLength": 3, "maxEntries": 20000, "strongMatch": 0.85
    }
  },

  // Each toggle below becomes a row. Remove one to take it out of the list.
  "toggles": [
    { "id": "dark-mode", "title": "Toggle Dark Mode", "keywords": "theme appearance night light dark" }
  ],

  // Your own commands, shown as rows.
  "actions": [
    {
      "id": "nixos-rebuild",
      "title": "Rebuild NixOS",
      "keywords": "nixos rebuild switch config",
      "command": ["nixos-rebuild", "build"],
      "terminal": true,
      "description": "nixos-rebuild build (does not touch the running system)"
    }
  ],

  // Which terminal `"terminal": true` actions open in. Empty picks one.
  "ui": { "terminal": "" }
}
```

`config/config.example.json` is the same file with every key present.

### How a search is decided

1. the phrase's time window is parsed out (`today`, `this morning`, `last week`)
2. the in-memory index is fuzzy-scored — apps, recently used files, indexed
   folders, history, bookmarks, toggles, actions
3. **only if nothing scored confidently** does the wider search run: a live walk
   of `index.searchRoots`, then plocate's whole-disk database
4. confidence and set membership are decided, and the panel is drawn

That gate is why typing stays instant: a whole-disk lookup never runs while the
index already has a good answer.

### Changing the shortcut

GNOME Settings → Keyboard → *View and Customize Shortcuts* → **Custom
Shortcuts**, or from a terminal — use `dconf`, not `gsettings`:

```bash
dconf write /org/gnome/shell/extensions/nixcast/toggle-launcher "['<Super>Return']"
```

`gsettings get org.gnome.shell.extensions.nixcast …` fails with *"No such
schema"* because the extension's schema lives in the extension directory, not in
the system's schema path. `dconf` does not care.

### Environment overrides

Handy for testing without editing the file:

| Variable | Effect |
|---|---|
| `NIXCAST_SOCKET` | use a different socket path |
| `NIXCAST_DISABLE_WALK` | `1` turns the live walk off |
| `NIXCAST_LOG_LEVEL` | `debug`, `info` (default), `warn`, `error` |

## Design notes

* **Names, not contents.** File search matches paths. plocate knows what its
  database last saw, which is why the live walk exists for drives that come and
  go; run `sudo systemctl start update-locatedb` after plugging a drive in.
* **Ranking is deterministic.** Fuzzy scores, word-prefix tiers and a small
  set of bonuses decide order — no model, so the same query always gives the
  same answer, and the green `↵` means something you can reason about.
* **The index is the fast path.** Anything outside it is found by the walk or
  plocate, so adding a folder to `searchRoots` costs nothing until it is
  searched.
* **Build artefacts are ranked down, not hidden.** `node_modules`, `.git`,
  package caches and recycle bins are marked, so a name search finds your
  document before a dependency's theme file.

## Development

```bash
cd brain
bun test                              # 75 tests, no network, no GUI
bun run src/index.js --check          # what the launcher sees on this machine
bun run src/index.js --reindex        # rebuild the index and print the counts
bun run src/tools/ask.js --explain "dark"   # what would be shown, and why
bun run src/tools/socket-client.js "dark"   # talk to the running brain directly
systemctl --user restart nixcast-brain      # pick up brain edits
```

The brain reloads with a service restart. The **extension** does not: GNOME
cannot reload it in place, so extension changes need a logout. Worth knowing
before you wonder why an edit did nothing — see
[docs/troubleshooting.md](docs/troubleshooting.md).

Layout:

```
brain/       Bun process: index, search, exec, socket server
  src/common     config, paths, logging
  src/modules    index/ · search/ · exec/ · server/
  src/tools      ask.js, socket-client.js — development aids
  test/          75 tests: scoring, sets, windows, parsers, indexers
extension/   GNOME Shell 45+ extension (ESM)
  lib/panel.js       the St overlay
  lib/brain-client.js socket, framing, reconnect
config/      example config and the systemd unit template
nix/         optional NixOS module
docs/        nixos.md, troubleshooting.md
```

## Credits and prior art

NixCast started from [dabit3/jev-experiments →
`jev-launcher`](https://github.com/dabit3/jev-experiments/tree/main/jev-launcher),
the macOS original, and was ported to NixOS + GNOME with
[TypeSafe's Jev](https://docs.typesafe.ai) judging the ranking. That AI layer
was later removed on purpose: for a launcher, deterministic local scoring turned
out to be faster to reason about, free, and — for the queries that matter —
just as good. The protocol shape, the panel behaviour and the set idea all come
from that lineage.

Inspiration, obviously: Spotlight and [Raycast](https://raycast.com).

Built and used daily on NixOS with GNOME 49 on Wayland.

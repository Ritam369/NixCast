# Troubleshooting

Two logs cover almost everything:

```bash
# the extension, inside gnome-shell — JS errors, panel problems
journalctl --user -f -o cat | grep -i nixcast

# the brain — index counts, executor results
journalctl --user -fu nixcast-brain

# or run the brain in the foreground to see everything live
systemctl --user stop nixcast-brain
cd ~/nixcast/brain && NIXCAST_LOG_LEVEL=debug bun run src/index.js
```

`bun run src/index.js --check` answers most setup questions in one command: the
config file in use, the socket, which folders are indexed, every `searchRoots`
entry (present or missing), whether plocate is installed, and the browsers found.

---

## Alt+Space does nothing

1. Is the extension loaded at all?
   ```bash
   gnome-extensions info nixcast@ritam.local
   ```
   `State: ENABLED` is what you want. `State: ERROR` means the shell rejected the
   JS — check the first log above.

2. Did you log out and back in after installing? On Wayland the shell cannot
   load an extension into a running session, and `gnome-extensions enable`
   reports success even when the running shell has never seen the files.

3. Is GNOME still holding the key?
   ```bash
   gsettings get org.gnome.desktop.wm.keybindings activate-window-menu
   ```
   It must print `@as []`. If it prints `['<Alt>space']`, re-run `install.sh`
   or set it yourself:
   ```bash
   gsettings set org.gnome.desktop.wm.keybindings activate-window-menu '[]'
   ```
   Mutter's window-menu grab beats a shell extension's keybinding, so this is
   not optional.

4. Another app may have grabbed it (some IDEs and browsers do). Try another
   combination — use `dconf`, not `gsettings`: an extension's schema is not in
   the session-wide schema source, so `gsettings` fails with "No such schema"
   even while the extension is running. `dconf` writes the key directly and the
   shell reacts immediately.
   ```bash
   dconf write /org/gnome/shell/extensions/nixcast/toggle-launcher "['<Super>Return']"
   ```

The shortcut also appears in **Settings → Keyboard → Customise Shortcuts**.

---

## The panel opens but says "Brain socket not found"

The extension is fine; the brain is not running.

```bash
systemctl --user status nixcast-brain
systemctl --user start nixcast-brain
```

If it fails immediately, run it in the foreground (commands above) and read the
error. The usual causes:

- **`bun` moved.** The unit pins an absolute path. If it pointed into
  `/nix/store` and a GC ran, re-run `install.sh` after
  `nix profile install nixpkgs#bun`.
- **`error: Cannot find module './x.js'`** — a file was moved or an import path
  is wrong. `bun run src/index.js --check` reproduces it quickly.
- **Socket permission.** The socket must be `0600` and owned by you:
  ```bash
  ls -l $XDG_RUNTIME_DIR/nixcast/brain.sock
  ```

---

## The panel opens, rows appear, but there is no green ↵

The green `↵` means one specific thing: **every word you typed appears in the top
row** (with word-prefix stemming, so `books` matches `bookmarks`). It is a
deliberate, deterministic rule:

- queries shorter than three characters are never "confident" — a two-letter
  prefix really is ambiguous
- a **set row** and a **calculator result** are confident by construction
- a row found only by the live walk or plocate can still win on score without
  being confident

To see what was scored and why:

```bash
cd ~/nixcast/brain
bun run src/tools/ask.js --explain "the pdf I just downloaded"
```

---

## "Nothing matched" for something that clearly exists

Check what the index actually holds:

```bash
cd ~/nixcast/brain
bun run src/index.js --reindex
```

The output lists counts per provider. If a provider is `0`:

- **`history: 0`** — no readable browser profile. This port reads Firefox
  (`~/.mozilla/firefox/*/places.sqlite`) and the Chromium family
  (`~/.config/{BraveSoftware/Brave-Browser,google-chrome,chromium}/…/History`).
  Profile directories are copied before reading, because the browser holds the
  file locked while it runs; a copy only misses the last few seconds of
  history. If your browser is not in the list, add its id to `index.browsers`.
- **`apps: 0`** — no `.desktop` files found on the XDG paths. On NixOS the
  system entries are in `/run/current-system/sw/share/applications`, which the
  brain always checks.
- **`files: 0`** — `index.downloadsDir` / `index.extraDirs` point somewhere
  empty. Only the configured folders plus one nested level are indexed, with a
  per-folder cap of `index.maxPerFolder`.

`NoDisplay=true` entries (GNOME's own settings panels, mime handlers) are
deliberately skipped — 121 `.desktop` files on a stock GNOME install reduce to
about 61 launchable apps.

**A file on another drive?** That is what `index.searchRoots` and plocate are
for; both are covered in [nixos.md](nixos.md). Two things to check first:

```bash
cd ~/nixcast/brain && bun run src/index.js --check   # is the root present?
```

- a root that is not mounted is skipped silently by design — so a drive that was
  unplugged looks exactly like one that was never configured
- plocate only knows what existed when its database was last built:
  `sudo systemctl start update-locatedb`

---

## The panel says "Building the index…" and stays that way

The brain serves the socket before the index finishes, so the launcher is usable
almost immediately — but the footer keeps saying this until counts arrive. If it
persists, the index is failing:

```bash
journalctl --user -fu nixcast-brain
cd ~/nixcast/brain && bun run src/index.js --reindex
```

A browser database that cannot be copied, or a `searchRoots` path with a typo, is
reported there. Neither prevents the rest of the index from working.

---

## A toggle fails: Bluetooth, Wi-Fi, dark mode

Toggles are ordinary commands, and each one can fail for its own reason. The
panel shows the message the command returned.

- **Bluetooth** — `bluetoothctl power on` fails with `org.bluez.Error.Failed`
  while the adapter is soft-blocked. GNOME's own airplane-mode flag
  (`org.gnome.SettingsDaemon.Rfkill.BluetoothAirplaneMode`) is usually what
  blocks it. Check with `rfkill list`, clear it with `rfkill unblock bluetooth`
  (or turn Airplane Mode off in the system menu), then try again.
- **Wi-Fi** — needs NetworkManager; `nmcli radio wifi off/on` is what runs.
- **Dark mode** — writes the `color-scheme` key; if the desktop does not follow
  it, your theme is overriding it.
- A toggle that hangs is bounded by a timeout, so one stuck command cannot empty
  the toggle list — the others stay usable.

---

## The extension will not load after an edit

Wayland again: log out and back in. Before you do, parse-check the files so the
relogin is not wasted:

```bash
cd ~/nixcast
for f in extension/extension.js extension/lib/*.js; do
  cp "$f" "/tmp/$(basename "$f").mjs" && node --check "/tmp/$(basename "$f").mjs" || echo "FAILED: $f"
done
```

(The `.mjs` copy matters: without it `node --check` reads the file as CommonJS
and every `import` is an error.)

If the shell reports a schema error (`Settings schema ... is not installed`),
the compiled schema is stale or missing — `install.sh` compiles it, so re-run it:

```bash
./install.sh --skip-keybinding
```

If `glib-compile-schemas` cannot be found, run the installer with glib available:

```bash
nix shell nixpkgs#glib -c ./install.sh
```

---

## Executing a row does nothing

Run the brain in the foreground and press Enter; the executor logs every action.

- **Apps** are launched with `gio launch <file>.desktop`, falling back to the
  `Exec=` line. The `Exec=` fallback also runs if the desktop file is not
  registered in your session's `XDG_DATA_DIRS`.
- **Files and URLs** go to `xdg-open`.
- **Toggles** use `gsettings`, `nmcli radio wifi`, `systemctl suspend`,
  `loginctl lock-session` and `gio trash --empty`. All of them are allowed for
  an active session user; none need root.
- **`run_action`** runs the `command` array directly, or in a terminal when the
  action sets `"terminal": true` (`ui.terminal` picks which one).

If a row reports `unknown row`, the panel sent an id the brain no longer holds —
press a key and try again; the brain caches ids per connection.

---

## Resetting everything

```bash
cd ~/nixcast
./uninstall.sh --restore-hotkey        # add --keep-config to keep your settings
./install.sh
```

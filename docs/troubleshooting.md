# Troubleshooting

Two logs cover almost everything:

```fish
# the extension, inside gnome-shell — JS errors, panel problems
journalctl --user -f -o cat | grep -i jev

# the brain — index counts, Jev round trips, executor results
journalctl --user -fu jev-brain

# or run the brain in the foreground to see everything live
systemctl --user stop jev-brain
cd ~/jev-launcher-nixos/brain; JEV_LOG_LEVEL=debug bun run src/index.js
```

---

## Alt+Space does nothing

1. Is the extension loaded at all?
   ```fish
   gnome-extensions info jev-launcher@ritam.local
   ```
   `State: ENABLED` is what you want. `State: ERROR` means the shell rejected the
   JS — check the first log above.

2. Did you log out and back in after installing? On Wayland the shell cannot
   load an extension into a running session, and `gnome-extensions enable`
   reports success even when the running shell has never seen the files.

3. Is GNOME still holding the key?
   ```fish
   gsettings get org.gnome.desktop.wm.keybindings activate-window-menu
   ```
   It must print `@as []`. If it prints `['<Alt>space']`, re-run `install.sh`
   or set it yourself:
   ```fish
   gsettings set org.gnome.desktop.wm.keybindings activate-window-menu '[]'
   ```
   Mutter's window-menu grab beats a shell extension's keybinding, so this is
   not optional.

4. Another app may have grabbed it (some IDEs and browsers do). Try another
   combination — use `dconf`, not `gsettings`: an extension's schema is not in
   the session-wide schema source, so `gsettings` fails with "No such schema"
   even while the extension is running. `dconf` writes the key directly and the
   shell reacts immediately.
   ```fish
   dconf write /org/gnome/shell/extensions/jev-launcher/toggle-launcher "['<Super>Return']"
   ```

The shortcut also appears in **Settings → Keyboard → Customise Shortcuts**.

---

## The panel opens but says "Brain socket not found"

The extension is fine; the brain is not running.

```fish
systemctl --user status jev-brain
systemctl --user start jev-brain
```

If it fails immediately, run it in the foreground (command above) and read the
error. The usual causes:

- **`bun` moved.** The unit pins an absolute path. If it pointed into
  `/nix/store` and a GC ran, re-run `install.sh` after
  `nix profile install nixpkgs#bun`.
- **`error: Cannot find module './x.js'`** — a file was moved or an import path
  is wrong. `bun run src/index.js --check` reproduces it quickly.
- **Socket permission.** The socket must be `0600` and owned by you:
  ```fish
  ls -l $XDG_RUNTIME_DIR/jev-launcher/brain.sock
  ```

---

## The panel opens, rows appear, but there is no green ↵

That is `ready` staying below threshold, which is Jev working as intended for
ambiguous input — a two-letter prefix really is ambiguous. If it never turns
green even for obvious queries, check that Jev is answering at all:

```fish
cd ~/jev-launcher-nixos/brain
bun run src/tools/ask.js --explain "the pdf I just downloaded"
```

The footer in the panel shows the model, the round trip and the token count for
the last decision, so it also tells you whether the request left the machine.

Once you see real answers, tune `thresholds.ready` (lower is more eager) or
`weights.target` in the config.

---

## A `401`, `403`, `429` or `529` from Jev

First, orient yourself — the error text tells you which transport answered.

- `transport: gateway` means the call went to Vercel's AI Gateway with the AI
  SDK. A bad key there answers verbatim:
  `{"error":{"message":"Authentication failed. Create an API key and set in
  AI_GATEWAY_API_KEY environment variable…","type":"authentication_error"}}`.
  The key must be an **AI Gateway** key, and the AI Gateway product has to be
  enabled for your Vercel account/team.
- `transport: direct` means TypeSafe's own API, which wants a **TypeSafe** key.

```fish
bun run src/index.js --check
```

- `401` / `403` — the key is missing, wrong, or the request is not reaching
  `api.typesafe.ai` (a gateway with a different path or auth header needs
  `jev.baseUrl`, `jev.path` and `jev.extraHeaders` in the config).
- `429` / `529` — rate limited or overloaded. The client already retries once
  with backoff; raise `jev.maxRetries`, or raise `jev.debounceMs` so fewer
  requests go out.
- Requests take ~3–9× longer than the Mac app's published numbers if you are
  far from the API region. That is physics, not a misconfiguration.

The footer's cost figure is computed from `usage.input_tokens` at TypeSafe's
`$0.042` per million input tokens. A per-keystroke decision is around
`$0.00006`, so a long session costs a fraction of a cent.

---

## "Nothing matched" for something that clearly exists

Check what the index actually holds:

```fish
cd ~/jev-launcher-nixos/brain
bun run src/index.js --reindex
```

The output lists counts per provider. If a provider is `0`:

- **`history: 0`** — no readable browser profile. This port reads Firefox
  (`~/.mozilla/firefox/*/places.sqlite`) and the Chromium family
  (`~/.config/{BraveSoftware/Brave-Browser,google-chrome,chromium}/…/History`).
  Profile directories are copied before reading, because the browser holds the
  file locked while it runs; a copy only misses the last few seconds of
  history. If your browser is not in the list, add its id to
  `index.browsers`.
- **`apps: 0`** — no `.desktop` files found on the XDG paths. On NixOS the
  system entries are in `/run/current-system/sw/share/applications`, which the
  brain always checks.
- **`files: 0`** — `index.downloadsDir` / `index.extraDirs` point somewhere
  empty. Only the configured folders plus one nested level are indexed, with a
  per-folder cap of `index.maxPerFolder`.

Note that `NoDisplay=true` entries (GNOME's own settings panels, mime handlers)
are deliberately skipped — 121 `.desktop` files on a stock GNOME install reduce
to about 61 launchable apps.

---

## The extension will not load after an edit

Wayland again: log out and back in. Before you do, parse-check the files so the
relogin is not wasted:

```fish
cd ~/jev-launcher-nixos
for f in extension/extension.js extension/lib/*.js; do node --check "$f"; done
```

If the shell reports a schema error (`Settings schema ... is not installed`),
the compiled schema is stale or missing:

```fish
find /nix/store -maxdepth 3 -name glib-compile-schemas | head -1
# then run it against the extension's schema directory
<the path above> --strict ~/jev-launcher-nixos/extension/schemas
```

`install.sh` does this for you, and falls back to the committed
`extension/schemas/gschemas.compiled`.

---

## Executing a row does nothing

Run the brain in the foreground and press Enter; the executor logs every action.

- **Apps** are launched with `gio launch <file>.desktop`, falling back to the
  `Exec=` line. The `Exec=` fallback also runs if the desktop file is not
  registered in your session's `XDG_DATA_DIRS`.
- **Files and URLs** go to `xdg-open`.
- **Toggles** use `gsettings`, `nmcli radio wifi`, `systemctl suspend`,
  `loginctl lock-session` and `gio trash --empty`. All of them are allowed for
  an active session user; none need root. A toggle that fails because
  NetworkManager is not running will say so in the panel.
- **`run_action`** runs the `command` array directly, or in a terminal when the
  action sets `"terminal": true`.

---

## Resetting everything

```fish
cd ~/jev-launcher-nixos
./uninstall.sh --restore-hotkey        # add --keep-config to keep the key
./install.sh
```

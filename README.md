# Jev Launcher for NixOS

A Spotlight-style launcher for **GNOME on Wayland** whose ranking and
Enter-readiness are decided by [Jev](https://docs.typesafe.ai) — TypeSafe's
`System One` model. It is a Linux port of the macOS
[`jev-launcher`](https://github.com/dabit3/jev-experiments/tree/main/jev-launcher)
by dabit3/Devin: press a hotkey, type naturally, and the list re-ranks because
Jev answered *which row you mean*, *what to do with it*, and *whether pressing
Enter is safe yet*.

```
Alt+Space →  "the pdf I just downloaded"  →  1. Q3-Roadmap-Review.pdf   ⌘↵
             "wifi off"                   →  1. Turn Wi-Fi Off          ⌘↵
             "15% of 240"                 →  1. = 36                    ⌘↵
             "links I visited today"      →  1. Open all 6 links        ⌘↵
```

---

## 1. Why this is not a copy-paste of the Mac app

The Jev API is plain HTTPS + JSON, so the model half ports unchanged. The
macOS shell half does not: it is built from AppKit, Carbon hotkeys, AppleScript
and `NSWorkspace`.

| macOS launcher | This port |
| --- | --- |
| Jev request, questions, ranking maths | **identical** (ported to JS verbatim) |
| Fuzzy prefilter, calculator, time-window parser | **identical** (ported) |
| `~/.local/share/recently-used.xbel` | **new** — Linux-only, better than mtime for "just downloaded" |
| Chrome history (`ChromeHistory.swift`) | **Firefox `places.sqlite` + Chromium-family `History`** |
| `NSWorkspace.open` | `xdg-open` / `gio launch` |
| AppleScript Dark Mode, `networksetup` Wi-Fi | `gsettings` colour-scheme, `nmcli radio wifi` |
| `shortcuts list` / `run_shortcut` | **no equivalent** — custom `actions` in the config |
| ⌥Space via Carbon `RegisterEventHotKey` | GNOME keybinding via `Main.wm.addKeybinding`, **Alt+Space rebound** |
| `NSVisualEffectView` HUD, always-on-top | shell-owned `St` actor + modal grab (see §2) |
| 58 XCTest cases | `bun test` (calculator, fuzzy, time windows, ranking, questions) |

### Three honest differences from the Mac version

1. **Latency.** The original is designed around a ~100 ms round trip measured
   from a US VM, and fires a request on *every keystroke with no debounce*.
   From India a warm connection measured **~270–380 ms** and a cold one
   **~760–900 ms** on this machine. Two consequences, both implemented:
   a persistent warm connection, and a ~180 ms debounce in the *brain*, while
   the fuzzy order is still shown instantly on every keystroke.
2. **No layer-shell.** Mutter does not implement `zwlr_layer_shell_v1`, so
   `gtk-layer-shell`/`gtk4-layer-shell` do not work on stock GNOME and no
   external app can anchor itself to a screen edge or float above other
   windows. A GNOME Shell extension is the *only* way to get a real HUD on
   GNOME, which is why this is an extension rather than a GTK/Electron app.
   In exchange you get `blur-my-shell` support for free if you have it.
3. **`run_shortcut` has no Linux equivalent.** Apple Shortcuts is replaced by
   a list of `actions` in the config file.

---

## 2. Architecture

```
┌─ gnome-shell (your session) ────────────────────────────┐
│  extension.js                                           │
│    Main.wm.addKeybinding  ── Alt+Space ──► panel.toggle()│
│    lib/panel.js   St overlay + St.Entry + modal grab     │
│    lib/brain-client.js   NDJSON over a unix socket       │
└───────────────────────────┬─────────────────────────────┘
                            │  $XDG_RUNTIME_DIR/jev-launcher/brain.sock
                            │  (mode 0600, no TCP port)
┌───────────────────────────▼─────────────────────────────┐
│  bun brain  (systemd --user: jev-brain.service)          │
│   modules/index    apps · files · recently-used ·         │
│                    browser history · toggles · actions    │
│   modules/search   fuzzy · calculator · time-window ·     │
│                    ranker · engine                        │
│   modules/jev      client (warm fetch, retries, cost) ·   │
│                    questions (the typed-questions payload)│
│   modules/exec     executor  ← the only thing that acts   │
└───────────────────────────┬─────────────────────────────┘
                            │  one POST per keystroke (debounced)
                            ▼
                 https://api.typesafe.ai/v1/systemone
```

Putting the brain in its own process is deliberate. GNOME Shell extensions run
*inside* the shell: a crash or a slow call there takes the desktop with it.
Here the shell only draws rows — a hung HTTP request cannot freeze your session.

**Why two result phases.** Every keystroke gets two messages back:

1. `phase: "local"` — the fuzzy order, sent **before any network work**. This is
   what you see while typing.
2. `phase: "jev"` — the same rows after Jev's answer lands, with the group row,
   the `✓` set marks, and the green `↵`.

Each keystroke carries a sequence number; a late answer for an older keystroke
is discarded. That is the macOS launcher's "newest answer wins" rule, kept.

---

## 3. What Jev is actually asked

One request per (debounced) keystroke. `state` is what your code decided; the
`questions` are the judgements. Jev never writes prose — it picks from what your
code offered.

The `model` and the yes/no question type depend on the transport (§6): the
AI Gateway route sends `typesafe-ai/jev` and calls the primitive `boolean`,
while TypeSafe's own API sends `jev-latest` and calls it `noul`. Everything else
in this payload is identical for both.

```json
{
  "model": "jev-latest",
  "state": {
    "query": "the pdf I",
    "query_note": "Text the user has typed so far into a Spotlight-style launcher on Linux (GNOME)…",
    "context": { "frontmost_app": "firefox", "time_of_day": "afternoon", "weekday": "Sunday" },
    "time_window": null,
    "candidates": [
      { "id": "c0", "kind": "open_file", "title": "Q3-Roadmap-Review.pdf",
        "detail": "Recent · opened 16 min ago" }
    ],
    "synthetic_candidates": [
      { "id": "c1", "kind": "web_search", "title": "Search the web for “the pdf I”", "…": "…" }
    ]
  },
  "questions": {
    "target":   { "type": "choice", "criteria": { "c0": "…", "c1": "…", "none": "…" } },
    "action":   { "type": "choice", "criteria": { "open_file": "…", "web_search": "…", "…": "…" } },
    "ready":    { "type": "noul" },
    "scope":    { "type": "choice", "criteria": { "one": "…", "all": "…" } },
    "match_c0": { "type": "noul" }
  }
}
```

- `target` — which candidate the user means (or `none`)
- `action` — what Enter should do: `open_app`, `open_file`, `open_url`,
  `web_search`, `calculate`, `system_toggle`, `run_action`, `unclear`
- `ready` — *is the intent settled enough to offer Enter?* → the green `↵`
- `scope` — one item, or the whole set
- `match_cN` — one per real candidate, used for set membership (`✓` and
  "Open all 6 links"). This is TypeSafe's documented rerank pattern.

Code keeps control of every threshold. `score = 0.65·P(target) +
0.20·P(action matches kind) + 0.15·fuzzy`, plus `0.25·P(all)·P(match)` for set
members. All weights and thresholds live in the config.

**See the exact payload for any query without typing:**

```fish
cd ~/jev-launcher-nixos/brain
bun run src/tools/ask.js --explain "links I visited today"
```

---

## 4. Requirements

- NixOS with **GNOME Shell 45+ on Wayland** (tested on NixOS 25.11 / GNOME 49.2)
- **Bun 1.1+** — its built-in `bun:sqlite` reads browser history, so `sqlite3`
  is *not* needed
- A **TypeSafe API key** — see §6
- About 40 MB of RAM for the brain (it is a JS runtime; there is no Rust or C)

---

## 5. Install

```fish
cd ~/jev-launcher-nixos
./install.sh --dry-run          # see exactly what it will touch
./install.sh
```

The installer, in order:

1. checks GNOME Shell ≥ 45 and refuses to run as root
2. resolves `bun` and warns if it lives in `/nix/store` (GC would break it)
3. compiles `extension/schemas/*.gschema.xml`, falling back to the
   pre-compiled `gschemas.compiled` that ships with the repo
4. symlinks `extension/` into `~/.local/share/gnome-shell/extensions/jev-launcher@ritam.local`
5. creates `~/.config/jev-launcher/config.json` at mode `600`
6. renders and starts the `jev-brain.service` systemd **user** unit
7. **unbinds GNOME's Alt+Space** (`activate-window-menu`) — see §7
8. enables the extension

Then **log out and back in once**. GNOME on Wayland cannot reload an extension
in place; this is the one step that cannot be automated and the one thing the
installer cannot check for you.

Verify:

```fish
gnome-extensions info jev-launcher@ritam.local
systemctl --user status jev-brain
journalctl --user -f -o cat | grep -i jev      # extension log while you use it
```

---

## 6. Your API key

Two transports are supported, and the key you hold decides which:

| `jev.transport` | Model | Key | Where the call goes |
| --- | --- | --- | --- |
| **`gateway`** (default) | `typesafe-ai/jev` | Vercel **AI Gateway** key (`AI_GATEWAY_API_KEY`) | `ai-gateway.vercel.sh`, via the AI SDK's `experimental_evaluate` |
| `direct` | `jev-latest` | TypeSafe key (`TYPESAFE_API_KEY`) | `api.typesafe.ai/v1/systemone` |
| `off` | — | — | never calls out; fuzzy-only |

The gateway route is what this repo is built and tested against:

```js
import { experimental_evaluate as evaluate } from 'ai';

const result = await evaluate({
  model: 'typesafe-ai/jev',
  state: 'The support agent issued a full refund to the customer.',
  questions: { refunded: { type: 'boolean', instructions: 'Was a refund issued?' } },
  providerOptions: { gateway: { zeroDataRetention: false } },
});

console.log(result.answers.refunded); // { type: 'boolean', probability: 0.99 }
```

Two details of that route are worth knowing, because they are the only things
that differ from TypeSafe's own API: the AI SDK names the yes/no primitive
`boolean` and returns `{ probability }`, where TypeSafe says `noul` and returns
`{ noul }`. `brain/src/modules/jev/answers.js` is the single place that
translation happens, so the ranker cannot tell the transports apart, and an
answer shape this build does not recognise **throws with the payload in the
message** rather than silently scoring zero.

`zeroDataRetention` defaults to **`false`**, and that default is deliberate: the
gateway *rejects the entire request* on plans that do not include ZDR — verbatim
`"Zero Data Retention (ZDR) is only available for Pro and Enterprise plans.
Current plan: hobby."` — which presents as a launcher that never ranks. Turn it on
only if your plan supports it and you want the guarantee. Worth knowing when you
weigh it: every keystroke sends your typed text plus candidate titles and detail
lines, including page titles from your browsing history, which is the most
personal payload this system produces.

The key lives in exactly one place, and it is **not** the Nix store (everything
in `/nix/store` is world-readable, so a key in `configuration.nix` is public to
every user and every process on the machine):

```fish
$EDITOR ~/.config/jev-launcher/config.json     # already chmod 600
```

```json
"jev": {
  "transport": "gateway",
  "apiKey": "<your Vercel AI Gateway key>",
  "model": "typesafe-ai/jev",
  "zeroDataRetention": false
}
```

Environment variables override the file: `JEV_API_KEY`, `AI_GATEWAY_API_KEY`,
`TYPESAFE_API_KEY`, `JEV_TRANSPORT`, `JEV_MODEL`, `JEV_GATEWAY_BASE_URL`,
`JEV_BASE_URL`, `JEV_DISABLE=1`. The service also reads an optional
`~/.config/jev-launcher/env` (`chmod 600`) if you would rather keep the secret
out of the JSON — see `EnvironmentFile` in `config/jev-brain.service.in`.

**Prove the whole path with one command.** It sends a single two-question
evaluation and prints both the normalized and the raw answers, so a renamed field
surfaces immediately instead of as a launcher that quietly ranks nothing. The
sample output below is illustrative — your round trip and probabilities will
differ:

```fish
cd ~/jev-launcher-nixos/brain
bun run src/index.js --check
```

```
transport        : gateway
model            : typesafe-ai/jev
...
sending one two-question evaluation to prove the whole path...
  round trip     : 812 ms
  normalized     : {"refunded":{"type":"noul","noul":0.99},"ready":{"type":"noul","noul":0.98}}
raw answer shapes (confirm the fields this build reads):
{
  "refunded": { "type": "boolean", "probability": 0.99 },
  "ready":    { "type": "boolean", "probability": 0.98 }
}
```

With **no key at all** the launcher still works: apps, files, recently-used,
calculator and every toggle are local. Only the re-ranking and the green `↵`
need Jev, and the footer says so.

---

## 7. The hotkey

Alt+Space is what the Mac app uses (⌥Space). On GNOME that combination is
already taken by `activate-window-menu`, and Mutter wins the race, so the
installer unbinds it:

```fish
gsettings set org.gnome.desktop.wm.keybindings activate-window-menu '[]'
```

Change the launcher's shortcut in **Settings → Keyboard → View and Customise
Shortcuts → Jev Launcher**. From a terminal use `dconf`, *not* `gsettings`:

```fish
dconf write /org/gnome/shell/extensions/jev-launcher/toggle-launcher "['<Super>Return']"
```

`gsettings` cannot see this key: an extension's schema lives in its own directory
and gnome-shell adds it to a private schema source at load time, so
`gsettings get/set org.gnome.shell.extensions.jev-launcher …` fails with *"No such
schema"* even while the extension is running and working. `dconf` writes the path
directly and the shell picks the change up immediately, which is why it is the
fallback here.

To give Alt+Space back to GNOME: `./uninstall.sh --restore-hotkey`.

---

## 8. Living with NixOS

**Nothing about the launcher requires a system rebuild.** It lives in your home
directory and runs as a user service. You only touch `configuration.nix` if you
want the declarative version.

Optional module, `nix/jev-launcher.nix` — packages, the freed hotkey and the
brain service, all declared:

```nix
# configuration.nix
imports = [ ./jev-launcher-nixos/nix/jev-launcher.nix ];

services.jev-launcher = {
  enable = true;
  user = "ritam";
  repoDir = "/home/ritam/jev-launcher-nixos";
};
```

then the usual privileged step:

```fish
sudo nixos-rebuild switch
```

Notes for the NixOS-minded:

- **`glib-compile-schemas` is in glib's `dev` output** on nixpkgs, not `bin`.
  The installer searches `/nix/store` for it and falls back to the committed
  `gschemas.compiled`, so a plain `install.sh` works with no extra packages.
  Add `pkgs.glib.dev` if you want schema recompiles on every install.
- **Do not add `bun` to `environment.systemPackages` and then let it be
  collected** — the systemd unit pins the resolved path. `nix profile install
  nixpkgs#bun` gives a stable path.
- The system-wide extension route (a derivation dropping files into
  `$out/share/gnome-shell/extensions/`) is possible; this repo ships the
  per-user symlink instead because it is what the dev loop needs.

---

## 9. Configuring behaviour

Everything in `~/.config/jev-launcher/config.json` is merged over the defaults,
so you only write what you change.

| Key | What it does |
| --- | --- |
| `jev.debounceMs` | how long to wait after the last keystroke before asking Jev |
| `jev.model` | `jev-latest` (alias) or a pinned id like `jev-1.13.0` |
| `search.maxCandidates` | rows sent to Jev (13 by default, 30 with a time window) |
| `search.maxRows` | rows drawn in the panel |
| `thresholds.ready` | how confident Jev must be before `↵` turns green |
| `index.historyDays` / `historyRows` | how much browser history to read |
| `index.extraDirs` | folders to index (default `~/Desktop`, `~/Documents`) |
| `weights.*` | the ranking formula |

Custom actions replace macOS Shortcuts. They become searchable rows:

```json
"actions": [
  { "id": "suspend-vms", "title": "Stop all libvirt VMs",
    "keywords": "libvirt kvm vm",
    "command": ["sh", "-lc", "for d in $(virsh list --name); do virsh destroy $d; done"],
    "terminal": true }
]
```

Values are passed as an argv array. Nothing is interpolated into a shell
command line by the launcher itself; if you want a shell, ask for one
explicitly as above.

---

## 10. Development

The brain is the happy place to work: it runs outside the shell and restarts in
about 200 ms.

```fish
cd ~/jev-launcher-nixos/brain
bun test                                  # unit tests, no network
bun run src/index.js --reindex            # print index counts
bun run src/tools/ask.js --explain "dark" # local + Jev ranking, no GUI
bun run src/tools/ask.js --no-jev "12*12"
systemctl --user restart jev-brain        # pick up brain edits
```

Editing **extension** code needs a re-login (Wayland cannot restart the shell in
place) — so keep `extension.js` thin and put logic in the brain. To try:

```fish
cd ~/jev-launcher-nixos
for f in extension/extension.js extension/lib/*.js; do node --check "$f"; done
```

`node --check` parses ESM without running it, which catches syntax slips before
you pay for a logout. It will not catch GJS API mistakes.

---

## 11. What was verified on the target machine

Measured on this NixOS 25.11 / GNOME Shell 49.2 / Wayland machine, Bun 1.4.0:

| Thing | Result |
| --- | --- |
| Index build | **134 ms** — 61 apps, 71 files, 177 recently-used |
| Browser history | **2797 unique URLs** from 2788 Firefox + 3000 Brave visits, read copy-on-read while both browsers were running |
| Socket protocol | `hello` + `query` verified end to end on `$XDG_RUNTIME_DIR/jev-launcher/brain.sock` (mode `srw-------`); local phase back in **121 ms** |
| Gateway wiring | `experimental_evaluate` + `gateway.evaluationModel('typesafe-ai/jev')` reach `ai-gateway.vercel.sh`; with a deliberately fake key the gateway's own `401 authentication_error` comes back, so the request path, retries and error mapping are all real |
| `calc 15% of 240` | `= 36` |
| `the pdf I just downloaded` | all four PDFs ranked above every web page |
| `sleep` | `Sleep` toggle ranked first |
| Unit tests | **50 pass / 0 fail** (`bun test`), 13 of them for the gateway answer translation |
| Extension | `node --check` clean on all three files; schema compiles with `glib-compile-schemas --strict` |
| Warm Jev round trip | ~270–380 ms (cold ~760–900 ms) |
| Layer-shell on Mutter | not supported — confirmed via wayland.app's compositor table |
| Alt+Space | free after unbinding `activate-window-menu` |

Two real bugs were found by this testing, both worth knowing:

- the Chromium timestamp threshold forgot to subtract the history window, so
  Brave appeared to have **zero** visits when it had 3000;
- the fuzzy scorer's "initials" rule fired on whole sentences, which put
  `Plan Details | Cloudinary` above every PDF on the machine.

Not verified, because each needs something this machine does not have: whether a
**real** gateway key's answers carry the field names this build reads (the call
path is proven; the values are not), how the green `↵` thresholds behave against
real probabilities, and the panel's layout — that one needs a re-login because
GNOME on Wayland cannot load an extension in place. Those thresholds are
hand-tuned in the original too; expect to move them.

---

## 12. Troubleshooting

`docs/troubleshooting.md` covers: the panel not opening, `Alt+Space` doing
nothing, `brain: no-socket`, a `403`/`429` from TypeSafe, GNOME refusing to load
the extension, a stale `gschemas.compiled`, and how to read the two logs.

---

## Provenance

- Original macOS launcher and the design this follows:
  <https://github.com/dabit3/jev-experiments/tree/main/jev-launcher>
- Jev / System One docs: <https://docs.typesafe.ai> — the rerank pattern is
  <https://docs.typesafe.ai/cookbooks/rerank_typesafe>
- Ported to NixOS/GNOME, with the fuzzy scorer, calculator, time-window parser
  and ranker rewritten in JavaScript from the Swift originals.

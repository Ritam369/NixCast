#!/usr/bin/env bash
#
# NixCast installer — NixOS / GNOME Shell (Wayland).
#
#   ./install.sh                 install or upgrade
#   ./install.sh --dry-run       print what would happen, change nothing
#   ./install.sh --skip-keybinding
#                                do not touch GNOME's Alt+Space binding
#
# Idempotent: safe to run again after editing the extension or the brain.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="nixcast@ritam.local"
LEGACY_UUID="jev-launcher@ritam.local"
EXT_SRC="$REPO_DIR/extension"
EXT_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
EXT_DEST="$EXT_ROOT/$UUID"
EXT_LEGACY="$EXT_ROOT/$LEGACY_UUID"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/nixcast-brain.service"
UNIT_LEGACY="$UNIT_DIR/jev-brain.service"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/nixcast"
CONFIG_LEGACY="${XDG_CONFIG_HOME:-$HOME/.config}/jev-launcher"
SOCKET_LEGACY="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/jev-launcher/brain.sock"

DRY_RUN=0
SKIP_KEYBINDING=0

usage() {
  sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-keybinding) SKIP_KEYBINDING=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg" >&2; usage; exit 2 ;;
  esac
done

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would run: %s\n' "$*"
  else
    "$@"
  fi
}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

say '1/8  Checking the environment'

[ "$(id -u)" -ne 0 ] || die 'do not run this as root; it installs into your user session'
command -v gnome-shell >/dev/null 2>&1 || die 'gnome-shell not found — this installer targets GNOME Shell'

SHELL_FULL="$(gnome-shell --version | awk '{print $3}')"
SHELL_MAJOR="${SHELL_FULL%%.*}"
echo "  gnome-shell      $SHELL_FULL"

if [ "$SHELL_MAJOR" -lt 45 ]; then
  die "GNOME Shell $SHELL_FULL is too old: this extension uses the ESM extension API (GNOME 45+)"
fi

if [ "${XDG_SESSION_TYPE:-}" != 'wayland' ]; then
  echo "  session          ${XDG_SESSION_TYPE:-unknown} (the launcher works on X11 too)"
fi

say '2/8  Locating bun'

BUN_BIN="$(command -v bun || true)"
[ -n "$BUN_BIN" ] || die "bun not found in PATH. Install it, then re-run:
    nix profile install nixpkgs#bun      # or: curl -fsSL https://bun.sh/install | bash"
echo "  bun              $BUN_BIN  ($("$BUN_BIN" --version))"

case "$BUN_BIN" in
  /nix/store/*)
    warn "bun resolves into /nix/store. A garbage collection can remove it, and the
        systemd unit pins that exact path. Prefer a stable profile path:
          nix profile install nixpkgs#bun
        then re-run this installer."
    ;;
esac

echo '  installing brain dependencies'
if [ "$DRY_RUN" = 1 ]; then
  echo "  would run: $BUN_BIN install  (in $REPO_DIR/brain)"
elif [ -f "$REPO_DIR/brain/bun.lock" ]; then
  ( cd "$REPO_DIR/brain" && "$BUN_BIN" install --frozen-lockfile )
else
  ( cd "$REPO_DIR/brain" && "$BUN_BIN" install )
fi

say '3/8  Preparing the GSettings schema'

COMPILE_SCHEMAS="$(command -v glib-compile-schemas || true)"
if [ -z "$COMPILE_SCHEMAS" ]; then
  # NixOS puts this in glib's dev output, which is not on PATH but is usually
  # present in the store because something in the closure depends on it.
  COMPILE_SCHEMAS="$(find /nix/store -maxdepth 3 -name glib-compile-schemas 2>/dev/null | head -n1 || true)"
fi

if [ -z "$COMPILE_SCHEMAS" ]; then
  die "glib-compile-schemas not found — the extension cannot read its settings
    without a compiled schema. Add it to your configuration, or install it for
    this shell only:
      nix shell nixpkgs#glib -c ./install.sh
      # or declare:  environment.systemPackages = [ pkgs.glib.dev ];"
fi

echo "  compiling with   $COMPILE_SCHEMAS"
run "$COMPILE_SCHEMAS" --strict "$EXT_SRC/schemas"

say '4/8  Installing the GNOME Shell extension'

# An install from before the rename would keep running under its own uuid and
# fight this one for the same hotkey.
# -L matters: a symlink left behind by a moved checkout is dangling, and -e
# is false for those, so the old entry would silently survive.
if [ -e "$EXT_LEGACY" ] || [ -L "$EXT_LEGACY" ]; then
  run gnome-extensions disable "$LEGACY_UUID" 2>/dev/null || true
  run rm -rf "$EXT_LEGACY"
  echo "  removed the older $LEGACY_UUID install"
fi

run mkdir -p "$EXT_ROOT"
if [ -e "$EXT_DEST" ] && [ ! -L "$EXT_DEST" ]; then
  run rm -rf "$EXT_DEST"
fi
# A symlink keeps the shell reading the working copy, so edits to the extension
# are one logout away rather than one reinstall away.
run ln -sfn "$EXT_SRC" "$EXT_DEST"
echo "  $EXT_DEST -> $EXT_SRC"

say '5/8  Writing the config file'

if [ -f "$CONFIG_DIR/config.json" ]; then
  echo "  keeping existing $CONFIG_DIR/config.json"
else
  run mkdir -p "$CONFIG_DIR"
  # Settings from the earlier name are still valid: index.searchRoots,
  # index.browsers, toggles and actions all kept their shape.
  if [ -f "$CONFIG_LEGACY/config.json" ]; then
    echo "  migrating $CONFIG_LEGACY/config.json (your search roots and actions)"
    run cp "$CONFIG_LEGACY/config.json" "$CONFIG_DIR/config.json"
  else
    run cp "$REPO_DIR/config/config.example.json" "$CONFIG_DIR/config.json"
  fi
  run chmod 600 "$CONFIG_DIR/config.json"
  echo "  created  $CONFIG_DIR/config.json (mode 600)"
fi

say '6/8  Installing the brain service'

if [ -e "$UNIT_LEGACY" ]; then
  run systemctl --user disable --now jev-brain.service || true
  run rm -f "$UNIT_LEGACY"
  run rm -f "$SOCKET_LEGACY"
  echo '  stopped and removed the older brain unit'
fi

run mkdir -p "$UNIT_DIR"
if [ "$DRY_RUN" = 1 ]; then
  echo "  would render config/nixcast-brain.service.in -> $UNIT_PATH"
else
  sed -e "s|__BUN__|$BUN_BIN|g" \
      -e "s|__REPO__|$REPO_DIR|g" \
      "$REPO_DIR/config/nixcast-brain.service.in" > "$UNIT_PATH"
  echo "  wrote    $UNIT_PATH"
fi

run systemctl --user daemon-reload
run systemctl --user enable --now nixcast-brain.service
echo '  brain service enabled and started'

say '7/8  Freeing Alt+Space'

if [ "$SKIP_KEYBINDING" = 1 ]; then
  echo '  skipped (--skip-keybinding)'
else
  # GNOME binds Alt+Space to the window menu, which would swallow the
  # launcher's shortcut.
  CURRENT="$(gsettings get org.gnome.desktop.wm.keybindings activate-window-menu 2>/dev/null || echo '?')"
  echo "  activate-window-menu is currently $CURRENT"
  run gsettings set org.gnome.desktop.wm.keybindings activate-window-menu '[]'
  echo '  unbound. Give it back to GNOME with:  ./uninstall.sh --restore-hotkey'
fi

say '8/8  Enabling the extension'

if [ "$DRY_RUN" = 1 ]; then
  echo "  would run: gnome-extensions enable $UUID"
elif gnome-extensions enable "$UUID" 2>/dev/null; then
  echo "  enabled  $UUID"
else
  echo '  the running shell has not scanned the new extension yet.'
fi

# Optional, but it is what makes "find that file anywhere" work.
if command -v plocate >/dev/null 2>&1; then
  echo '  plocate          found — whole-disk name search is available'
else
  echo '  plocate          not installed (optional). Enable it with:'
  echo '                     services.locate.enable = true;'
  echo '                   then:  sudo systemctl start update-locatedb'
fi

cat <<'EOF'

────────────────────────────────────────────────────────────────────────
GNOME on Wayland cannot reload an extension in place. Log out and back in
(or reboot) once, then press Alt+Space.

After the re-login, check it:
    gnome-extensions info nixcast@ritam.local
    journalctl --user -f -o cat | grep -i nixcast   # live extension log
    systemctl --user status nixcast-brain           # live brain log

Adjust what gets searched (external drives, folders, actions):
    $EDITOR ~/.config/nixcast/config.json
Verify the brain without logging out:
    cd ~/nixcast/brain && bun run src/index.js --check

Mounting drives and whole-disk search: docs/nixos.md
When something looks wrong: docs/troubleshooting.md
────────────────────────────────────────────────────────────────────────
EOF

#!/usr/bin/env bash
#
# Jev Launcher uninstaller.
#
#   ./uninstall.sh                 remove the extension and stop the service
#   ./uninstall.sh --keep-config   leave ~/.config/jev-launcher alone
#   ./uninstall.sh --restore-hotkey
#                                  give Alt+Space back to GNOME's window menu

set -euo pipefail

UUID="jev-launcher@ritam.local"
EXT_DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/jev-brain.service"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/jev-launcher"
SOCKET="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/jev-launcher/brain.sock"

KEEP_CONFIG=0
RESTORE_HOTKEY=0

for arg in "$@"; do
  case "$arg" in
    --keep-config) KEEP_CONFIG=1 ;;
    --restore-hotkey) RESTORE_HOTKEY=1 ;;
    -h|--help) sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say 'Stopping the brain service'
systemctl --user disable --now jev-brain.service 2>/dev/null || true
rm -f "$UNIT_PATH"
systemctl --user daemon-reload || true
rm -f "$SOCKET"
echo '  stopped and removed the unit'

say 'Disabling the extension'
gnome-extensions disable "$UUID" 2>/dev/null || echo '  (not currently enabled)'
if [ -L "$EXT_DEST" ]; then
  rm -f "$EXT_DEST"
  echo "  removed symlink $EXT_DEST"
elif [ -e "$EXT_DEST" ]; then
  rm -rf "$EXT_DEST"
  echo "  removed $EXT_DEST"
else
  echo '  nothing installed'
fi

if [ "$KEEP_CONFIG" = 0 ]; then
  say 'Removing config (which holds your API key)'
  rm -rf "$CONFIG_DIR"
  echo "  removed $CONFIG_DIR"
else
  say 'Keeping config'
  echo "  left $CONFIG_DIR in place"
fi

if [ "$RESTORE_HOTKEY" = 1 ]; then
  say 'Restoring Alt+Space to the GNOME window menu'
  gsettings set org.gnome.desktop.wm.keybindings activate-window-menu "['<Alt>space']"
  echo '  restored'
fi

cat <<'EOF'

Log out and back in to unload the extension from the running shell.
EOF

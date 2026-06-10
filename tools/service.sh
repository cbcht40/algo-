#!/bin/bash
# Run the copier as a macOS background service (launchd).
#
#   npm run service:install     start now + at every boot, restart on crash
#   npm run service:status      is it running? + last log lines
#   npm run service:logs        follow the live log
#   npm run service:restart     reload (e.g. after `git pull` or config change)
#   npm run service:uninstall   stop and remove
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.tradovate.copier"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$DIR/logs/copier.log"

usage() { echo "usage: service.sh install|uninstall|status|logs|restart"; exit 1; }

write_plist() {
  mkdir -p "$DIR/logs" "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd '$DIR' && exec npm start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
}

case "${1:-}" in
  install)
    write_plist
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"
    echo "✓ Service installé et démarré (relance auto au boot et en cas de crash)."
    echo "  Logs :    npm run service:logs"
    echo "  Statut :  npm run service:status"
    ;;
  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✓ Service arrêté et désinstallé."
    ;;
  status)
    if launchctl list | grep -q "$LABEL"; then
      echo "● Service chargé :"
      launchctl list | grep "$LABEL" || true
    else
      echo "○ Service non chargé."
    fi
    if [[ -f "$LOG" ]]; then
      echo "--- dernières lignes du log ---"
      tail -n 15 "$LOG"
    fi
    ;;
  logs)
    touch "$LOG"
    tail -n 50 -f "$LOG"
    ;;
  restart)
    launchctl unload "$PLIST" 2>/dev/null || true
    write_plist
    launchctl load -w "$PLIST"
    echo "✓ Service redémarré."
    ;;
  *) usage ;;
esac

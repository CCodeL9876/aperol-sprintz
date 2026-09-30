#!/usr/bin/env bash
# Lädt lokale Änderungen automatisch zu GitHub hoch (und damit auf GitHub Pages):
# erhöht die Versionsnummer in index.html, committet alles und pusht zum verbundenen Repository.
#
# Aufruf:  ./deploy.sh                    → Commit-Nachricht "Update 2026-09-29"
#          ./deploy.sh "Neue Kategorie"   → eigene Commit-Nachricht
#
# Einmalig nötig, bevor dieses Skript zum ersten Mal läuft: das Projekt mit dem
# bestehenden GitHub-Repository verbinden (siehe ANLEITUNG.md, Abschnitt „Automatisch hochladen“).

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .git ]; then
  echo "Kein Git-Repository hier. Erst einmalig verbinden – siehe ANLEITUNG.md, Abschnitt „Automatisch hochladen“." >&2
  exit 1
fi

# 1) Versionsnummer in index.html erhöhen (Format: v=JJJJ-MM-TT.N), damit Browser
#    nach dem Hochladen nie alte und neue Dateien mischen.
TODAY=$(date +%Y-%m-%d)
CURRENT=$(grep -oE 'v=[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+' index.html | head -1 | sed 's/v=//')
if [ -z "$CURRENT" ]; then
  NEW="$TODAY.1"
elif [ "${CURRENT%.*}" = "$TODAY" ]; then
  NEW="$TODAY.$(( ${CURRENT##*.} + 1 ))"
else
  NEW="$TODAY.1"
fi
if [ -n "$CURRENT" ] && [ "$CURRENT" != "$NEW" ]; then
  sed -i '' "s/v=$CURRENT/v=$NEW/g" index.html
  echo "Versionsnummer: $CURRENT → $NEW"
fi

# 2) Alles committen (nichts zu tun, wenn sich nur die Version nicht geändert hat und sonst nichts anliegt)
git add -A
if git diff --cached --quiet; then
  echo "Keine Änderungen zu committen."
else
  git commit -m "${1:-Update $TODAY}"
fi

# 3) Hochladen
git push origin main
echo "Fertig – GitHub Pages aktualisiert sich in etwa 1–2 Minuten."

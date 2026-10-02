#!/bin/zsh
# Doble clic para arrancar Gancho en esta Mac y compartirlo con el equipo en la misma red.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:$PATH"
brew services start postgresql@16 >/dev/null 2>&1
sleep 2
IP=$(ipconfig getifaddr en0 || ipconfig getifaddr en1)
echo ""
echo "  ✅ Gancho está prendido"
echo "  Tú:          http://localhost:3000"
echo "  El equipo:   http://$IP:3000   (misma red Wi-Fi)"
echo ""
echo "  No cierres esta ventana ni apagues la Mac mientras lo usen."
echo ""
open "http://localhost:3000"
# caffeinate evita que la Mac se duerma mientras Gancho está prendido.
caffeinate -i node --env-file-if-exists=.env server.js

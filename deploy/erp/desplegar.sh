#!/usr/bin/env bash
# Actualiza Gancho en el servidor: trae la versión, instala, revisa y reinicia.
# Si algo falla en cualquier paso, regresa SOLO a la versión anterior (código y dependencias) y la deja corriendo.
#   sudo /var/www/gancho/deploy/erp/desplegar.sh [etiqueta]     (p. ej. v1.0.1; sin etiqueta = lo último de main)
set -euo pipefail
DIR=/var/www/gancho
ENV_FILE=/etc/gancho/gancho.env
cd "$DIR"
como_gancho() { sudo -u gancho "$@"; }
VERSION_ANTES=$(como_gancho git rev-parse HEAD)
NOMBRE_ANTES=$(como_gancho git describe --tags --always)
REINICIADO=0

regresar() {
  echo "❌ Falló el despliegue. Regresando a $NOMBRE_ANTES…"
  como_gancho git checkout --quiet --force "$VERSION_ANTES"
  como_gancho npm ci --omit=dev --no-audit --no-fund >/dev/null
  if [ "$REINICIADO" = 1 ]; then systemctl restart gancho; fi
  echo "↩️  Gancho quedó en $NOMBRE_ANTES. Revisa: sudo journalctl -u gancho -n 80"
}
trap regresar ERR

echo "Trayendo la versión…"
como_gancho git fetch --tags --quiet origin
if [ -n "${1:-}" ]; then como_gancho git checkout --quiet "$1"; else como_gancho git checkout --quiet main && como_gancho git pull --ff-only --quiet; fi
echo "Instalando dependencias…"
como_gancho npm ci --omit=dev --no-audit --no-fund
echo "Revisando la instalación (sin gastar)…"
como_gancho env NODE_ENV=production node --env-file="$ENV_FILE" scripts/verificar.js
systemctl restart gancho
REINICIADO=1
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8090/salud >/dev/null 2>&1; then
    trap - ERR
    echo "✅ Gancho $(como_gancho git describe --tags --always) en línea (antes: $NOMBRE_ANTES)."
    exit 0
  fi
  sleep 2
done
echo "Gancho no respondió en 60 s."
false

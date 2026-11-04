#!/usr/bin/env bash
# Build the capture app for this VPS's domain and publish it behind Caddy.
# Run as the app user from the repo root (after setup.sh):
#
#   bash deploy/vps/deploy-app.sh            # uses /etc/pde-domain
#   CAPTURE_DOMAIN=capture.example.com bash deploy/vps/deploy-app.sh
set -euo pipefail

cd "$(dirname "$0")/../.."
DOMAIN="${CAPTURE_DOMAIN:-$(cat /etc/pde-domain)}"
WEBROOT="${WEBROOT:-/var/www/pde}"
T3_UPSTREAM="${T3_UPSTREAM:-https://cn-api.sg.testnet.t3n.terminal3.io}"

git pull --ff-only || true
pnpm install --frozen-lockfile

# Each signed-in user's data goes to their own vault (PDE_DRY_RUN=1: demo build, nothing is sent).
if [ "${PDE_DRY_RUN:-0}" != "1" ]; then
  pnpm -s t3:config -- "$DOMAIN"
  export PDE_CONFIG_FILE="$PWD/deploy/out/pde.config.json"
fi

pnpm build
rsync -a --delete apps/capture-pwa/dist/ "$WEBROOT"/

node deploy/render-caddyfile.mjs "$DOMAIN" "$WEBROOT" "$T3_UPSTREAM" | sudo /usr/bin/tee /etc/caddy/Caddyfile >/dev/null
sudo /usr/bin/caddy validate --config /etc/caddy/Caddyfile
sudo /usr/bin/systemctl reload caddy

echo "✓ https://${DOMAIN}/  (relay: https://${DOMAIN}/t3 → ${T3_UPSTREAM})"
echo "  check: curl -sI https://${DOMAIN}/ | grep -i cross-origin ; curl -s https://${DOMAIN}/t3/status | head -c 200"

#!/usr/bin/env bash
# One-time setup of a Hostinger (or any Ubuntu 22.04/24.04) VPS for the
# capture app: Caddy (automatic HTTPS), Node 22 + pnpm,
# firewall. Run as root:
#
#   CAPTURE_DOMAIN=capture.example.com bash deploy/vps/setup.sh
#
# Before running: point an A record for CAPTURE_DOMAIN at this VPS, and in
# hPanel → VPS → Security → Firewall allow TCP 22, 80 and 443.
set -euo pipefail

: "${CAPTURE_DOMAIN:?set CAPTURE_DOMAIN, e.g. capture.example.com}"
APP_USER="${APP_USER:-pde}"
REPO_URL="${REPO_URL:-https://github.com/Terminal-3/private-doc-scanner.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
APP_HOME="/home/${APP_USER}"

echo "→ packages"
apt-get update -y
apt-get install -y curl git ufw rsync ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https build-essential

echo "→ Caddy (official repository)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "→ Node 22 + pnpm"
if ! node --version 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
corepack enable

echo "→ app user, checkout"
id "$APP_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$APP_USER"
if [ ! -d "$APP_HOME/private-doc-scanner" ]; then
  sudo -u "$APP_USER" git clone --branch "$REPO_BRANCH" "$REPO_URL" "$APP_HOME/private-doc-scanner"
fi

echo "→ web root"
mkdir -p /var/www/pde
chown "$APP_USER":"$APP_USER" /var/www/pde

echo "→ firewall (also allow 22/80/443 in hPanel's VPS firewall)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

cat > /etc/sudoers.d/pde-caddy <<SUDO
${APP_USER} ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/Caddyfile, /usr/bin/caddy validate --config /etc/caddy/Caddyfile, /usr/bin/systemctl reload caddy
SUDO
chmod 440 /etc/sudoers.d/pde-caddy
echo "$CAPTURE_DOMAIN" > /etc/pde-domain

cat <<DONE

Setup complete. Next, as ${APP_USER}:

  sudo -iu ${APP_USER}
  cd ~/private-doc-scanner
  # build + publish the app with the relay (users set up their own vaults):
  bash deploy/vps/deploy-app.sh

DONE

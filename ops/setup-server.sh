#!/usr/bin/env bash
# One-command setup for a fresh Ubuntu server (for example an Oracle Cloud Always Free VM).
#
#   curl -fsSL https://raw.githubusercontent.com/Oybek-Matkosimov/FamilyCalendar/feature/family-calendar/ops/setup-server.sh | bash
#
# Optional: use your own web name instead of the automatic one:  ... | bash -s -- calendar.example.com
#
# What it does (safe to run again; it never overwrites your .env or your data):
#   1. opens ports 80 and 443 in the server's own firewall
#   2. installs Docker if it is missing
#   3. downloads the app
#   4. creates .env with a random database password
#   5. starts the database, the app, HTTPS and nightly backups
#   6. waits until https://<name>/api/health answers
#
# You must still open ports 80 and 443 in your cloud provider's network settings (for Oracle: the subnet's Security List).
set -euo pipefail

REPO="${REPO:-https://github.com/Oybek-Matkosimov/FamilyCalendar.git}"
BRANCH="${BRANCH:-feature/family-calendar}"
DIR="${DIR:-$HOME/FamilyCalendar}"
DOMAIN="${1:-}"

say() { printf '\n==> %s\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

if [ -z "$DOMAIN" ]; then
  say "Finding this server's public address"
  ip="$(curl -fsS https://api.ipify.org)"
  DOMAIN="${ip//./-}.sslip.io"   # sslip.io is a free service that turns 1-2-3-4.sslip.io into the IP 1.2.3.4
  echo "Public IP: $ip   Web name: $DOMAIN"
fi

say "Opening ports 80 and 443 in the server firewall"
for port in 80 443; do
  if ! $SUDO iptables -C INPUT -m state --state NEW -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    $SUDO iptables -I INPUT 1 -m state --state NEW -p tcp --dport "$port" -j ACCEPT
  fi
done
if command -v netfilter-persistent >/dev/null; then $SUDO netfilter-persistent save >/dev/null; fi

say "Installing Docker (skipped if already installed)"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | $SUDO sh
fi
$SUDO systemctl enable --now docker >/dev/null 2>&1 || true

say "Downloading the app into $DIR"
if ! command -v git >/dev/null; then $SUDO apt-get update -y >/dev/null && $SUDO apt-get install -y git >/dev/null; fi
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch origin "$BRANCH" && git -C "$DIR" checkout "$BRANCH" && git -C "$DIR" pull --ff-only origin "$BRANCH"
else
  git clone -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

if [ ! -f .env ]; then
  say "Creating .env"
  umask 077
  cat > .env <<EOF
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
LOG_LEVEL=info
KEEP_DAILY=30
KEEP_MONTHLY=12
S3_BUCKET=
S3_ENDPOINT=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
EOF
else
  say ".env already exists, keeping it"
  DOMAIN="$(grep -E '^DOMAIN=' .env | head -1 | cut -d= -f2-)"
fi

say "Building and starting the app (the first time takes several minutes)"
$SUDO docker compose -f ops/docker-compose.yml --env-file .env up -d --build

say "Waiting for https://$DOMAIN to come up (the HTTPS certificate is requested automatically)"
for i in $(seq 1 60); do
  if curl -fsS --max-time 10 "https://$DOMAIN/api/health" 2>/dev/null | grep -q '"ok":true'; then
    printf '\nDONE. Open https://%s in your browser.\n' "$DOMAIN"
    printf 'Next: create your family calendar, save the recovery code, and copy the backups off this server now and then.\n'
    exit 0
  fi
  sleep 5
done

printf '\nThe app did not answer at https://%s within 5 minutes.\n' "$DOMAIN"
echo "Common causes: ports 80/443 are not open in the cloud provider's network settings, or the web name does not point at this server."
echo "Look at the logs with:  cd $DIR && sudo docker compose -f ops/docker-compose.yml --env-file .env logs --tail=80"
exit 1

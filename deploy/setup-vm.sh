#!/usr/bin/env bash
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────
REPO_URL="https://github.com/sendtwothreeyears/drbg.git"
APP_DIR="/opt/boafo"
ENV_DIR="/etc/boafo"
BRANCH="main"

# ── Swap (prevent OOM during npm ci / vite build on 1GB RAM) ────────
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  sudo sysctl vm.swappiness=10
fi

# ── System packages (Ubuntu 24.04: several libs have the t64 suffix) ─
sudo apt-get update
sudo apt-get install -y curl ca-certificates git nginx postgresql-client \
  libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libpango-1.0-0 libcairo2 libasound2t64 libnspr4 libnss3

# ── Node.js 20 ──────────────────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# ── PGDG repo (PostgreSQL 18 is not in Ubuntu 24.04 default repos) ───
. /etc/os-release
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt-get update

# ── PostgreSQL 18 + pgvector ────────────────────────────────────────
sudo apt-get install -y postgresql-18 postgresql-server-dev-18 build-essential
cd /tmp
git clone --branch v0.8.1 https://github.com/pgvector/pgvector.git
cd pgvector
make PG_CONFIG=/usr/lib/postgresql/18/bin/pg_config
sudo make PG_CONFIG=/usr/lib/postgresql/18/bin/pg_config install
cd /
rm -rf /tmp/pgvector

# ── Configure PostgreSQL ────────────────────────────────────────────
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
sudo -u postgres psql -c "CREATE DATABASE cb;" || true
sudo -u postgres psql -d cb -c "CREATE EXTENSION IF NOT EXISTS vector;"

# ── Tune PostgreSQL for e2-micro/e2-small ──────────────────────────
PG_CONF=$(sudo -u postgres psql -t -c "SHOW config_file;" | xargs)
sudo tee -a "$PG_CONF" > /dev/null <<'PGCONF'

# Boafo performance tuning
shared_buffers = 128MB
effective_cache_size = 512MB
work_mem = 4MB
max_connections = 20
random_page_cost = 1.1
PGCONF
sudo systemctl restart postgresql

# ── PM2 ──────────────────────────────────────────────────────────────
sudo npm install -g pm2

# ── Log directory ────────────────────────────────────────────────────
sudo mkdir -p /var/log/boafo

# ── Clone repo ──────────────────────────────────────────────────────
sudo rm -rf "$APP_DIR"
sudo git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"
sudo npm ci

# ── Puppeteer Chrome for the PM2 user (PDF generation) ──────────────
sudo -u "$(whoami)" npx puppeteer browsers install chrome

# ── Environment file ────────────────────────────────────────────────
sudo mkdir -p "$ENV_DIR"
if [ ! -f "$ENV_DIR/.env" ]; then
  sudo tee "$ENV_DIR/.env" > /dev/null <<'ENVFILE'
NODE_ENV=production
DATABASE=cb
PG_USER=postgres
PG_PASSWORD=postgres
PG_PORT=5432
ANTHROPIC_API_KEY=your-key-here
OPENAI_API_KEY=your-key-here
PORT=3000
ENVFILE
  echo ">>> Edit /etc/boafo/.env with your real API keys before starting the app."
fi

# ── Build frontend ──────────────────────────────────────────────────
sudo npm run build

# ── Database setup (schema + embed guidelines) ──────────────────────
set -a
source "$ENV_DIR/.env"
set +a
cd "$APP_DIR"
sudo -E npm run db:setup

# ── PM2 process manager ─────────────────────────────────────────────
pm2 start "$APP_DIR/deploy/ecosystem.config.cjs"
pm2 startup systemd -u "$(whoami)" --hp "$HOME"
pm2 save

# ── Nginx ───────────────────────────────────────────────────────────
sudo cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/boafo
sudo ln -sf /etc/nginx/sites-available/boafo /etc/nginx/sites-enabled/boafo
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

echo ">>> Boafo is running. Access via http://$(curl -s ifconfig.me)"

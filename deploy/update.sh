#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/boafo"
ENV_FILE="/etc/boafo/.env"
PM2_USER="fsheikh"

cd "$APP_DIR"

set -a
source "$ENV_FILE"
set +a

echo ">>> Pulling latest code..."
git fetch origin main
git reset --hard origin/main

echo ">>> Installing dependencies..."
npm ci

echo ">>> Installing Puppeteer browser..."
sudo -u "$PM2_USER" npx puppeteer browsers install chrome

echo ">>> Building frontend..."
npm run build

echo ">>> Running database setup..."
npm run db:setup

echo ">>> Reloading PM2 (zero-downtime)..."
sudo -u "$PM2_USER" pm2 reload boafo

echo ">>> Deploy complete."
sudo -u "$PM2_USER" pm2 status

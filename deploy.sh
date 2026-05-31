#!/bin/bash
# Деплой локальных изменений бэкенда на сервер Яндекса.
# Пушит в origin (bare-репо на сервере), затем на сервере: pull + build + перезапуск PM2 (kids-english-api).
set -e

SERVER="ubuntu@158.160.208.163"
KEY="$HOME/.ssh/yandex_student_reports"
SSH="ssh -i $KEY -o ConnectTimeout=20"

echo "📤 Пушу в origin..."
git push origin main

echo "🔄 Обновляю и пересобираю на сервере..."
$SSH "$SERVER" '
  set -e
  cd /home/ubuntu/kids-english-backend
  git pull --ff-only origin main
  if ! git diff --quiet HEAD@{1} HEAD -- package-lock.json 2>/dev/null; then
    echo "📦 package-lock изменился — npm install..."
    npm install --production
  fi
  echo "🏗️  build:simple..."
  npm run build:simple
  echo "♻️  перезапуск PM2..."
  pm2 restart kids-english-api
'
echo "✅ Готово. API: https://uniplay-kids.ru/kids-api/"

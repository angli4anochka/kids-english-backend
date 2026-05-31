#!/bin/bash

# Deploy script for Kids English Backend
# Usage: ./deploy-to-server.sh

set -e

echo "🚀 Building backend..."
npm run build:simple

echo "📦 Creating deployment package..."
tar -czf backend-deploy.tar.gz dist/server-simple.js package.json schema.sql .env.production.example

echo "📤 Uploading to server..."
scp -i ~/.ssh/yandex_student_reports backend-deploy.tar.gz ubuntu@158.160.208.163:/home/ubuntu/

echo "🔧 Deploying on server..."
ssh -i ~/.ssh/yandex_student_reports ubuntu@158.160.208.163 << 'ENDSSH'
  cd /home/ubuntu

  # Backup current deployment
  if [ -d "kids-english-backend" ]; then
    tar -czf kids-english-backend-backup-$(date +%Y%m%d-%H%M%S).tar.gz kids-english-backend
  fi

  # Extract new version
  mkdir -p kids-english-backend-new
  cd kids-english-backend-new
  tar -xzf ../backend-deploy.tar.gz

  # Copy existing .env if it exists
  if [ -f "../kids-english-backend/.env" ]; then
    cp ../kids-english-backend/.env .env
  fi

  # Install dependencies
  npm install --production

  # Rename server-simple.js to index.js for consistency
  mv dist/server-simple.js dist/index.js

  # Replace old deployment
  cd ..
  rm -rf kids-english-backend
  mv kids-english-backend-new kids-english-backend

  # Restart service
  sudo systemctl restart kids-english-backend

  # Check status
  sleep 2
  sudo systemctl status kids-english-backend --no-pager
ENDSSH

echo "✅ Deployment complete!"
echo "🔍 Testing API..."
curl -s http://158.160.208.163/kids-api/lessons | head -20

echo ""
echo "✅ Backend deployed successfully!"

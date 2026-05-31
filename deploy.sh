#!/bin/bash

# Deployment script for Yandex Cloud
# Usage: ./deploy.sh [server-ip] [user]

SERVER_IP=${1:-"158.160.186.216"}
USER=${2:-"ubuntu"}
APP_NAME="kids-english-backend"

echo "🚀 Deploying to $USER@$SERVER_IP"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Build locally
echo -e "${YELLOW}📦 Building application...${NC}"
npm run build

# Step 2: Create deployment package
echo -e "${YELLOW}📦 Creating deployment package...${NC}"
tar -czf deploy.tar.gz \
  dist/ \
  package.json \
  package-lock.json \
  Dockerfile \
  docker-compose.yml \
  .env.example

# Step 3: Upload to server
echo -e "${YELLOW}📤 Uploading to server...${NC}"
scp deploy.tar.gz $USER@$SERVER_IP:/tmp/

# Step 4: Deploy on server
echo -e "${YELLOW}🔧 Deploying on server...${NC}"
ssh $USER@$SERVER_IP << 'ENDSSH'
  set -e

  APP_DIR="/home/ubuntu/kids-english-backend"

  # Create app directory
  mkdir -p $APP_DIR
  cd $APP_DIR

  # Extract files
  tar -xzf /tmp/deploy.tar.gz
  rm /tmp/deploy.tar.gz

  # Copy .env if doesn't exist
  if [ ! -f .env ]; then
    cp .env.example .env
    echo "⚠️  Please configure .env file with your credentials"
  fi

  # Install dependencies
  npm ci --only=production

  # Build and restart containers
  docker-compose down
  docker-compose up -d --build

  echo "✅ Deployment complete!"
  echo "📊 Container status:"
  docker-compose ps
ENDSSH

# Step 5: Run migrations
echo -e "${YELLOW}🗄️  Running database migrations...${NC}"
ssh $USER@$SERVER_IP "cd /home/ubuntu/kids-english-backend && docker-compose exec -T api npm run migrate"

# Step 6: Health check
echo -e "${YELLOW}🏥 Checking health...${NC}"
sleep 5
curl -f http://$SERVER_IP:3001/health || echo "⚠️  Health check failed"

echo -e "${GREEN}✅ Deployment completed!${NC}"
echo "🌐 API: http://$SERVER_IP:3001"
echo "🔍 Logs: ssh $USER@$SERVER_IP 'cd /home/ubuntu/kids-english-backend && docker-compose logs -f'"

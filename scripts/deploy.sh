#!/usr/bin/env bash
# Self-deploy: pull latest main, build, restart.
# Spawned detached so it survives the systemctl restart.
set -e

cd /home/ubuntu/nanoclaw

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Deploy started" >> logs/deploy.log

git checkout main >> logs/deploy.log 2>&1 || true
git pull origin main >> logs/deploy.log 2>&1
npm run build >> logs/deploy.log 2>&1

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Build complete, restarting..." >> logs/deploy.log

sudo systemctl restart nanoclaw >> logs/deploy.log 2>&1

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Deploy complete" >> logs/deploy.log

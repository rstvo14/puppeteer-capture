#!/bin/bash

# Clean install - force remove puppeteer-core in case it's cached
npm uninstall puppeteer-core || true

# Clear any package-lock file that may be locking wrong versions
rm -f package-lock.json

# Reinstall puppeteer from scratch
npm install puppeteer@24.6.1 --force

# Set up Chromium in a known cache dir
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
npx puppeteer browsers install chrome
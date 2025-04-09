#!/bin/bash

# Remove puppeteer-core if it was auto-installed somehow
npm uninstall puppeteer-core || true

# Ensure full puppeteer gets installed and sets up Chromium
npm install puppeteer@24.6.1
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
npx puppeteer browsers install chrome
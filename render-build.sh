#!/bin/bash
npm uninstall puppeteer-core || true
npm install puppeteer@24.6.1 --force
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
npx puppeteer browsers install chrome
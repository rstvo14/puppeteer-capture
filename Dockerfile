# Use an official Node image as the base
FROM node:20-slim

# Install Chrome and its dependencies
RUN apt-get update \
 && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxkbcommon0 \
    libvulkan1 \
    libgl1 \
    libosmesa6 \
 && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
 && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

# Let puppeteer-core know where Chrome lives (optional but nice)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# App directory
WORKDIR /usr/src/app

# Install Node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# The service listens on this port in app.js
EXPOSE 10000

# Start the capture service
CMD ["node", "app.js"]
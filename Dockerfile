# Use official Node.js image on Debian/Ubuntu base
FROM node:18-slim

# Install necessary dependencies, dumb-init, and Google Chrome prerequisites
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable libxss1 libxtst6 libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy the rest of your app code
COPY . .

# Expose port (if your app uses express/web server)
EXPOSE 8000

# Start the bot
CMD ["node", "index.js"]

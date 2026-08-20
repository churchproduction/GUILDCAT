# Warden — Discord mod bot + staff dashboard, one container.
FROM node:22-slim

WORKDIR /app

# better-sqlite3 ships prebuilt binaries for linux x64; the toolchain below is
# only a fallback in case a prebuild isn't available for the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]

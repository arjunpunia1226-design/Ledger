# Runs Ledger on any container host (Railway, Fly.io, a VPS with Docker, ...).
#   docker build -t ledger .
#   docker run -d -p 8787:8787 -e LEDGER_PASSWORD='choose-a-long-password' -v ledger-data:/data ledger
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "server/index.js"]

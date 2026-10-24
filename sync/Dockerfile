# The self-hosted sync server (server.mjs): no Cloudflare needed.
#   docker build -t scratch-sync .
#   docker run -d -p 8787:8787 -e SYNC_TOKEN=… -v scratch-sync:/data scratch-sync
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
ENV PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["node", "server.mjs"]

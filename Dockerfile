# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/waitlist.sqlite
WORKDIR /app
RUN groupadd -r sam && useradd -r -g sam -d /app -s /usr/sbin/nologin sam \
    && mkdir -p /data && chown sam:sam /data
COPY --from=build --chown=sam:sam /app/dist ./dist
COPY --chown=sam:sam docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server/index.js"]

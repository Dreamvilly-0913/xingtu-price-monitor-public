FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* && npm install -g pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* && npm install -g pnpm@11.19.0 && mkdir -p /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4010 DATABASE_URL=file:/data/xingtu.db APP_TIMEZONE=Asia/Shanghai
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/prisma ./server/prisma
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/scripts ./scripts
COPY scripts/docker-entrypoint.sh /usr/local/bin/xingtu-entrypoint
RUN chmod +x /usr/local/bin/xingtu-entrypoint
EXPOSE 4010
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4010/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/xingtu-entrypoint"]

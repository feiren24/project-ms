ARG NODE_VERSION=24.13.1
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
ARG APT_MIRROR=default
# Preserve Debian suites and Signed-By; switch both package and security URIs.
RUN case "$APT_MIRROR" in \
      default) ;; \
      ustc) sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g' /etc/apt/sources.list.d/debian.sources ;; \
      *) echo 'APT_MIRROR must be default or ustc' >&2; exit 1 ;; \
    esac
# Bound individual network waits/retries; retain package download logs.
RUN printf 'Acquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAcquire::Retries "2";\n' > /etc/apt/apt.conf.d/99goodwork-network \
    && timeout -k 10s 600s apt-get update \
    && timeout -k 10s 1800s apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY .node-version tsconfig.base.json tsconfig.server.json ./
COPY client ./client
COPY server ./server
COPY shared ./shared
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATABASE_MODE=existing-only SERVE_WEB=true HOST=0.0.0.0 PORT=3100
# tsx is a runtime requirement; retain the locked dependencies built inside Linux.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/client/dist ./client/dist
EXPOSE 3100
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s CMD node -e 'fetch("http://127.0.0.1:3100/health/ready").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", "--import", "tsx", "server/src/main.ts"]

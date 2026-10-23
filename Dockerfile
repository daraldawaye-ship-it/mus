# syntax=docker/dockerfile:1
FROM postgres:18-bookworm@sha256:bbf83594798e144bff365a9c191c5d779f181fb3135902064ab8ff11918020fc AS migration-tools
RUN mkdir -p /opt/pg18/bin /opt/pg18/lib \
    && cp /usr/lib/postgresql/18/bin/pg_dump /usr/lib/postgresql/18/bin/pg_restore /opt/pg18/bin/ \
    && ldd /opt/pg18/bin/pg_dump /opt/pg18/bin/pg_restore \
       | awk '$2 == "=>" && $3 ~ /^[/]/ { print $3 }' | sort -u \
       | while read -r library; do \
           case "$(basename "$library")" in \
             libc.so.*|libm.so.*|libpthread.so.*|libdl.so.*|librt.so.*|libresolv.so.*) ;; \
             *) cp -L "$library" /opt/pg18/lib/ ;; \
           esac; \
         done

FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci; else npm ci; fi
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm run check && npm run build

FROM node:24.19.0-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --omit=dev; else npm ci --omit=dev; fi \
    && npm cache clean --force

FROM node:24.19.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=migration-tools /opt/pg18 /opt/pg18
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/api ./apps/api
COPY --chown=node:node packages/contracts ./packages/contracts
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "--input-type=module", "-e", "const response = await fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/api/health', { signal: AbortSignal.timeout(4000) }); if (!response.ok || (await response.json()).ok !== true) process.exit(1);"]
CMD ["node", "--import", "tsx", "apps/api/scripts/render-entry.mjs"]

FROM oven/bun:1.3.14 AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS test
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN bun run check

FROM base AS production-dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src ./src
USER bun
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD bun -e "const r = await fetch('http://127.0.0.1:8080/health'); process.exit(r.ok ? 0 : 1)"
CMD ["bun", "run", "src/index.ts"]

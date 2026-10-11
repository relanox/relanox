FROM node:26.11.1-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS build
WORKDIR /build
RUN npm install --global pnpm@12.11.2
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build \
    && pnpm --filter @relanox/cli deploy --legacy --prod /output

FROM node:26.11.1-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /output ./
COPY --from=build /build/LICENSE /build/THIRD_PARTY_NOTICES.txt ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD node --input-type=module -e "const r = await fetch('http://127.0.0.1:8788/health/ready', {signal: AbortSignal.timeout(3000)}); process.exit(r.ok ? 0 : 1)"
ENTRYPOINT ["node", "dist/main.js"]
CMD ["run", "--config", "/config/relanox.json"]

# GatePass — single image: API + Mini App static (Railway / Docker)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
ARG VITE_API_BASE_URL=/api
ARG VITE_ALLOW_DEMO=true
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_ALLOW_DEMO=$VITE_ALLOW_DEMO
RUN npm run build -w @gatepass/shared \
 && npm run build -w @gatepass/api \
 && npm run build -w @gatepass/web

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y libstdc++6 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/gatepass.db
ENV STATIC_DIR=/app/apps/web/dist
# Demo purchases allowed when client sends demo:true; real Pay txs still verified on-chain
ENV SKIP_TX_VERIFY=true
ENV NIMIQ_NETWORK=mainnet
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/package.json ./
EXPOSE 8080
CMD ["node", "apps/api/dist/index.js"]

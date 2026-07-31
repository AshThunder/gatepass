FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install --workspace=@gatepass/shared --workspace=@gatepass/api

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @gatepass/shared && npm run build -w @gatepass/api

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y libstdc++6 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=8787
ENV DB_PATH=/data/gatepass.db
ENV SKIP_TX_VERIFY=true
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/package.json ./
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "apps/api/dist/index.js"]

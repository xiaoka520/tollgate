# ---- build stage ----------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ---- runtime stage --------------------------------------------------------
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8099 \
    TOLLGATE_DATA_DIR=/data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY scripts ./scripts

VOLUME ["/data"]
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=6s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8099)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

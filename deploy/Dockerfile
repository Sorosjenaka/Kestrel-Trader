# Opsional (T-17): image produksi ArtaTrade server + web.
# Belum diuji runtime di VPS ini karena Docker tidak terpasang saat dibuat.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --include-workspace-root
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build -w @artatrade/server && npm run build -w @artatrade/web

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/prisma ./prisma
EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]

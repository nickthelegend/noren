# Noren hosted backend: the merchant server (packages/server/src/hosted.ts) and the ASP postman (packages/postman).
# Built from the repo root: docker build -f deploy/vps/noren-api/Dockerfile .
FROM node:24-slim
ENV CI=1
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter noren --filter "@noren/server..." --filter "@noren/postman..." && rm -rf /root/.cache /root/.local/share/pnpm/store
EXPOSE 8790 8788
CMD ["node_modules/.bin/tsx", "packages/server/src/hosted.ts"]

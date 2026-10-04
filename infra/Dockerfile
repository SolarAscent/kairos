FROM node:24-alpine AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-alpine AS api
WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=build --chown=node:node /workspace /workspace
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

FROM node:24-alpine AS worker
WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=build --chown=node:node /workspace /workspace
USER node
CMD ["node", "apps/worker/dist/main.js"]

FROM node:24-alpine AS demo
WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=build --chown=node:node /workspace /workspace
USER node
EXPOSE 4173
WORKDIR /workspace/apps/demo
CMD ["node", "node_modules/vite/bin/vite.js", "preview", "--host", "0.0.0.0", "--port", "4173"]

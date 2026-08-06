FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @clycites/kernel... build
RUN mkdir -p apps/kernel/dist/migrations \
  && cp apps/kernel/migrations/*.sql apps/kernel/dist/migrations/
RUN pnpm --filter @clycites/kernel deploy --prod --legacy /prod/kernel

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /prod/kernel ./

USER node
EXPOSE 3000

CMD ["node", "dist/src/main.js"]
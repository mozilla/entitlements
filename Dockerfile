FROM node:24.15.0-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*

ENV NX_DAEMON=true
ENV NX_NO_CLOUD=true
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack@0.36.0 && corepack enable
RUN chown node:node /app

USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && pnpm install --frozen-lockfile

COPY --chown=node:node tsconfig.base.json nx.json jest.preset.js jest.config.ts .eslintrc.json .prettierrc ./
COPY --chown=node:node apps apps
COPY --chown=node:node libs libs

CMD ["echo", "Must provide command to run containers"]

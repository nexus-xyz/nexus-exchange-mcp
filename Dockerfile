# Hosted Streamable HTTP MCP server (`nexus-exchange-mcp-http`).
#
# Node 22: the major the release workflow builds and publishes with, inside the
# `engines` floor (>=20) and CI's test matrix (20, 22).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MCP_HTTP_PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# `node` is the unprivileged user (uid 1000) the official image ships.
USER node
EXPOSE 8080
CMD ["node", "dist/http-index.js"]

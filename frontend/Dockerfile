# BiteBox web app: Angular with server-side rendering, served by Node.js.

# 1) Build
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# 2) Run (only the built output)
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/frontend ./dist/frontend
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1

# API_INTERNAL_URL (e.g. http://api:5000) lets server rendering reach the API directly.
CMD ["node", "dist/frontend/server/server.mjs"]

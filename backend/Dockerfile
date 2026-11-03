# BiteBox API: Node.js + Express. Production dependencies only, runs as the unprivileged "node" user.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
# Local image storage (used only when Cloudinary is not configured); mount a volume here.
RUN mkdir -p uploads && chown node:node uploads

USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5000/api/v1/health || exit 1

CMD ["node", "src/server.js"]

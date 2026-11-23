# Node 22: vitest 4 needs Map.groupBy (Node 21+) and node:util styleText (20.12+),
# so the runtime image and the test toolchain are the same line instead of two.
#
# The image compiles its own dist. It used to copy the host's dist, so a
# `docker compose build` after a source edit shipped the previous build and
# still reported success.
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]

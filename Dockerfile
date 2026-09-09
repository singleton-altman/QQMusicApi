FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production PORT=3300
WORKDIR /app
COPY --chown=node:node . ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
RUN mkdir -p /app/data/record && chown -R node:node /app/data
USER node
EXPOSE 3300
CMD ["node", "bin/www"]

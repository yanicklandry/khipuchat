# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm ci
COPY . .

# Stage 2: runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json .
COPY --from=builder /app/tsconfig.json .
ENV NODE_ENV=production
ENV HF_HOME=/app/.cache/huggingface
RUN npm link
CMD ["khipu", "mcp"]

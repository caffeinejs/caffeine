FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

WORKDIR /workspace

# Install root deps (library + build tooling)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build the library
COPY . .
RUN npm run build

WORKDIR /workspace/di/examples/04-fastify-cats-complete

EXPOSE 3000

CMD ["node", "--import", "tsx/esm", "src/index.ts"]

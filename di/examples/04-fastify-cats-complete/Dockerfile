FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94

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

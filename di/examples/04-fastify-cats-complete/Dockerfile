FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80

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

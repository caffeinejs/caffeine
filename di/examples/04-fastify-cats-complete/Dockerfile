FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

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

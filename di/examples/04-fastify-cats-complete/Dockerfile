FROM node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5

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

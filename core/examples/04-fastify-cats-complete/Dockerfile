FROM node:24-alpine

WORKDIR /workspace

# Install root deps (library + build tooling)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build the library
COPY . .
RUN npm run build

# Install example deps (tsx + app deps)
WORKDIR /workspace/examples/05-fastify-cats-complete
RUN npm install

EXPOSE 3000

CMD ["node", "--import", "tsx/esm", "src/index.ts"]

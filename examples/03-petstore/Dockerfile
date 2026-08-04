# Build context is the REPO ROOT (see docker-compose.yml) because the example depends on the
# unpublished @caffeinejs/* workspace packages, which must be built from source.
FROM node:22-bookworm-slim

# openssl + ca-certificates are required by Prisma's query engine on Debian slim.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install and build the whole monorepo (di, std, http, cli, ...).
COPY . .
RUN npm ci
RUN npm run build

# Generate the Prisma client + the caffeine DI registration file for the example.
WORKDIR /app/examples/03-petstore
RUN npx prisma generate && npx caffeine generate

EXPOSE 3000
CMD ["sh", "./docker-entrypoint.sh"]

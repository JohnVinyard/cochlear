# Development image shared by the install / migrate / api / web services.
# Source is bind-mounted from the host;  node_modules live in named volumes.
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=development \
    YARN_CACHE_FOLDER=/yarn-cache

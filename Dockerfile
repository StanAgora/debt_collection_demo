FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
ENV HOST=0.0.0.0 PORT=4173
EXPOSE 4173
CMD ["node", "server.js"]

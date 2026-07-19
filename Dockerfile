FROM node:24-alpine

RUN apk add --no-cache docker-cli tar unzip
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY bin ./bin
COPY assets/logo-mark.png ./assets/logo-mark.png
ENV HOST=0.0.0.0
ENV MC_HOST_DATA_DIR=/var/lib/open-mc-host
EXPOSE 3000
CMD ["node", "src/index.js"]

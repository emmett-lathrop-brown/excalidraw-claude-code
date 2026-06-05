FROM node:20-alpine

WORKDIR /app

COPY server/package.json ./server/
RUN cd server && npm install --omit=dev

COPY server/ ./server/
COPY client/ ./client/

RUN mkdir -p /data

EXPOSE 8080

ENV PORT=8080
ENV CHAT_DATA_FILE=/data/chat.json

CMD ["node", "/app/server/index.js"]

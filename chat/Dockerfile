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

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/__chat/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "/app/server/index.js"]

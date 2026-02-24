FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV TASK_ORG_DATA_DIR=/app/data

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["npm", "start"]

FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY migrations ./migrations
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["sh", "-c", "npm run migrate && npm start"]

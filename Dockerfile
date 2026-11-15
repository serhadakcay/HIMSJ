FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY . .
EXPOSE 3080
ENV PORT=3080
CMD ["node", "server.js"]

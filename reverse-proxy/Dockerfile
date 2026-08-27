FROM node:22-alpine
WORKDIR /home/app
COPY package*.json ./
RUN npm ci
COPY . .

EXPOSE 9000
CMD ["node", "index.js"]

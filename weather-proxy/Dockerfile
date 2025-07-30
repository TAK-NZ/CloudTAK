FROM node:18-alpine

# Install sharp dependencies
RUN apk add --no-cache \
    vips-dev

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

USER node

CMD ["npm", "start"]
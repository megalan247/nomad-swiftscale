FROM node:alpine
WORKDIR /appdata
COPY package.json .
RUN npm i
COPY . .
ENTRYPOINT [ "node", "app.js" ]
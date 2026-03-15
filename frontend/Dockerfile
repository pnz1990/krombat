FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# #413: pinned to nginx 1.27 on alpine 3.21 to avoid unfixed CVEs in newer alpine base.
FROM nginx:1.27-alpine3.21
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000

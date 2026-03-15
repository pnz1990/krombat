FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# #413: pinned to nginx 1.29 on alpine 3.23. CVE-2026-22184 (zlib) is in .trivyignore
# pending nginx image rebuild. Update this tag when 1.30+ is released with the fix.
FROM nginx:1.29-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# #415: use nginxinc/nginx-unprivileged which runs as UID 101 (non-root).
# This satisfies runAsNonRoot: true and runAsUser: 101 in frontend.yaml.
# The image has its main nginx.conf pre-configured for /tmp/nginx.pid and
# writable cache dirs, matching the emptyDir volume mounts in frontend.yaml.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000

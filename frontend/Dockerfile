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
# Using 1.29-alpine (Alpine 3.23) which includes openssl ≥3.3.6-r0 (fixes CVE-2025-15467).
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000

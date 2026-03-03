FROM alpine:3.20 AS build
RUN apk add --no-cache curl
RUN curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x kubectl

FROM alpine:3.20
RUN apk add --no-cache bash jq
COPY --from=build /kubectl /usr/local/bin/kubectl

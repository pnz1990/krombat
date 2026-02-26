FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /rpg-backend ./cmd/

FROM gcr.io/distroless/static-debian12
COPY --from=build /rpg-backend /rpg-backend
EXPOSE 8080
ENTRYPOINT ["/rpg-backend"]

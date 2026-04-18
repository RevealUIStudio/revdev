FROM golang:1.23-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /console .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates
COPY --from=builder /console /usr/local/bin/console

EXPOSE 2222
CMD ["console"]

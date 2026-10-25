FROM --platform=$BUILDPLATFORM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS build
WORKDIR /source
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o /output/relanox ./cmd/relanox
RUN mkdir -p /output/tmp /output/data && chmod 1777 /output/tmp && chown 10001:10001 /output/data

FROM scratch
COPY --from=build /output/relanox /relanox
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=build /usr/share/doc/ca-certificates/copyright /licenses/debian/ca-certificates-copyright
COPY --from=build /usr/share/doc/tzdata/copyright /licenses/debian/tzdata-copyright
COPY --from=build /output/tmp /tmp
COPY --from=build --chown=10001:10001 /output/data /data
COPY LICENSE /licenses/Relanox-LICENSE
USER 10001:10001
WORKDIR /data
ENV RELANOX_CONFIG=/config/relanox.json
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD ["/relanox", "doctor", "--management-url", "http://127.0.0.1:8788", "--json"]
ENTRYPOINT ["/relanox"]
CMD ["run"]

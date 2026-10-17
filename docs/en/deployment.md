# Deployment

Build the current Go checkout or use its CI binary artifact. Keep configuration,
credentials and state outside the executable directory. A release tag from before
the Go rewrite may contain the archived TypeScript distribution.

## Service and HTTPS proxy

The application defaults to `127.0.0.1:8787` and management to
`127.0.0.1:8788`. Publish only the application listener through an HTTPS reverse
proxy. Preserve the original Host header, including for OAuth discovery paths.
For example:

```caddy
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Set `http.publicUrl` to the same HTTPS origin. Native callbacks, OAuth, MCP and
temporary media URLs use that configured origin. A tunnel must preserve it too.
Management health and metrics remain on loopback; do not route them through the
public application listener.

```ini
[Unit]
Description=Relanox native messaging relay
After=network-online.target
Wants=network-online.target

[Service]
User=relanox
Group=relanox
WorkingDirectory=/var/lib/relanox
ExecStart=/usr/local/bin/relanox run --config /var/lib/relanox/relanox.json
Restart=on-failure
RestartSec=5
TimeoutStopSec=40
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Create that service user and writable data directory before enabling the unit.
Run onboarding as the same user so private credential files remain readable.
SQLite needs a writable parent directory; Muse must be able to persist credential
refreshes in its pairing directory.

## Container

```sh
docker build -t relanox:local .
```

The image contains the Go binary, CA certificates and license notices, runs as a
non-root user and has no Node.js runtime. Mount a private configuration directory
at `/config` and durable state at `/data`. For a container, set `http.listen` to
`0.0.0.0:8787`; the management listener must stay on loopback. Use
`storage.path = "/data/relanox.db"` for the SQLite volume. Ensure the configured
user can read credentials and write state before starting it.

```sh
docker run --rm --name relanox \
  --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:8787:8787 \
  -v "$PWD/config:/config" \
  -v "$PWD/data:/data" \
  relanox:local run --config /config/relanox.json
```

The example uses a host HTTPS proxy. Do not expose port 8788. Keep volumes across
restarts and include them in backups. A process restart should reopen the same
database, rather than recreate an empty configuration or change account IDs.

## Build and release validation

CI checks formatting, complexity/nesting, vet, Go tests, database protocols,
documentation rendering, binary builds and the production container. It uploads
artifacts for supported operating systems and architectures. A future release
workflow runs only for an explicitly pushed version tag and publishes that tag's
binary archives and container image. Pushing the Go rewrite to `master` does not
create a Release or publish a new version.

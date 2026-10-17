# Deployment

Build the current checkout or use its CI binary artifact. Keep configuration,
credentials and state outside the executable directory.

## Binary artifacts

A successful [CI run](https://github.com/relanox/relanox/actions/workflows/ci.yml)
uploads `relanox-<os>-<arch>` artifacts for `linux`, `darwin` and `windows`, each
on `amd64` and `arm64`. Select the run for the commit you intend to deploy.
Extract the downloaded artifact, then its `.tar.gz` or `.zip` archive; the
archive contains the executable, documentation and third-party notices.

Tagged releases use `relanox_<version>_<os>_<arch>` archive names and include
`checksums.txt`. Select assets matching that layout rather than assuming every
historical tag contains the current executable format. Keep the accompanying
`licenses/` directory when redistributing an archive.

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

The shared native HTTP transport connects directly and ignores `HTTP_PROXY` and
`HTTPS_PROXY` so destination-address checks cannot be bypassed through a proxy.
There is no global outbound proxy field in the JSON configuration.

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
non-root user. Mount a private configuration directory
at `/config` and durable state at `/data`. For a container, set `http.listen` to
`0.0.0.0:8787`; the management listener must stay on loopback. Use
`storage.path = "/data/relanox.db"` for the SQLite volume. Ensure the configured
user can read credentials and write state before starting it.

```sh
docker run --rm --name relanox --stop-timeout 40 \
  --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:8787:8787 \
  -v "$PWD/config:/config" \
  -v "$PWD/data:/data" \
  relanox:local run --config /config/relanox.json
```

The example uses a host HTTPS proxy. Do not expose port 8788. Keep volumes across
restarts and include them in backups. The 40-second container stop timeout exceeds
the application's 30-second shutdown deadline, matching `compose.yml`. A process
restart should reopen the same
database, rather than recreate an empty configuration or change account IDs.

## Build and release validation

CI runs formatting, complexity/nesting, vet, Go tests, module verification, Ent
generation checks and documentation builds on Linux, macOS and Windows. Linux
also runs the PostgreSQL integration tests, the full race suite and a regenerated
license-bundle comparison. Separate jobs build six binary archives and run
deployment tests against the production container.

The release workflow runs when a `v*` tag is pushed. After the same CI workflow
succeeds, it publishes the verified binary archives and checksums to GitHub
Releases and builds `linux/amd64` and `linux/arm64` images at
`ghcr.io/relanox/relanox:<tag>` with provenance and an SBOM. Pushing `master`
does not create a Release or publish a version.

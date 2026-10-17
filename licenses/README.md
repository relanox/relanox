# Third-party notices

Relanox is MIT-licensed. Its binary distributions and container also carry the
licenses of their dependencies. This directory is part of each distribution.

- `go/` contains readable dependency license and copyright notices.
- `modules.json` identifies the exact runtime modules, versions and Go module
  checksums across Linux, macOS and Windows on amd64 and arm64.
- `report.csv` records package license identifiers and upstream license URLs.
- `source-notices.tar.gz` retains the collector's complete output, including
  required source distributions for MPL-covered dependencies such as
  `maunium.net/go/mautrix`. Each module's exact version is in `modules.json`.
  These are unmodified dependency sources; Relanox's own source remains in this
  repository. The source archive also contains the original accompanying notices.
- `go-standard-library/LICENSE` covers the Go runtime and standard library.
  `modules.json` records the compiler version used when generating this bundle.
- `ports/` preserves notices for locally adapted Muse, QQ and DingTalk protocol
  code, which a runtime module scan cannot identify as separate dependencies.

Regenerate after changing native imports or versions, using the pinned Go
toolchain declared in `go.mod`:

```sh
go mod tidy
go run ./tools/licenses
go run ./tools/licenses -check
```

The collector is pinned to `github.com/google/go-licenses/v2@v2.0.1`. It scans the
actual executable dependency graph for all six distribution targets, rejects
unrecognized licenses, combines required sources without changing their bytes,
and writes a deterministic archive. The assembly notices produced by the
collector identify files that are included in the Go packages but cannot be
independently analyzed for additional dependencies; their module notices remain
included.

Container images also include Debian's CA certificate and timezone-data copyright
notices beside the copied CA bundle and zoneinfo data. Those files originate from
the pinned builder image rather than Go modules.

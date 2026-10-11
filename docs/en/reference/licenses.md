# Licenses

Relanox is released under the [MIT License](https://github.com/relanox/relanox/blob/master/LICENSE). You may use, modify and redistribute it, including commercially, provided you retain the copyright and license notice. The license includes the terms on warranty and liability.

## Redistributing Relanox

Include Relanox's license and the notices for the dependencies you distribute. The repository's [supplemental license files](https://github.com/relanox/relanox/tree/master/licenses) accompany the production dependencies. Dependency packages also retain their own license files in `node_modules`.

The package manifests and lockfile identify the exact versions. The shipped runtime uses dependencies under the following declared licenses:

| License       | Examples in the runtime                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| MIT           | Hono, Pino, better-sqlite3, PostgreSQL's `pg` client, Zod, `ws`, Standard Webhooks, Marked. |
| Apache-2.0    | Model Context Protocol packages, OpenTelemetry packages, Prometheus client.                 |
| BSD-2-Clause  | `entities`.                                                                                 |
| ISC           | `pg-int8` and `split2`.                                                                     |
| Unlicense     | `fast-sha256`.                                                                              |
| Public domain | SQLite embedded by better-sqlite3.                                                          |

The MIT texts for `pg-types` and `pgpass` are included in their README files. Standard Webhooks' missing archive license and the Prometheus client's missing upstream NOTICE are supplied in `licenses/` from the matching published upstream commits. Marked also retains the BSD-3-Clause notice for the original Markdown implementation in its license file. Development tools are separate from the production image.

If you change the production dependency set before redistributing, check the installed packages' license files and update the notices alongside the dependency change. See [Contributing](../development.md) for dependency maintenance.

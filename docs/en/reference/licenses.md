# Licenses

Relanox is released under the [MIT License](https://github.com/relanox/relanox/blob/master/LICENSE). You may use, modify and redistribute it, including commercially, provided you retain the copyright and license notice. The license includes the terms on warranty and liability.

## Redistributing Relanox

Include Relanox's license and the notices for the dependencies you distribute. The repository's [supplemental license files](https://github.com/relanox/relanox/tree/master/licenses) accompany the production dependencies. Dependency packages also retain their own license files in `node_modules`.

The package manifests and lockfile identify the exact versions. The shipped runtime uses dependencies under the following declared licenses:

| License       | Examples in the runtime                                                                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIT           | Hono, Pino, better-sqlite3, PostgreSQL's `pg` client, Zod, `ws`, Standard Webhooks, Marked, `mime-types`, `mime-db`, `file-type`, `silk-wasm`, `@tencent-connect/qqbot-nodejs`, `eventsource-parser`, `ipaddr.js`, `proper-lockfile`, `retry`. |
| Apache-2.0    | Model Context Protocol packages, OpenTelemetry packages, Prometheus client, Drizzle ORM, Tencent Cloud ASR SDK and its common package, `google-auth-library`, `simple-oauth2`.                                                                 |
| BSD-2-Clause  | `entities`.                                                                                                                                                                                                                                    |
| BSD-3-Clause  | `buffer-equal-constant-time`, Joi and its Hapi dependencies.                                                                                                                                                                                   |
| ISC           | `pg-int8`, `split2`, `ini`, `graceful-fs` and `signal-exit`.                                                                                                                                                                                   |
| 0BSD          | `tslib`.                                                                                                                                                                                                                                       |
| Unlicense     | `fast-sha256`.                                                                                                                                                                                                                                 |
| Public domain | SQLite embedded by better-sqlite3.                                                                                                                                                                                                             |

The MIT texts for `pg-types`, `pgpass` and `data-uri-to-buffer` are included in their README files. Standard Webhooks' missing archive license and the Prometheus client's missing upstream NOTICE are supplied in `licenses/` from the matching published upstream commits. Marked also retains the BSD-3-Clause notice for the original Markdown implementation in its license file. Development tools are separate from the production image.

Drizzle ORM 0.45.4 declares Apache-2.0 but omits the license text from its published package. `licenses/drizzle-orm.LICENSE` supplies the text from its [release commit](https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/LICENSE).

simple-oauth2 5.1.0 declares Apache-2.0 in its [release metadata](https://github.com/lelylan/simple-oauth2/blob/a4a4486b8f4c6d2af82969211052f445c50c1b11/package.json) but omits the license text from its published package. `licenses/simple-oauth2.LICENSE` includes that attribution and the standard Apache-2.0 text. Its Hapi and Joi dependencies retain their BSD-3-Clause notices in their packages.

If you change the production dependency set before redistributing, check the installed packages' license files and update the notices alongside the dependency change. See [Contributing](../development.md) for dependency maintenance.

The bundled codecs in silk-wasm retain the BSD-2-Clause Silk wrapper and Skype's SILK SDK BSD notice. Their matching published source notices, and the bundled MIT wav-file-decoder notice, are included in licenses/ alongside the package's MIT license.

The Tencent Cloud SDK packages include their Apache-2.0 license files. The MIT texts for its `https-proxy-agent` and `agent-base` dependencies are in their README files; `tslib` includes both its 0BSD license and copyright notice. `tr46` 0.0.3 declares MIT but omits the license text; `licenses/tr46.LICENSE` supplies the upstream text from the [commit that added the missing license](https://github.com/jsdom/tr46/blob/3a6f29721e7063b9ffd421e461a54beae6170001/LICENSE.md).

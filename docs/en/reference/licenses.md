# Licenses

Relanox is released under the [MIT License](https://github.com/relanox/relanox/blob/master/LICENSE). You may use, modify and redistribute it, including commercially, provided you retain the copyright and license notice. The license includes the terms on warranty and liability.

## Redistributing Relanox

Include Relanox's license and the notices for the dependencies you distribute. The repository's [supplemental license files](https://github.com/relanox/relanox/tree/master/licenses) accompany the production dependencies. Dependency packages also retain their own license files in `node_modules`.

The package manifests and lockfile identify the exact versions. The shipped runtime uses dependencies under the following declared licenses:

| License       | Examples in the runtime                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MIT           | Hono, Pino, better-sqlite3, PostgreSQL's `pg` client, Zod, `ws`, Standard Webhooks, Marked, `file-type`, `silk-wasm`, the QQ, Feishu, Slack, WeCom and Teams SDKs, the published Mattermost client and types packages.   |
| Apache-2.0    | Model Context Protocol packages, OpenTelemetry packages, Prometheus client, Drizzle ORM, Tencent Cloud ASR SDK, Matrix SDKs, LINE SDK, Google Chat API and authentication libraries, several Alibaba Cloud SDK packages. |
| BSD-2-Clause  | `entities`.                                                                                                                                                                                                              |
| BSD-3-Clause  | `buffer-equal-constant-time`, `protobufjs`, its `@protobufjs/*` helpers, `qs`, `ieee754` and `url-template` (whose metadata uses the shorter label `BSD`).                                                               |
| ISC           | `pg-int8`, `split2`, `ini`, `graceful-fs`, `signal-exit`, `semver` and several Alibaba Cloud package declarations; see the differing declarations below.                                                                 |
| BlueOak-1.0.0 | `sax` 1.6.1, which includes the complete Blue Oak Model License 1.0.0 in its `LICENSE.md`.                                                                                                                               |
| 0BSD          | `tslib`.                                                                                                                                                                                                                 |
| Unlicense     | `fast-sha256`.                                                                                                                                                                                                           |
| Public domain | SQLite embedded by better-sqlite3.                                                                                                                                                                                       |

The MIT texts for `pg-types`, `pgpass`, `data-uri-to-buffer`, `@tokenizer/token`, `http-proxy-agent` 5.0.0 and `socks-proxy-agent` 6.2.1 are included in their README files. Standard Webhooks' missing archive license and the Prometheus client's missing upstream NOTICE are supplied in `licenses/` from the matching published upstream commits. Marked also retains the BSD-3-Clause notice for the original Markdown implementation in its license file. Development tools are separate from the production image.

Drizzle ORM 0.45.4 declares Apache-2.0 but omits the license text from its published package. `licenses/drizzle-orm.LICENSE` supplies the text from its [release commit](https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/LICENSE).

Several official SDK packages omit standalone license files from their published archives. [The supplemental SDK notice](https://github.com/relanox/relanox/blob/master/licenses/sdk-dependencies.NOTICE) records the exact package versions, published declarations and text sources. The Teams 2.1.0 packages and Google Chat 51.2.0 have supplemental copies of their matching upstream license files. WeCom 1.0.7, the listed Alibaba Cloud packages, `httpx` 2.3.3 and `sm3` 1.0.3 have their published metadata and README declarations recorded alongside the corresponding standard license texts. Those standard texts are supplements, not purported missing upstream files; no copyright holder is inferred.

Two Alibaba Cloud packages have inconsistent published declarations: `@alicloud/openapi-client` 0.4.15 declares ISC in `package.json` and Apache-2.0 in its README; `@alicloud/tea-typescript` 1.8.0 declares ISC in `package.json` and MIT in its README. The notice preserves each declaration and supplies both referenced texts. It does not establish dual licensing or resolve the inconsistency.

The published `@mattermost/client` and `@mattermost/types` 11.9.0 packages declare MIT. Their [matching upstream policy](https://github.com/mattermost/mattermost/blob/583461af10fc9b2aef2871c722fc4376db695832/LICENSE.txt) distinguishes official compiled distributions under MIT from `webapp` source under Apache-2.0. `licenses/mattermost-compiled.LICENSE` and `licenses/mattermost-source.LICENSE` retain both original documents. The policy's other source-code terms are not a claim that these npm packages declare those licenses.

If you change the production dependency set before redistributing, check the installed packages' license files and update the notices alongside the dependency change. See [Contributing](../development.md) for dependency maintenance.

The bundled codecs in silk-wasm retain the BSD-2-Clause Silk wrapper and Skype's SILK SDK BSD notice. Their matching published source notices, and the bundled MIT wav-file-decoder notice, are included in licenses/ alongside the package's MIT license.

The Tencent Cloud SDK packages include their Apache-2.0 license files. The MIT texts for its `https-proxy-agent` and `agent-base` dependencies are in their README files; `tslib` includes both its 0BSD license and copyright notice. `tr46` 0.0.3 declares MIT but omits the license text; `licenses/tr46.LICENSE` supplies the upstream text from the [commit that added the missing license](https://github.com/jsdom/tr46/blob/3a6f29721e7063b9ffd421e461a54beae6170001/LICENSE.md).

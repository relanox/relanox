# 部署

从当前代码构建，或使用其 CI 二进制产物。配置、凭据和持久状态独立于可执行文件保存。

## 二进制产物

成功的 [CI 运行](https://github.com/relanox/relanox/actions/workflows/ci.yml) 会上传
`relanox-<os>-<arch>` 产物，支持 `linux`、`darwin`、`windows`，各有 `amd64` 和 `arm64`。
选择准备部署的提交所对应的运行。解开下载的产物后，再解开其中的 `.tar.gz` 或 `.zip`；
归档包含可执行文件、文档和项目许可。

版本发布使用 `relanox_<version>_<os>_<arch>` 归档名，并提供 `checksums.txt`。选择符合
该布局的资产，不要假定所有历史 tag 都包含当前可执行文件格式。

## 常驻服务与 HTTPS

应用默认监听 `127.0.0.1:8787`，管理默认 `127.0.0.1:8788`。通过 HTTPS 反向代理只
发布应用监听，保留原始 Host，包括 OAuth 发现路径。例如 Caddy：

```text
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

`http.publicUrl` 使用同一 HTTPS origin。回调、OAuth、MCP 和临时媒体 URL 都以该配置
生成；隧道也需要保留 Host。管理健康与指标留在回环监听，不通过公网应用路由发布。

共用原生 HTTP transport 直接连接目标，不使用 `HTTP_PROXY` 和 `HTTPS_PROXY`，
以免代理绕过目标地址检查。JSON 配置没有全局出站代理字段。

Linux 可以使用 systemd，具体 unit 见[英文部署说明](../en/deployment.md#service-and-https-proxy)。
使用专用低权限用户运行，并让引导和服务使用同一用户。SQLite 父目录、Muse 配对目录
必须可写，凭据文件必须可读。服务退出等待时间应大于程序的关闭期限。

## 容器

```sh
docker build -t relanox:local .
```

镜像包含 Go 二进制、CA 和许可文件，使用非 root 用户。配置目录挂载到
`/config`，持久状态到 `/data`。容器内将 `http.listen` 设置为 `0.0.0.0:8787`，管理仍
绑定回环；SQLite 使用 `storage.path = "/data/relanox.db"`。启动前保证指定用户可读
凭据、可写数据。

```sh
docker run --rm --name relanox --stop-timeout 40 \
  --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:8787:8787 \
  -v "$PWD/config:/config" \
  -v "$PWD/data:/data" \
  relanox:local run --config /config/relanox.json
```

示例由宿主提供 HTTPS 代理，不发布 8788。40 秒容器停止期限与 `compose.yml` 一致，
大于应用默认的 15 秒关闭期限。若调整 `http.shutdownTimeoutSeconds`，容器期限也应保持更长。
重启时保留卷并纳入备份，重新打开原数据库，
不要创建空配置或改变账号 ID。

## 构建与发布

CI 在 Linux、macOS 和 Windows 上检查格式、复杂度、嵌套、vet、Go 测试、模块校验、
Ent 生成一致性和文档构建。Linux 另运行 PostgreSQL 集成测试和完整竞态测试。
独立任务构建六种二进制归档，并对生产容器运行部署测试。

发布工作流在推送 `v*` tag 后运行。同一套 CI 通过后，将已验证的二进制归档和校验和
发布到 GitHub Releases，并构建 `linux/amd64`、`linux/arm64` 镜像，推送至
`ghcr.io/relanox/relanox:<tag>`，附带来源证明和 SBOM。推送 `master` 不会创建 Release
或发布版本。

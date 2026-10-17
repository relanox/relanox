# 部署

从当前代码构建，或使用其 CI 二进制产物。配置、凭据和持久状态独立于可执行文件保存。

## 常驻服务与 HTTPS

应用默认监听 `127.0.0.1:8787`，管理默认 `127.0.0.1:8788`。通过 HTTPS 反向代理只
发布应用监听，保留原始 Host，包括 OAuth 发现路径。例如 Caddy：

```caddy
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

`http.publicUrl` 使用同一 HTTPS origin。回调、OAuth、MCP 和临时媒体 URL 都以该配置
生成；隧道也需要保留 Host。管理健康与指标留在回环监听，不通过公网应用路由发布。

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
docker run --rm --name relanox \
  --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:8787:8787 \
  -v "$PWD/config:/config" \
  -v "$PWD/data:/data" \
  relanox:local run --config /config/relanox.json
```

示例由宿主提供 HTTPS 代理，不发布 8788。重启时保留卷并纳入备份，重新打开原数据库，
不要创建空配置或改变账号 ID。

## 构建与发布

CI 检查格式、复杂度、嵌套、vet、Go 测试、数据库协议、文档、二进制与生产镜像，并上传
各系统、架构的产物。未来发布工作流只在显式推送版本 tag 时运行，发布该 tag 的二进制
归档和镜像。将 Go 重写推送至 `master` 不会自行创建 Release 或发布版本。

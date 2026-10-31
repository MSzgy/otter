# otter-relay

让手机在外面（不和 Mac 在同一个 Wi-Fi）也能连到 Mac 上的 Otter。它只转发数据：手机和 Mac 之间的握手和每一帧都是端到端加密的，中继看到的只有密文。

```
iPhone ──wss/ws──► otter-relay ◄──ws── Mac（Otter）
         /join?room=R            /host?room=R（带令牌）
                                 /accept?room=R&peer=P（带令牌）
```

- Mac 带着令牌连上 `/host`，占住自己的房间（一个只有 Mac 和配对过的手机知道的随机 id）。
- 手机连 `/join?room=R`；中继通知 Mac，Mac 用 `/accept` 回一条线，中继把两条线接起来，原样转发，关闭码也原样传过去（比如 Mac 撤销手机时的 4003）。
- 没有令牌就不能当某个房间的 Mac；Mac 不在线时手机收到 4404；Mac 10 秒内没回应是 4504；一个房间最多 8 部手机（4429）。

## 部署

最简单：在 Mac 上的 Otter 里，设置 → 手机 → 在外面也能连 → 部署到我的服务器，选一台在“SSH 服务器”里保存过的 Linux。Otter 会：

1. 看服务器是 x86_64 还是 aarch64，上传对应的程序（约 6 MB）。
2. 用 root 登录时：装到 `/opt/otter-relay`，建一个受限的 systemd 服务（`DynamicUser`、只读文件系统、令牌通过 `LoadCredential` 传入），开机自启；开着 ufw 或 iptables 时放行端口。
   不是 root：装到 `~/.otter-relay`，用 nohup 启动，并在 crontab 里加 `@reboot`。
3. 从 Mac 上检查能不能连上；连不上多半是云服务商的防火墙（安全组 / Oracle 的安全列表）没放行这个端口，要到控制台里加一条入站规则。

手动部署：

```bash
cd relay && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o otter-relay .
```

```bash
openssl rand -base64 32 | tr -d '\n' > token && chmod 600 token
```

```bash
./otter-relay -listen :8787 -token-file token
```

然后在 Otter 里点“已有中继”，填 `ws://服务器IP:8787` 和同一个令牌。

## 加上 TLS（可选）

内容本身已经端到端加密；TLS 额外藏住了令牌和房间号，也更不容易被网络设备干扰。有域名的话，用 `-cert`/`-key` 直接提供 wss，或者放在 Caddy / nginx 后面，然后在 Otter 里填 `wss://你的域名`。

## 开发

```bash
go test -race ./...
```

`desktop/scripts/build_relay.cjs` 会把它编译成 Linux amd64、arm64 和本机版本，打包时 Linux 版本随 Otter 一起分发；`desktop/electron/relay.test.cjs` 用本机版本测试真实的连接、重连和通过 SSH 部署。

// 外网访问: the Mac's side of otter-relay (relay/ in this repo), a small
// program on a server of the user's that lets phones away from home reach
// this Mac. The Mac keeps one control line open; for each phone the relay
// announces, it opens an answer line and hands it to MobileLink exactly like
// a phone on the local network. The relay joins sockets and nothing else:
// the handshake and every frame stay end to end between phone and Mac.
//
// Also here: checking a relay, and deploying one to a saved SSH server.
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const WebSocket = require("ws");

const RETRY = [1000, 2000, 5000, 10000, 30000];
const PING_EVERY = 25000;
const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

// ws://host:port or wss://host[:port], nothing after it.
function cleanUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error(
      "中继地址要像 ws://1.2.3.4:8787 或 wss://relay.example.com。",
    );
  }
  if (!["ws:", "wss:"].includes(url.protocol) || !url.hostname)
    throw new Error("中继地址要以 ws:// 或 wss:// 开头。");
  if (url.pathname !== "/" || url.search || url.hash || url.username)
    throw new Error("中继地址只写到主机和端口，后面不要带路径。");
  return `${url.protocol}//${url.host}`;
}
const newRoom = () => b64u(randomBytes(16));
const newToken = () => b64u(randomBytes(32));

class RelayClient {
  constructor({ url, token, room, onPeer, onChange = () => {} }) {
    Object.assign(this, { url, token, room, onPeer, onChange });
    this.status = "connecting";
    this.error = "";
    this.rtt = null;
    this.tries = 0;
    this.stopped = false;
  }
  headers() {
    return { Authorization: `Bearer ${this.token}` };
  }
  snapshot() {
    return { status: this.status, error: this.error, rtt: this.rtt };
  }
  set(status, error = "") {
    this.status = status;
    this.error = error;
    this.onChange();
  }
  start() {
    if (this.stopped) return;
    const socket = new WebSocket(
      `${this.url}/host?room=${encodeURIComponent(this.room)}`,
      { headers: this.headers(), handshakeTimeout: 8000 },
    );
    this.socket = socket;
    let ended = false;
    // Every way this line can end comes here once, and tries again later.
    const end = (error, wait) => {
      if (ended || this.stopped) return;
      ended = true;
      clearInterval(this.ping);
      this.set("offline", error);
      this.timer = setTimeout(
        () => this.start(),
        wait ?? RETRY[Math.min(this.tries++, RETRY.length - 1)],
      );
    };
    // A refused upgrade fires no close event, so it ends the line here.
    socket.on("unexpected-response", (req, res) => {
      req.destroy();
      if (res.statusCode === 401) end("中继不认这个令牌。", 60000);
      else end(`中继拒绝了（HTTP ${res.statusCode}）。`);
    });
    socket.on("open", () => {
      this.tries = 0;
      this.set("online");
      this.ping = setInterval(() => {
        this.pingAt = Date.now();
        socket.ping();
      }, PING_EVERY);
      this.pingAt = Date.now();
      socket.ping();
    });
    socket.on("pong", () => {
      this.rtt = Date.now() - this.pingAt;
      this.onChange();
    });
    socket.on("message", (data, binary) => {
      if (binary) return;
      try {
        const note = JSON.parse(String(data));
        if (note.t === "peer" && typeof note.id === "string")
          this.answer(note.id);
      } catch {
        // not a note
      }
    });
    socket.on("error", (e) =>
      end(
        e.code === "ECONNREFUSED"
          ? "连不上中继：端口没开或程序没在运行。"
          : `连不上中继：${e.message}`,
      ),
    );
    socket.on("close", (code) =>
      end(
        code === 4009
          ? "同一个房间被另一台 Mac 占用了。"
          : "和中继的连接断了，正在重连。",
      ),
    );
  }
  // One phone: an answer line, handed over like a local connection.
  answer(peer) {
    const socket = new WebSocket(
      `${this.url}/accept?room=${encodeURIComponent(this.room)}&peer=${encodeURIComponent(peer)}`,
      { headers: this.headers(), handshakeTimeout: 8000 },
    );
    socket.on("error", () => {});
    socket.on("open", () => this.onPeer(socket));
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    this.socket?.terminate();
  }
}

// GET <relay>/health, then a moment as a Mac with the token on a throwaway
// room: says plainly what is wrong (address, port, token).
async function checkRelay({ url, token }) {
  const base = cleanUrl(url);
  const health = base.replace(/^ws/, "http") + "/health";
  const get = health.startsWith("https") ? https.get : http.get;
  const reachable = await new Promise((resolve) => {
    const req = get(health, { timeout: 6000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () =>
        resolve(res.statusCode === 200 && body.trim() === "ok"),
      );
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(false));
  });
  if (!reachable)
    return {
      ok: false,
      message:
        "连不上中继。检查地址和端口；如果刚部署，多半是云服务商的防火墙（安全组 / 安全列表）没放行这个端口。",
    };
  const accepted = await new Promise((resolve) => {
    const socket = new WebSocket(`${base}/host?room=${newRoom()}`, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 6000,
    });
    socket.on("open", () => {
      socket.close();
      resolve(true);
    });
    socket.on("unexpected-response", (req) => {
      req.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
  return accepted
    ? { ok: true, message: "中继能用。" }
    : { ok: false, message: "中继在运行，但不认这个令牌。" };
}

// The script that installs and starts the relay on the server: a hardened
// systemd service when logged in as root, else the user's own copy started
// with nohup and again at reboot via cron. Opens the port in ufw/iptables
// when it can (root); a cloud provider's own firewall it cannot reach.
// listen: the address to bind ("" = all; "127.0.0.1" behind a reverse
// proxy on the same server). firewall: open the port in ufw/iptables.
function installScript({
  port,
  token,
  dir,
  upload,
  listen = "",
  firewall = true,
}) {
  return `set -e
UPLOAD="${upload}"
PORT=${Number(port)}
LISTEN="${listen}:${Number(port)}"
TOKEN='${token}'
umask 077
if [ "$(id -u)" = 0 ] && command -v systemctl >/dev/null 2>&1 && [ -z "${dir}" ]; then
  D=/opt/otter-relay
  mkdir -p "$D"
  mv -f "$UPLOAD" "$D/otter-relay"
  chown root:root "$D/otter-relay"
  chmod 755 "$D" "$D/otter-relay"
  printf '%s' "$TOKEN" > "$D/token"
  chmod 600 "$D/token"
  # systemd 247+ hands the token over with LoadCredential to a throwaway
  # user; older ones (Ubuntu 20.04 has 245) get a system user of its own.
  if [ "$(systemctl --version | head -1 | awk '{print $2}')" -ge 247 ]; then
    RUN="DynamicUser=yes
LoadCredential=token:$D/token"
    TOKENFILE='\${CREDENTIALS_DIRECTORY}/token'
  else
    id otter-relay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin otter-relay
    chown otter-relay "$D/token"
    RUN="User=otter-relay"
    TOKENFILE="$D/token"
  fi
  cat > /etc/systemd/system/otter-relay.service <<UNIT
[Unit]
Description=Otter relay (phone to Mac, end-to-end encrypted)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$D/otter-relay -listen $LISTEN -token-file $TOKENFILE
$RUN
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable otter-relay >/dev/null 2>&1
  systemctl restart otter-relay
  if [ "${firewall ? 1 : 0}" = 1 ] && command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "$PORT/tcp" >/dev/null
  fi
  if [ "${firewall ? 1 : 0}" = 1 ] && command -v iptables >/dev/null 2>&1 && iptables -S INPUT 2>/dev/null | grep -q -- "-j REJECT"; then
    iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$PORT" -j ACCEPT
    command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1 || true
  fi
  sleep 1
  systemctl is-active --quiet otter-relay && echo "otter-relay: systemd"
else
  D="${dir || "$HOME/.otter-relay"}"
  mkdir -p "$D"
  mv -f "$UPLOAD" "$D/otter-relay"
  chmod 700 "$D/otter-relay"
  printf '%s' "$TOKEN" > "$D/token"
  pkill -f "$D/otter-relay" 2>/dev/null || true
  nohup "$D/otter-relay" -listen "$LISTEN" -token-file "$D/token" >> "$D/relay.log" 2>&1 &
  if [ -z "${dir}" ] && command -v crontab >/dev/null 2>&1; then
    (crontab -l 2>/dev/null | grep -v otter-relay; echo "@reboot $D/otter-relay -listen $LISTEN -token-file $D/token >> $D/relay.log 2>&1") | crontab -
  fi
  sleep 1
  pgrep -f "$D/otter-relay" >/dev/null && echo "otter-relay: nohup $D"
fi
`;
}

// Deploys otter-relay to one of the user's SSH servers and checks it from
// here. ssh: SshManager; binaries: folder with otter-relay-<os>-<arch>.
// dir (tests): install there, no service or cron.
// listen/firewall: see installScript; publicUrl: where phones reach it
// when a reverse proxy (nginx, say) fronts it.
async function deployRelay({
  ssh,
  server,
  port = 8787,
  binaries,
  dir = "",
  publicHost,
  publicUrl,
  listen = "",
  firewall = true,
}) {
  const host = ssh.find(server);
  const step = async (command, options = {}) => {
    const r = await ssh.run(host.id, command, { timeout: 120000, ...options });
    if (r.code !== 0)
      throw new Error(
        r.timedOut
          ? `${host.name} 上的操作超时了。`
          : `${host.name} 上出错了：${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `退出码 ${r.code}`}`,
      );
    return r.stdout;
  };
  const [os, machine] = (await step("uname -sm")).trim().split(/\s+/);
  const arch = {
    x86_64: "amd64",
    amd64: "amd64",
    aarch64: "arm64",
    arm64: "arm64",
  }[machine];
  const binary = path.join(binaries, `otter-relay-${os.toLowerCase()}-${arch}`);
  if (!arch || !fs.existsSync(binary))
    throw new Error(`${host.name} 是 ${os} ${machine}，还没有给它的中继程序。`);
  // An absolute upload path: sudo may move $HOME to /root.
  const home = (await step('printf %s "$HOME"')).trim();
  const upload = dir
    ? `${dir}/otter-relay.upload`
    : `${home}/.otter-relay-upload`;
  await step(`mkdir -p "${path.posix.dirname(upload)}" && cat > "${upload}"`, {
    input: fs.readFileSync(binary),
  });
  // Root installs a system service; so can a login with password-less sudo.
  const who = dir
    ? "user"
    : (
        await step(
          'if [ "$(id -u)" = 0 ]; then echo root; elif sudo -n true 2>/dev/null; then echo sudo; else echo user; fi',
        )
      ).trim();
  const token = newToken();
  const how = await step(who === "sudo" ? "sudo -n sh -s" : "sh -s", {
    input: installScript({ port, token, dir, upload, listen, firewall }),
  });
  if (!/otter-relay:/.test(how))
    throw new Error(`${host.name} 上的中继没能启动。`);
  const url = publicUrl
    ? cleanUrl(publicUrl)
    : `ws://${publicHost || host.host}:${port}`;
  const check = await checkRelay({ url, token });
  return {
    url,
    token,
    how: how.includes("systemd") ? "systemd" : "nohup",
    reachable: check.ok,
    message: check.ok
      ? `已在 ${host.name} 上部署好中继（${how.includes("systemd") ? "系统服务，开机自启" : "用户进程，开机由 cron 拉起"}）。`
      : `中继已在 ${host.name} 上运行，但从这里连不上 ${url}。多半是云服务商的防火墙没放行 TCP ${port}：到控制台的安全组 / 安全列表里加一条入站规则，再点“测试”。`,
  };
}

module.exports = {
  RelayClient,
  checkRelay,
  deployRelay,
  installScript,
  cleanUrl,
  newRoom,
  newToken,
};

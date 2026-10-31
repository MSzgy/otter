// SSH 服务器: the servers the user logs into, kept in one place.
//
// Otter's own entries live in preferences (name, host, port, user, how to log
// in, key file, jump host); a password, if any, goes to the macOS keychain and
// nowhere else. Hosts in ~/.ssh/config are listed too, read in place.
//
// Connecting opens Terminal with the system ssh. Background commands (a test,
// or a command the user approved in chat) run the same ssh without a
// terminal. A password reaches ssh through SSH_ASKPASS: a tiny script that
// reads it from the keychain, only for password prompts. New host keys are
// accepted and remembered in Otter's own known_hosts; a changed key fails.
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const SERVICE = "Otter SSH";
const MAX_OUTPUT = 64 * 1024;
const NAME = /^[\w一-鿿][\w一-鿿 .-]{0,39}$/;
const HOST = /^[A-Za-z0-9_.:[\]-]{1,253}$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const JUMP = /^[A-Za-z0-9_][A-Za-z0-9._@:[\]-]{0,252}$/;
const AUTH = { key: "SSH 密钥", agent: "ssh-agent", password: "密码" };

// ~/.ssh/config: Host blocks without wildcards, with the few keys we show.
// Follows Include (files or a glob in the last part), relative to ~/.ssh.
function parseSshConfig(file, home, depth = 0, found = []) {
  if (depth > 5 || !fs.existsSync(file)) return found;
  let current = null;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^(\S+)\s*=?\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, "$1");
    if (key === "include") {
      for (const pattern of value.split(/\s+/)) {
        const full = path.resolve(
          path.join(home, ".ssh"),
          pattern.replace(/^~(?=\/)/, home),
        );
        const dir = path.dirname(full),
          base = path.basename(full);
        if (!base.includes("*")) parseSshConfig(full, home, depth + 1, found);
        else if (fs.existsSync(dir)) {
          const match = new RegExp(
            "^" +
              base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
              "$",
          );
          for (const name of fs.readdirSync(dir).sort())
            if (match.test(name))
              parseSshConfig(path.join(dir, name), home, depth + 1, found);
        }
      }
      continue;
    }
    if (key === "host") {
      const names = value.split(/\s+/).filter((n) => n && !/[*?!]/.test(n));
      current = names.length ? { names, settings: {} } : null;
      if (current) found.push(current);
      continue;
    }
    if (key === "match") {
      current = null;
      continue;
    }
    if (current && !(key in current.settings)) current.settings[key] = value;
  }
  return found;
}

function configHosts(home) {
  const blocks = parseSshConfig(path.join(home, ".ssh", "config"), home);
  const hosts = [];
  for (const { names, settings } of blocks)
    for (const alias of names)
      if (!hosts.some((h) => h.alias === alias))
        hosts.push({
          id: `config:${alias}`,
          source: "config",
          name: alias,
          alias,
          host: settings.hostname || alias,
          user: settings.user || "",
          port: Number(settings.port) || 22,
          keyPath: settings.identityfile || "",
          jump: settings.proxyjump || "",
        });
  return hosts;
}

// Single-quoted for a shell script.
const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
// Double-quoted inside an ssh -o value.
const optionQuote = (value) => `"${String(value).replace(/(["\\])/g, "\\$1")}"`;

// What ssh reports, said plainly.
function explain(stderr, code) {
  const text = String(stderr || "");
  if (
    /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(
      text,
    )
  )
    return "服务器的主机密钥变了：可能是服务器重装过，也可能有人冒充。请自己确认后，再从 known_hosts 里删掉旧记录。";
  if (/Permission denied/i.test(text))
    return "登录被拒绝：用户名、密钥或密码不对，或者服务器不允许这种登录方式。";
  if (/Could not resolve hostname/i.test(text)) return "找不到这个主机名。";
  if (/Connection refused/i.test(text))
    return "服务器拒绝连接：端口不对，或者 SSH 服务没开。";
  if (/timed out|Operation timed out|No route to host/i.test(text))
    return "连不上服务器：检查地址、端口和网络（是否需要 VPN 或跳板机）。";
  if (/no such identity|Identity file .* not accessible/i.test(text))
    return "找不到密钥文件。";
  const last = text.trim().split("\n").pop();
  return last
    ? `ssh 出错（${code}）：${last.slice(0, 200)}`
    : `ssh 出错（${code}）。`;
}

// The keychain, through /usr/bin/security. Passwords are written on stdin
// (security -i), never as command-line arguments, and stored base64-encoded
// so they read back exactly. keychain is a test-only path to a scratch file.
class SshKeychain {
  constructor({ security = "/usr/bin/security", keychain = null } = {}) {
    Object.assign(this, { security, keychain });
  }
  tail() {
    return this.keychain ? [this.keychain] : [];
  }
  set(id, password) {
    const quote = (s) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
    const value = Buffer.from(password, "utf8").toString("base64");
    const line = [
      "add-generic-password -U",
      `-s ${quote(SERVICE)} -a ${quote(id)} -w ${quote(value)}`,
      ...this.tail().map(quote),
    ].join(" ");
    return new Promise((resolve, reject) => {
      const child = spawn(this.security, ["-i"], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let error = "";
      child.stderr.on("data", (c) => (error += c));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 && !error.trim()
          ? resolve()
          : reject(new Error("没能把密码存进钥匙串。")),
      );
      child.stdin.end(line + "\n");
    });
  }
  run(args) {
    return new Promise((resolve) =>
      execFile(this.security, [...args, ...this.tail()], (error, stdout) =>
        resolve({ ok: !error, stdout: String(stdout) }),
      ),
    );
  }
  async has(id) {
    return (await this.run(["find-generic-password", "-s", SERVICE, "-a", id]))
      .ok;
  }
  async remove(id) {
    await this.run(["delete-generic-password", "-s", SERVICE, "-a", id]);
  }
}

class SshManager {
  constructor({
    load,
    save,
    dir,
    home,
    keychain = new SshKeychain(),
    ssh = "/usr/bin/ssh",
    openFile = (file) =>
      new Promise((resolve, reject) =>
        execFile("/usr/bin/open", ["-a", "Terminal", file], (e) =>
          e ? reject(e) : resolve(),
        ),
      ),
    onChange = () => {},
  }) {
    Object.assign(this, {
      load,
      save,
      dir,
      home,
      keychain,
      ssh,
      openFile,
      onChange,
    });
    this.passwords = new Set();
  }
  own() {
    const value = this.load() || {};
    return Array.isArray(value.hosts) ? value.hosts : [];
  }
  // Which own hosts have a password in the keychain (asked once at start).
  async warm() {
    for (const host of this.own())
      if (host.auth === "password" && (await this.keychain.has(host.id)))
        this.passwords.add(host.id);
  }
  list() {
    let fromConfig = [];
    try {
      fromConfig = configHosts(this.home);
    } catch {}
    return [
      ...this.own().map((h) => ({
        ...h,
        source: "otter",
        hasPassword: this.passwords.has(h.id),
      })),
      ...fromConfig,
    ];
  }
  snapshot() {
    return {
      hosts: this.list(),
      configFile: path.join(this.home, ".ssh", "config"),
    };
  }
  find(nameOrId) {
    const hosts = this.list();
    const host =
      hosts.find((h) => h.id === nameOrId) ||
      hosts.find((h) => h.name === nameOrId) ||
      hosts.find(
        (h) => h.name.toLowerCase() === String(nameOrId).toLowerCase(),
      );
    if (!host) throw new Error(`没有叫“${nameOrId}”的服务器。`);
    return host;
  }
  // A host as entered (settings form or chat), checked; throws in plain words.
  clean(input, id = null) {
    const value = input || {};
    const host = String(value.host || "").trim();
    if (!HOST.test(host) || host.startsWith("-"))
      throw new Error(
        "主机要写主机名或 IP，比如 example.com 或 192.168.1.10。",
      );
    const name = String(value.name || host).trim();
    if (!NAME.test(name))
      throw new Error("名称要在 40 字以内，不要用特殊符号。");
    if (this.list().some((h) => h.name === name && h.id !== id))
      throw new Error(`已经有叫“${name}”的服务器了。`);
    const user = String(value.user || "").trim();
    if (!USER.test(user))
      throw new Error("用户名只能用字母、数字、点、横线和下划线。");
    const port = Number(value.port || 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("端口要是 1–65535 之间的数字。");
    const auth = value.auth || (value.keyPath ? "key" : "agent");
    if (!AUTH[auth])
      throw new Error("登录方式只能是 SSH 密钥、ssh-agent 或密码。");
    let keyPath = String(value.keyPath || "").trim();
    if (auth === "key") {
      if (!keyPath)
        throw new Error(
          "用 SSH 密钥登录要写密钥文件，比如 ~/.ssh/id_ed25519。",
        );
      keyPath = keyPath.replace(/^~(?=\/|$)/, this.home);
      if (!path.isAbsolute(keyPath) || !fs.existsSync(keyPath))
        throw new Error(`找不到密钥文件：${keyPath}`);
    } else keyPath = "";
    const jump = String(value.jump || "").trim();
    if (jump && (!JUMP.test(jump) || jump.startsWith("-")))
      throw new Error("跳板机写成 user@host 或 user@host:port。");
    const note = String(value.note || "")
      .trim()
      .slice(0, 200);
    return { name, host, port, user, auth, keyPath, jump, note };
  }
  // How the entry will be shown on a confirmation card.
  describe(server, password = false) {
    return [
      `名称：${server.name}`,
      `地址：${server.user}@${server.host}${server.port !== 22 ? `:${server.port}` : ""}`,
      `登录方式：${AUTH[server.auth]}${server.auth === "key" ? `（${server.keyPath.replace(this.home, "~")}）` : ""}${server.auth === "password" ? (password ? "（存进钥匙串）" : "（保存后在设置里填密码）") : ""}`,
      ...(server.jump ? [`跳板机：${server.jump}`] : []),
    ].join("\n");
  }
  async saveHost(input, { id = null, password = null } = {}) {
    const server = this.clean(input, id);
    if (
      password != null &&
      (typeof password !== "string" ||
        /[\r\n]/.test(password) ||
        password.length > 1000)
    )
      throw new Error("密码不能包含换行，且要在 1000 字以内。");
    const hosts = this.own();
    if (id && !hosts.some((h) => h.id === id))
      throw new Error("没有这台服务器。");
    const entry = { id: id || randomUUID(), ...server };
    if (server.auth === "password" && password) {
      await this.keychain.set(entry.id, password);
      this.passwords.add(entry.id);
    }
    if (server.auth !== "password") {
      await this.keychain.remove(entry.id);
      this.passwords.delete(entry.id);
    }
    this.save({
      hosts: id
        ? hosts.map((h) => (h.id === id ? entry : h))
        : [...hosts, entry],
    });
    this.onChange(this.snapshot());
    return entry;
  }
  async remove(id) {
    const hosts = this.own();
    if (!hosts.some((h) => h.id === id)) throw new Error("没有这台服务器。");
    await this.keychain.remove(id);
    this.passwords.delete(id);
    this.save({ hosts: hosts.filter((h) => h.id !== id) });
    this.onChange(this.snapshot());
    return this.snapshot();
  }
  // The askpass helper: prints the password for password prompts only.
  askpass() {
    const file = path.join(this.dir, "ssh-askpass.sh");
    const tail = this.keychain.keychain
      ? ` ${shellQuote(this.keychain.keychain)}`
      : "";
    const script = `#!/bin/sh
# Written by Otter: answers ssh's password prompt from the keychain.
case "$1" in
  *assword*) "${this.keychain.security}" find-generic-password -s "${SERVICE}" -a "$OTTER_SSH_ID" -w${tail} | /usr/bin/base64 -D ;;
  *) exit 1 ;;
esac
`;
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== script)
      fs.writeFileSync(file, script, { mode: 0o700 });
    fs.chmodSync(file, 0o700);
    return file;
  }
  // ssh arguments for a host; a config host is reached by its alias.
  args(host, extra = []) {
    const known = optionQuote(path.join(this.dir, "known_hosts"));
    const mine = optionQuote(path.join(this.home, ".ssh", "known_hosts"));
    const base = ["-o", "ConnectTimeout=10", ...extra];
    if (host.source === "config") return [...base, "--", host.alias];
    return [
      ...base,
      "-o",
      `UserKnownHostsFile=${known} ${mine}`,
      "-o",
      "StrictHostKeyChecking=accept-new",
      ...(host.port !== 22 ? ["-p", String(host.port)] : []),
      ...(host.auth === "key"
        ? ["-i", host.keyPath, "-o", "IdentitiesOnly=yes"]
        : []),
      ...(host.jump ? ["-J", host.jump] : []),
      "-l",
      host.user,
      "--",
      host.host,
    ];
  }
  env(host) {
    if (host.auth !== "password" || !this.passwords.has(host.id)) return {};
    return {
      SSH_ASKPASS: this.askpass(),
      SSH_ASKPASS_REQUIRE: "force",
      OTTER_SSH_ID: host.id,
      DISPLAY: ":0",
    };
  }
  // Runs one command on a host without a terminal.
  // input: bytes for the command's stdin (a file to upload, a script for sh -s).
  run(nameOrId, command, { timeout = 60000, input = null } = {}) {
    const host = this.find(nameOrId);
    if (typeof command !== "string" || !command.trim() || command.length > 4000)
      throw new Error("命令要是 1–4000 字的一行文字。");
    const password = host.auth === "password";
    const args = this.args(host, [
      "-T",
      "-o",
      `BatchMode=${password ? "no" : "yes"}`,
      ...(password ? ["-o", "NumberOfPasswordPrompts=1"] : []),
    ]);
    return new Promise((resolve) => {
      const child = spawn(this.ssh, [...args, command], {
        env: { ...process.env, ...this.env(host) },
        stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
      });
      if (input != null) {
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      }
      const out = { stdout: "", stderr: "" };
      for (const stream of ["stdout", "stderr"])
        child[stream].on("data", (chunk) => {
          if (out[stream].length < MAX_OUTPUT) out[stream] += chunk;
        });
      const timer = setTimeout(() => {
        out.timedOut = true;
        child.kill();
      }, timeout);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ host, code: -1, stdout: "", stderr: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ host, code, ...out });
      });
    });
  }
  async test(nameOrId) {
    const result = await this.run(nameOrId, "echo otter-ssh-ok", {
      timeout: 20000,
    });
    if (result.code === 0 && result.stdout.includes("otter-ssh-ok"))
      return { ok: true, message: `能登录 ${result.host.name}。` };
    return {
      ok: false,
      message: result.timedOut
        ? "等了 20 秒还没连上，检查地址、网络或跳板机。"
        : explain(result.stderr, result.code),
    };
  }
  // A Terminal window logged in to the host.
  async openTerminal(nameOrId) {
    const host = this.find(nameOrId);
    const env = this.env(host);
    const folder = path.join(this.dir, "ssh-sessions");
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(
      folder,
      `${host.name.replace(/[^\w一-鿿.-]+/g, "_")}.command`,
    );
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join("\n");
    fs.writeFileSync(
      file,
      `#!/bin/zsh\n# Opened by Otter: ssh to ${host.name}\n${exports}\nexec ${shellQuote(this.ssh)} ${this.args(host).map(shellQuote).join(" ")}\n`,
      { mode: 0o700 },
    );
    fs.chmodSync(file, 0o700);
    await this.openFile(file);
    return { ok: true, message: `已在终端打开 ${host.name}。`, file };
  }
}

module.exports = {
  SshManager,
  SshKeychain,
  parseSshConfig,
  configHosts,
  explain,
  AUTH,
};

// A password typed into chat ("密码：xxxx", "password=xxxx"): taken out so it
// never reaches the model or the chat history. Only ASCII passwords of four
// or more characters after an explicit separator count, so "密码是什么" is
// left alone.
const PASSWORD =
  /(密码|口令|password|passwd|pwd)(\s*(?:(?:是|为)\s*[:：=]?|[:：=])\s*)([!-~]{4,})/i;
function takePassword(text) {
  if (typeof text !== "string") return { text, password: null };
  const m = PASSWORD.exec(text);
  if (!m) return { text, password: null };
  return {
    text: text.replace(PASSWORD, (_, word, gap) => `${word}${gap}••••`),
    password: m[3],
  };
}
module.exports.takePassword = takePassword;

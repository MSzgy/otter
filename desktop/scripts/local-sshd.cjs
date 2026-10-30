// A real sshd for tests, run as this user on 127.0.0.1 with throwaway keys:
// key logins only (password logins need root). Returns the port, a key that
// is let in, one that is not, and stop().
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

async function startSshd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-sshd-"));
  for (const name of ["host_key", "user_key", "other_key"])
    execFileSync("/usr/bin/ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      path.join(dir, name),
    ]);
  fs.copyFileSync(
    path.join(dir, "user_key.pub"),
    path.join(dir, "authorized_keys"),
  );
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  fs.writeFileSync(
    path.join(dir, "sshd_config"),
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${path.join(dir, "host_key")}`,
      `AuthorizedKeysFile ${path.join(dir, "authorized_keys")}`,
      `PidFile ${path.join(dir, "sshd.pid")}`,
      "UsePAM no",
      "StrictModes no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
    ].join("\n"),
  );
  const daemon = spawn(
    "/usr/sbin/sshd",
    ["-f", path.join(dir, "sshd_config"), "-D", "-e"],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 50; i++) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (open) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    dir,
    port,
    user: os.userInfo().username,
    key: path.join(dir, "user_key"),
    otherKey: path.join(dir, "other_key"),
    stop: () => {
      daemon.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
module.exports = { startSshd };

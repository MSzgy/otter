const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  SshManager,
  SshKeychain,
  parseSshConfig,
  configHosts,
  explain,
} = require("./ssh.cjs");

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function manager(t, extra = {}) {
  const home = scratch(t, "otter-ssh-home-");
  const dir = scratch(t, "otter-ssh-data-");
  fs.mkdirSync(path.join(home, ".ssh"));
  let stored = {};
  const opened = [];
  const ssh = new SshManager({
    load: () => stored,
    save: (v) => (stored = v),
    dir,
    home,
    keychain: {
      has: async () => false,
      set: async () => {},
      remove: async () => {},
      security: "/usr/bin/security",
    },
    openFile: async (file) => opened.push(file),
    ...extra,
  });
  return { ssh, home, dir, opened, stored: () => stored };
}

test("~/.ssh/config: named hosts, includes, wildcards and Match skipped", (t) => {
  const home = scratch(t, "otter-ssh-cfg-");
  fs.mkdirSync(path.join(home, ".ssh", "conf.d"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".ssh", "config"),
    [
      "Include conf.d/*.conf",
      "Host prod web",
      "  HostName 10.0.0.5",
      "  User deploy",
      "  Port 2222",
      "  IdentityFile ~/.ssh/prod_key",
      "  User ignored-second-value",
      "Host *",
      "  User everyone",
      "Match host x",
      "  User nope",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(home, ".ssh", "conf.d", "lab.conf"),
    "Host lab\n  HostName lab.example.com\n  ProxyJump jump@bastion\n",
  );
  assert.equal(
    parseSshConfig(path.join(home, ".ssh", "config"), home).length,
    2,
  );
  const hosts = configHosts(home);
  assert.deepEqual(
    hosts.map((h) => [h.alias, h.host, h.user, h.port, h.jump]),
    [
      ["lab", "lab.example.com", "", 22, "jump@bastion"],
      ["prod", "10.0.0.5", "deploy", 2222, ""],
      ["web", "10.0.0.5", "deploy", 2222, ""],
    ],
  );
  assert.deepEqual(configHosts(scratch(t, "empty-")), []);
});

test("entries are checked in plain words; names default to the host", (t) => {
  const { ssh, home } = manager(t);
  fs.writeFileSync(path.join(home, ".ssh", "id_test"), "key");
  assert.deepEqual(
    ssh.clean({
      host: "1.2.3.4",
      user: "root",
      auth: "key",
      keyPath: "~/.ssh/id_test",
      port: 2222,
    }),
    {
      name: "1.2.3.4",
      host: "1.2.3.4",
      port: 2222,
      user: "root",
      auth: "key",
      keyPath: path.join(home, ".ssh", "id_test"),
      jump: "",
      note: "",
    },
  );
  for (const [input, message] of [
    [{ host: "-oProxyCommand=evil", user: "a" }, /主机要写/],
    [{ host: "a.com", user: "-l" }, /用户名/],
    [{ host: "a.com", user: "a", port: 70000 }, /端口/],
    [{ host: "a.com", user: "a", auth: "key" }, /要写密钥文件/],
    [
      { host: "a.com", user: "a", auth: "key", keyPath: "/nope/key" },
      /找不到密钥文件/,
    ],
    [{ host: "a.com", user: "a", jump: "-J x" }, /跳板机/],
    [{ host: "a.com", user: "a", auth: "telnet" }, /登录方式/],
  ])
    assert.throws(() => ssh.clean(input), message);
});

test("ssh arguments: options before --, Otter's known_hosts first, aliases as is", (t) => {
  const { ssh, home, dir } = manager(t);
  const own = {
    source: "otter",
    host: "1.2.3.4",
    port: 2222,
    user: "root",
    auth: "key",
    keyPath: "/k/id",
    jump: "ops@bastion",
  };
  const args = ssh.args(own);
  assert.deepEqual(args.slice(-4), ["-l", "root", "--", "1.2.3.4"]);
  assert(args.includes("StrictHostKeyChecking=accept-new"));
  assert(
    args.includes(
      `UserKnownHostsFile="${path.join(dir, "known_hosts")}" "${path.join(home, ".ssh", "known_hosts")}"`,
    ),
  );
  assert.deepEqual(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2), [
    "-i",
    "/k/id",
  ]);
  assert.deepEqual(args.slice(args.indexOf("-J"), args.indexOf("-J") + 2), [
    "-J",
    "ops@bastion",
  ]);
  assert.deepEqual(ssh.args({ source: "config", alias: "prod" }), [
    "-o",
    "ConnectTimeout=10",
    "--",
    "prod",
  ]);
  assert.match(explain("Permission denied (publickey).", 255), /登录被拒绝/);
  assert.match(
    explain("ssh: Could not resolve hostname x", 255),
    /找不到这个主机名/,
  );
});

test("passwords: stored in the keychain via stdin, read back only for password prompts", async (t) => {
  const before = execFileSync("/usr/bin/security", [
    "list-keychains",
    "-d",
    "user",
  ]).toString();
  const file = path.join(
    os.tmpdir(),
    `otter-ssh-test-${process.pid}.keychain-db`,
  );
  execFileSync("/usr/bin/security", ["create-keychain", "-p", "test", file]);
  execFileSync("/usr/bin/security", ["unlock-keychain", "-p", "test", file]);
  t.after(() => {
    spawnSync("/usr/bin/security", ["delete-keychain", file]);
    const after = execFileSync("/usr/bin/security", [
      "list-keychains",
      "-d",
      "user",
    ]).toString();
    assert.equal(after, before, "The user's keychain list is left as it was");
  });
  const keychain = new SshKeychain({ keychain: file });
  const { ssh, home } = manager(t, { keychain });
  const password = `p a"ss\\w$o\`rd'中文`;
  const entry = await ssh.saveHost(
    { name: "pw", host: "a.example", user: "me", auth: "password" },
    { password },
  );
  assert.equal(await keychain.has(entry.id), true);
  assert.equal(ssh.list()[0].hasPassword, true);
  const askpass = ssh.askpass();
  const ask = (prompt) =>
    spawnSync(askpass, [prompt], {
      env: { ...process.env, OTTER_SSH_ID: entry.id },
    });
  assert.equal(String(ask("me@a.example's password: ").stdout), password);
  assert.equal(String(ask("(me@a.example) Password:").stdout), password);
  const other = ask("Are you sure you want to continue connecting (yes/no)?");
  assert.equal(other.status, 1, "Other prompts get nothing");
  assert.equal(String(other.stdout), "");
  assert.equal(ssh.env(ssh.find("pw")).OTTER_SSH_ID, entry.id);
  await ssh.saveHost(
    { name: "pw", host: "a.example", user: "me", auth: "agent" },
    { id: entry.id },
  );
  assert.equal(
    await keychain.has(entry.id),
    false,
    "Switching away from a password deletes it",
  );
  await assert.rejects(
    ssh.saveHost(
      { name: "x", host: "b.example", user: "me", auth: "password" },
      { password: "a\nb" },
    ),
    /换行/,
  );
  assert(!fs.existsSync(path.join(home, ".ssh", "known_hosts")));
});

const { startSshd } = require("../scripts/local-sshd.cjs");
async function sshd(t) {
  const server = await startSshd();
  t.after(() => server.stop());
  return server;
}

test("a real key login: test, run a command, open a terminal, bad key explained", async (t) => {
  const server = await sshd(t);
  const { ssh, home, dir, opened } = manager(t);
  const user = os.userInfo().username;
  await ssh.saveHost({
    name: "local",
    host: "127.0.0.1",
    port: server.port,
    user,
    auth: "key",
    keyPath: server.key,
  });
  assert.deepEqual(await ssh.test("local"), {
    ok: true,
    message: "能登录 local。",
  });
  const run = await ssh.run("local", "echo hi-from-$(whoami); exit 3");
  assert.equal(run.code, 3);
  assert.equal(run.stdout.trim(), `hi-from-${user}`);
  assert(
    fs.existsSync(path.join(dir, "known_hosts")),
    "Host key kept in Otter's file",
  );
  assert(
    !fs.existsSync(path.join(home, ".ssh", "known_hosts")),
    "The user's file untouched",
  );
  const terminal = await ssh.openTerminal("local");
  assert.deepEqual(opened, [terminal.file]);
  const script = fs.readFileSync(terminal.file, "utf8");
  assert.match(script, /^#!\/bin\/zsh/);
  assert.match(script, new RegExp(`exec '/usr/bin/ssh' .*'--' '127.0.0.1'`));
  assert.equal(fs.statSync(terminal.file).mode & 0o777, 0o700);
  await ssh.saveHost({
    name: "wrong-key",
    host: "127.0.0.1",
    port: server.port,
    user,
    auth: "key",
    keyPath: server.otherKey,
  });
  const refused = await ssh.test("wrong-key");
  assert.equal(refused.ok, false);
  assert.match(refused.message, /登录被拒绝/);
  await assert.rejects(
    async () => ssh.run("nobody", "ls"),
    /没有叫“nobody”的服务器/,
  );
});

const { takePassword } = require("./ssh.cjs");
const { TaskAssistant } = require("./task-assistant.cjs");

test("a password typed in chat is taken out; a question about passwords is not", () => {
  assert.deepEqual(takePassword("保存服务器 a：me@1.2.3.4 密码：S3cret!x"), {
    text: "保存服务器 a：me@1.2.3.4 密码：••••",
    password: "S3cret!x",
  });
  assert.equal(takePassword("password=hunter22 ok").password, "hunter22");
  assert.deepEqual(takePassword("我的密码是：Hunter2pass 帮我记一下"), {
    text: "我的密码是：•••• 帮我记一下",
    password: "Hunter2pass",
  });
  assert.equal(takePassword("口令为 abcd-1234").password, "abcd-1234");
  assert.equal(takePassword("pwd: abcd1234").text, "pwd: ••••");
  for (const text of [
    "密码是什么意思",
    "忘记密码了怎么办",
    "密码：abc",
    "改一下 password 规则",
  ])
    assert.equal(takePassword(text).password, null, text);
});

test("saving a login from chat: a card first; the password only reaches the keychain", async (t) => {
  const { ssh } = manager(t);
  const saved = [];
  const records = [];
  let plan = {
    kind: "ssh_save",
    server: {
      name: "prod",
      host: "10.0.0.5",
      user: "deploy",
      port: 2222,
      auth: "agent",
    },
  };
  const tasks = new TaskAssistant({
    store: { snapshot: () => ({ reminders: [], todos: [] }) },
    gate: { cancel() {} },
    ssh: {
      clean: (s) => ssh.clean(s),
      describe: (s, p) => ssh.describe(s, p),
      save: async (s, p) => saved.push([s, p]),
    },
    interpret: async (params) => {
      assert(!params.text.includes("S3cret"), "The planner never sees it");
      return plan;
    },
    record: async (r) => records.push(r),
  });
  const card = await tasks.plan({
    text: "保存服务器 prod：deploy@10.0.0.5 端口 2222 密码：••••",
    sessionId: "s",
    requestId: "r",
    secret: "S3cret!x",
  });
  assert.equal(card.title, "确认保存 SSH 服务器");
  assert.match(card.detail, /地址：deploy@10\.0\.0\.5:2222/);
  assert.match(card.detail, /登录方式：密码（存进钥匙串）/);
  assert.match(card.detail, /没有发给模型/);
  assert.equal(saved.length, 0, "Nothing saved before 确认");
  const done = await tasks.confirm({ id: card.id, sessionId: "s" });
  assert.match(done.message, /已保存服务器 prod/);
  assert.equal(saved[0][1], "S3cret!x");
  assert.equal(saved[0][0].auth, "password");
  assert(!JSON.stringify(records).includes("S3cret"), "Nor does the chat");
  plan = { kind: "none" };
  const held = await tasks.plan({
    text: "我的密码：••••",
    sessionId: "s",
    requestId: "r2",
    secret: "Hunter22",
  });
  assert.equal(held.kind, "result");
  assert.match(held.message, /没有把它发给模型/);
  plan = { kind: "ssh_save", server: { host: "-x", user: "a" } };
  assert.match(
    (await tasks.plan({ text: "x", sessionId: "s", requestId: "r3" })).message,
    /没有保存：主机要写/,
  );
});

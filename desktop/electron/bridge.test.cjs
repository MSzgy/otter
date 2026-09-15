const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Backend } = require("./bridge.cjs");
test("routes split frames and refuses requests after exit", async () => {
  const source = `process.stdin.setEncoding('utf8');process.stdin.on('data',line=>{const r=JSON.parse(line);const response=JSON.stringify({jsonrpc:'2.0',id:r.id,result:{ok:true}})+'\\n';process.stdout.write(response.slice(0,10));setTimeout(()=>process.stdout.write(response.slice(10)),10);});`;
  const child = new Backend(process.execPath, ["-e", source]);
  try {
    assert.deepEqual(await child.call("health.get"), { ok: true });
  } finally {
    await child.stop();
  }
  await assert.rejects(child.call("health.get"), /未连接/);
});
test("backend exit rejects in-flight calls", async () => {
  const child = new Backend(process.execPath, [
    "-e",
    `process.stdin.on('data',()=>process.exit(1));`,
  ]);
  await assert.rejects(child.call("health.get"), /停止/);
  await child.stop();
});

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.mjs";

test("本地预览服务返回页面、模块和教学文档，拒绝非公开路径", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const route of ["/", "/src/body.mjs", "/docs/LESSON-01.md", "/firmware/serial_probe/serial_probe.ino"]) {
    const response = await fetch(url + route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.ok((await response.text()).length > 20);
  }
  for (const route of ["/package.json", "/.git/config", "/%2e%2e%2fREADME.md", "/%E0%A4%A"]) {
    const response = await fetch(url + route);
    assert.ok([400, 404].includes(response.status), route);
  }
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  assert.equal((await fetch(url, { method: "HEAD" })).status, 200);
});

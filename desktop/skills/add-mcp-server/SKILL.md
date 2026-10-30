---
name: add-mcp-server
description: 用户想接入、添加或修好一个 MCP 服务（本机命令或网络服务），或者拿着别的软件（Claude Desktop、Cursor、VS Code、Gemini CLI、Claude Code、OpenCode、Zed）里的 MCP 配置想在 Otter 里用时使用。
---

# 帮用户添加 MCP 服务

目标：弄清楚这个服务是怎么运行的，整理成 Otter 认的配置，调用 `otter_add_mcp_server` 让用户在卡片上确认。

## 1. 先分清是哪一种

- **网络服务**：有一个网址，通常以 `/mcp` 结尾（老一些的以 `/sse` 结尾）。可能需要令牌。
- **本机服务**：要在用户的 Mac 上运行一个命令，常见的是 `npx`、`uvx`、`docker`、`node`、`python`。

## 2. 命令和网址只能来自可靠的地方

- 用用户给出的配置、命令或网址；或者用 `otter_read_webpage` 读这个服务的官方说明（README、文档页）后照抄。
- **不要凭记忆写包名或网址**，也不要“补全”成你觉得对的版本。拿不准就请用户把文档里的配置贴过来，或者给你文档网址。
- 令牌、密钥由用户自己提供。你不要编，也不要在回复正文里复述令牌。
- 如果用户要把令牌发在聊天里，先提醒：聊天会保存在本机；更稳妥的是到 设置 → 工具与扩展 → 添加 MCP 服务，把带令牌的配置粘贴进去。

## 3. 整理成 Otter 的配置

和 Claude Desktop 一样，外面一层是 `mcpServers`，里面是“名字: 配置”。名字用简短的英文，比如 `notion`、`github`、`files`。

网络服务：

```json
{
  "mcpServers": {
    "notion": {
      "url": "https://mcp.notion.com/mcp"
    }
  }
}
```

需要令牌的网络服务：

```json
{
  "mcpServers": {
    "example": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer 用户的令牌" }
    }
  }
}
```

老式 SSE 服务加上 `"type": "sse"`（网址以 `/sse` 结尾时可以省略）。

本机服务：

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/用户名/Documents"],
      "env": { "SOME_KEY": "值" }
    }
  }
}
```

## 4. 别的软件的格式

Otter 能直接读下面这些写法，一般原样传进去就行；想整理得干净一点，按右边改：

| 来源 | 写法 | 对应 Otter |
|---|---|---|
| VS Code `.vscode/mcp.json` | `{"servers": {...}}`，带 `"type": "http"` | 外层换成 `mcpServers` |
| VS Code 设置 | `{"mcp": {"servers": {...}}}` | 同上 |
| Gemini CLI | `"httpUrl": "https://..."` | 改成 `"url"` |
| OpenCode | `{"mcp": {"名字": {"type": "remote", "url": ...}}}` | 外层换成 `mcpServers`，去掉 type |
| Zed | `"command": {"path": "uvx", "args": [...]}` | 拆成 `"command": "uvx", "args": [...]` |
| Claude Code 命令 | `claude mcp add --transport http 名字 网址` | `{"mcpServers": {"名字": {"url": "网址"}}}` |
| Claude Code 命令 | `claude mcp add 名字 -- npx -y 包名` | `{"mcpServers": {"名字": {"command": "npx", "args": ["-y", "包名"]}}}` |

**`mcp-remote` 桥接**：有的文档写 `{"command": "npx", "args": ["-y", "mcp-remote", "https://..."]}`。

- 如果这个服务用令牌或者不需要登录，可以直接改成 `{"url": "https://..."}`，不用装 Node。
- 如果它要在网页上登录（OAuth），Otter 暂时不能直接登录，就保留 `mcp-remote` 这种写法：它会打开浏览器让用户登录。

## 5. 添加

调用 `otter_add_mcp_server`，参数 `config` 就是上面整理好的 JSON。

- Otter 会弹卡片，列出要运行的命令或要连接的地址，用户点“允许一次”后才添加。你不用再问一遍。
- 添加后服务要启动几秒。它的工具会在用户的**下一条消息**里出现，这一轮还用不了。
- 告诉用户可以在 设置 → 工具与扩展 里看状态、关掉或删除。

## 6. 出错了怎么办

用户说添加失败或状态显示“出错”时，按提示排查：

- **找不到命令 “npx” / “uvx”**：没装 Node.js（npx）或 uv（uvx）。Node.js 可以去 nodejs.org 下载，uv 用 `brew install uv` 或官方安装脚本。装好后在 设置 → 工具与扩展 里把这个服务关掉再打开。
- **服务已退出**：看后面的错误信息。常见原因是包名写错、缺环境变量（比如令牌），或者路径不存在。
- **HTTP 401 / 403**：令牌没填或不对，检查 `headers` 里的 `Authorization`。
- **HTTP 404**：网址路径不对，常见是少了 `/mcp`，或者应该用 `/sse`。
- **要用 https 网址**：网络服务必须是 https，只有本机（localhost）服务能用 http。
- **没有 command 也没有 url**：配置的层级不对，检查是不是多套了一层或少了一层。
- **已经有叫某某的服务了**：换个名字，或者先在设置里删掉旧的。

## 不要做

- 不要编造包名、网址、令牌。
- 不要一次添加用户没提到的服务。
- 不要在回复里贴出用户的令牌。

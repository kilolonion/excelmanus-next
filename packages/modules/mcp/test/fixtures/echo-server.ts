// 测试用 stdio MCP 服务器：一个只读工具 lookup、一个有副作用工具 shout。
// 由 server 的 e2e 测试以 `node <本文件>` 拉起，走真实 stdio 传输。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });

server.registerTool(
  "lookup",
  {
    description: "按编码查询产品名称",
    inputSchema: { code: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ code }) => ({ content: [{ type: "text", text: `产品 ${code}：示例商品` }] }),
);

server.registerTool(
  "shout",
  {
    description: "把文本转为大写并记录",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({ content: [{ type: "text", text: text.toUpperCase() }] }),
);

await server.connect(new StdioServerTransport());

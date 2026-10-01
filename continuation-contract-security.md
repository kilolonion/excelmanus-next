# M6 continuation：contract/security（2026-10-01）

范围：`packages/protocol/**` 与服务端契约/安全边界；未修改 kernel/workbook/models/desktop 业务实现。

## 修复与证据

- **P0-12 凭据脱敏**：`packages/server/src/crypto.ts` 的 `maskSecret` 对长度 ≤8 的凭据全掩；`packages/server/src/app.ts` 的统一 REST `fail` 对 message、details 递归调用 `redactSecrets`；`packages/server/src/index.ts` 的结构化 `emit` 对字符串字段及最终 JSON 脱敏；账号错误写入/读出在 `accounts.ts` 脱敏。证据：源码静态检查；运行时测试未执行（依赖未安装）。
- **MCP env 登记收窄**：`index.ts` 的 MCP cipher.open 仅以 `apiKey` 语义登记当前解密值，不再伪造 `extraHeaders` 整体登记。证据：源码静态检查。
- **P1-40 契约入口**：新增鉴权保护的 `GET /api/docs`，返回 OpenAPI 3.1 版本、Bearer 认证与主要资源索引；`unsupported_media_type` 纳入 protocol REST 错误词表。附录 C 对 `/api/docs` 状态更新，新增 ADR 0012 记录决定、后果与未完成完整 schema 生成。证据：路由与契约源码静态检查。

## 验证

- `git diff --check`：通过。
- `pnpm typecheck`：未执行成功，当前工作树未安装 `tsc`（`tsc: command not found`）。协议/服务端 Vitest 与真实 HTTP/WS/SQLite 复测同样因缺少依赖未运行。

## 未验证平台/限制

- 未在 Windows/NTFS 或生产反向代理下验证路径、Host/Origin 与一次性 WS ticket；已有审计证据记录 macOS 本机真实边界通过。
- `/api/docs` 当前为资源索引，完整 DTO schema 仍由 protocol Zod 契约维护，后续需接入生成器与开发态响应校验。

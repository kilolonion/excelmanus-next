# 鉴权与登录体验改造验收（2026-10-01）

## 范围

- 本机 Web 首次访问自动建立 HttpOnly 会话 Cookie，不再要求用户从日志复制 `#token=` 链接。
- REST 客户端在 Cookie 会话与桌面 Bearer 设备令牌之间自动选择；同步通道仍使用一次性票据。
- 登录失败显示可重试页面；侧栏提供“锁定此设备”入口清除浏览器会话。

## 门禁与场景

| 项目 | 环境 | 结果 | 证据 |
| --- | --- | --- | --- |
| TypeScript strict 全栈类型检查 | Node 24 / pnpm workspace | 通过 | `pnpm typecheck` |
| 浏览器会话建立、Cookie 属性、鉴权访问、退出清除 | 真实 HTTP + 真实 SQLite 文件 | 通过 | `packages/server/test/auth-session.test.ts` |
| 全量回归 | Vitest，47 files / 314 tests | 通过 | `pnpm test` |
| 变更文件 Biome 检查 | Biome | 通过 | `pnpm exec biome check`（变更文件） |

## 已知边界

- 本地 Web 仍只允许回环地址与允许的 Origin；远程部署的账号密码登录不在本次范围内。
- 桌面端继续由预加载脚本提供 Bearer 令牌，不显示本机 Web 登录页。
- 全仓 `pnpm lint` 仍受既有文件的 lint 诊断阻塞；本次变更文件已单独通过 Biome 检查。

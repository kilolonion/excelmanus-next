# ADR 0013：本机 Web 使用 HttpOnly 会话 Cookie

## 背景

本机 Web 之前把设备令牌放在 `/#token=...`，前端再写入 `localStorage`。用户需要从启动日志复制链接，令牌也会进入浏览器可见状态。设备令牌仍需作为本机访问保护的唯一凭据，桌面端预加载桥接和 CLI 仍需要 Bearer 令牌。

## 选项

1. 继续使用 URL fragment 和 `localStorage`。
2. 让浏览器首次访问时通过受 `Host`/`Origin` 校验的同源请求建立 `HttpOnly; SameSite=Strict` 会话 Cookie，Cookie 内承载当前设备令牌；其他客户端继续使用 `Authorization: Bearer`。
3. 新增用户名密码账户和持久化账户表。

## 决定

采用选项 2。`POST /api/v1/auth/session` 只接受允许来源，签发不含在响应体中的会话 Cookie；REST 鉴权同时接受该 Cookie 或 Bearer 令牌。`POST /api/v1/auth/logout` 清除 Cookie。浏览器启动页自动调用会话端点，失败时展示重试页；启动日志只输出普通地址。WebSocket 仍先用已鉴权 REST 请求换取一次性短期票据。

## 后果

- 普通用户打开地址即可进入，不再复制或检查令牌。
- 令牌不进入 URL、`localStorage`、前端应用状态或日志；Cookie 由浏览器自动发送且 JavaScript 不可读。
- 本机 Web 仍依赖回环监听、`Host`/`Origin` 校验和随机设备令牌；无来源的 CLI 请求仍必须携带 Bearer。
- 浏览器会话是会话级 Cookie；服务重启导致设备令牌轮换时，页面刷新即可重新建立会话。

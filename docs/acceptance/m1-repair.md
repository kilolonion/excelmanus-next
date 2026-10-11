# M1 修复记录

日期：2026-09-30。环境：macOS Apple Silicon、Node 24.1.0、pnpm 10.11.0。
基线：`af250b6`，99 个文件；开始审核时只有两个未提交 spike 目录。

状态：修复已实现，最终工作树未验收。负责人在修复过程中要求“不用测试”，此后本次 M1 修复不再运行测试、类型门禁、构建或浏览器验证，未新增测试文件或测试依赖。并行 M2a 工作不在此范围。CI 门禁仍保留，不改变安全与许可证策略。

## 审核发现与修复

| 问题 | 修复 | 实现位置 |
| --- | --- | --- |
| Web 构建从 core 入口引入 `node:crypto.randomBytes` 而失败 | ID 改用 Node 24 与浏览器共有的 Web Crypto，保持原前缀与 12 位 base64url 后缀；生产构建加入 CI 和 `check:all` | `packages/core/src/id.ts`、根 scripts、CI |
| 同名上传直接覆盖已有文件 | 独占创建 `wx`；文件存在时返回 HTTP 409，原文件不被本上传替换 | `packages/server/src/app.ts` |
| 内部目录可通过符号链接别名访问 | 路径解析后再检查 `.excelmanus`；`find` 搜索及 REST 文件列表也统一校验每个条目，不直接读取链接目标 | `packages/kernel/src/paths.ts`、`packages/modules/files/src/tools.ts`、server |
| HTTP 缺少 Origin 校验 | 有 Origin 时必须属于允许来源；无 Origin 的本机 CLI 仍走 Host 与设备令牌鉴权 | `packages/server/src/app.ts`、`index.ts` |
| xlsx 包内绝对关系路径被读成空表 | 正确解析 `/xl/...` 与相对关系；缺失关系、XML 损坏、工作表部件缺失和共享字符串索引无效时明确拒绝 | `packages/modules/workbook/src/xlsx.ts` |
| xlsx 文本前导零和富文本读取不完整 | XML 文本不自动转数值；统一读取 sharedStrings 与 inlineStr 的普通文本和富文本 runs | 同上 |
| 区域引用未接入工作台 | 正文与工具卡片中的单元格/矩形引用转换为安全锚点；点击或 Enter 可定位，悬停预览，点击高亮 2 秒；工具卡片可按 docId 打开工作簿 | `packages/web/src/md.ts`、`store.ts`、ChatPanel、Workbench |
| 断线快照未交给 reducer，心跳未回应，切换主题不退订 | 接收 snapshot 恢复流式文本；回应 ping；同时订阅会话和文档，同类主题切换退订；记录按持久游标去重 | `packages/web/src/ws.ts`、`store.ts`、`reduce.ts` |
| 选区仅做结构校验，同一消息 ID 换选区仍被去重 | 入队前校验工作区、工作表、修订与区域；幂等比较文本、派发模式与选区；快照路由在读取前检查工作区归属 | `packages/server/src/app.ts` |
| 失败发送丢掉输入内容 | 展示发送失败提示，输入框为空时恢复待发送文本 | ChatPanel、`strings.ts` |
| 静态目录边界使用字符串前缀，可能接受同前缀兄弟目录 | 使用规范化目录边界，并检查静态文件符号链接的实际目标 | `packages/server/src/app.ts` |
| 实现的上传限制是 10 MB，与契约的 200 MB 不符 | 上传文件上限 200 MiB，multipart 请求另留 64 KiB；其他请求上限 10 MiB，实际流也受 Hono bodyLimit 约束 | 同上 |

Markdown 原有修复保留：未知标签整棵替换成纯文本，允许标签逐属性过滤。新生成的区域锚点只使用固定 fragment 前缀与编码后的区域文本。

## 实际执行过的验证

以下区分基线审核、修复中间版本和最终版本，不能相互替代。

| 范围 | 执行 | 实际结果 |
| --- | --- | --- |
| `af250b6` 基线 | `pnpm check:all` | 7 个测试文件、40 个测试通过；类型、依赖、许可证门禁通过；lint 无错误，有 22 条警告 |
| 同一基线 | Web 生产构建 | 失败，错误：`randomBytes is not exported by __vite-browser-external` |
| 基线安全审核 | 隔离目录中的真实 HTTP 与真实文件工具 | 同名上传返回 201 并覆盖；`.excelmanus` 直接访问被拒，链接别名访问成功；带合法令牌的不可信 Origin 请求票据返回 200 |
| 基线 xlsx 审核 | 把样例关系改成 `/xl/worksheets/...` 后读取 | 销售/参数单元格数从 307/4 变成 0/0，未抛错 |
| 已提交的 Markdown 修复 | 真实 Chrome，5 组危险输入与正常 Markdown | 危险输入未留下 img/svg/math/script 或事件属性，没有脚本执行；正常 Markdown 可渲染 |
| 本次修复中间版本 | Web 生产构建 | Web Crypto 改动后成功；这是后续追加修改之前的结果 |
| 本次修复中间版本 | 类型检查 | 发现预览高亮的 strokeDash 类型不匹配，已改为数值；之后未重跑 |
| 最终工作树 | 测试、门禁、浏览器交互与完整生产启动 | 按负责人要求未执行，不能标记通过 |

以上输出来自本次审核/修复对话中的本机命令与浏览器输出，未产生新的 CI 报告。最终版本没有新的测试证据。

## 范围与仍待验收的项目

- 未删除 `spikes/sync-channel`、`spikes/xlsx-fidelity`，未提交或推送代码。
- 修复期间有并行的 M2a 编辑：文档服务转为异步，增加 doc_ops、提交及文档同步。保留这些改动，REST 调用改为 await，装配清单补入其迁移。并行代码不属于本次 M1 修复通过的证据。
- 最终需要验证安全缺陷的拒绝路径、区域引用实际滚动与高亮、断线续传和完整 `pnpm start`。本次不添加测试。
- M1 性能基准尚未完成；01 §5.1 目标仍是推荐值，不能直接改成已验证的硬性指标。
- 完整能力探测、状态栏统计以及四类提供商的真实回归仍缺证据；连接测试不等于能力探测。
- 共享公式跟随格仍只保留缓存，样式导入主要覆盖数字格式。该快照不能直接作为 M2 保真重建整个 sheetData 的完整依据。
- 跨文件同名工作表的正文引用缺少文档身份，见附录 C P-10；本次只在已打开文档或唯一已读文档可确定时定位，工具卡片按 docId 定位。

M1 不标记为全部验收通过；退出条件保持 `docs/15-milestones.md` 与 ADR 0006 的要求。

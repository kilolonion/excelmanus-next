# 附录 A 旧功能对照表

用于查漏：旧版（`~/Desktop/excelmanus`，2026-09-28 状态）中存在或文档中承诺过的每项能力，在新版中的去向。

去向：**保留**（行为基本一致）、**重做**（目标保留、设计改变）、**合并**（并入其他功能）、**删除**（不再提供）、**推迟**（P2 及以后）。

## 1. 对话与执行

| 旧能力 | 去向 | 新版位置 / 说明 |
| --- | --- | --- |
| 流式对话、思考块、工具卡片 | 保留 | [02 §3](02-interaction.md#3-对话面板) |
| 事件流断线重连（内存环形缓冲 500 条、`buffer_overflow`） | 重做 | 同步通道 + 数据库游标续传：记录来自数据库，无溢出（[11 §3.4](11-api-contract.md#34-续传硬性)） |
| 单订阅者限制（`stream_already_connected`） | 删除 | 允许多个订阅者 |
| `/resume` 继续中断任务 | 保留 | [04 §8.3](04-agent-runtime.md#83-继续) |
| steer / interrupt / queue 派发与回执 | 保留 | [04 §4](04-agent-runtime.md#4-消息派发) |
| 审批（accept / reject / fullaccess） | 重做 | 三档权限模式 + "本会话同类自动批准"（[04 §5](04-agent-runtime.md#5-权限与审批)） |
| full-access / auto-approve 两个开关 | 合并 | 并入权限模式 |
| 只读模式、计划模式（chat_mode） | 删除 | 旧版已移除；`reader` 角色用于子代理 |
| `ask_user` 问答 | 重做 | 扩展区域确认/选取/修改确认题型 |
| 待办清单（todolist / task_update） | 保留 | `todo` |
| 上下文压缩、`/compact`、上下文占用 | 保留 | [04 §6](04-agent-runtime.md#6-上下文管理与压缩)，历史只追加，除压缩外不改写 |
| 按轮回滚对话（rollback / turns） | 重做 | "从某条消息重新开始"（P1），明确不回滚文件 |
| 工具调用"未执行/结果不确定"定案 | 保留 | [04 §8](04-agent-runtime.md#8-中断与恢复) |
| 模型重试提示（llm_retry） | 保留 | `retry.scheduled` |
| 失败指引卡片（failure_guidance） | 保留 | `error.guidance` |
| 交付账本、`verify_visual`、`delivery_status` | 删除 | 由运行时生成的变更摘要替代 |
| 会话标题、导出 JSON/Markdown | 保留 | 导出 Markdown |
| 清空会话（保留条目） | 删除 | 新建会话即可 |
| 斜杠命令 `/help /skills /history /clear /mcp /save /config /model /subagent /fullaccess /autoapprove /compact /registry /rollback /rules /memory /accept /reject /undo /stop /resume` | 重做 | 保留 `/model /compact /stop /resume /rules /技能名`；其余改为界面操作，`/undo` 删除 |
| `POST /command` 服务端命令 | 删除 | 命令在前端解析后调用对应 API |
| JEV 追踪、时间线、`ui_hint` | 删除 | 实验功能；界面跟随由 `ui.present` 记录与活动叠加层取代 |
| 会话结束摘要 | 删除 | |

## 2. 表格

| 旧能力 | 去向 | 新版位置 |
| --- | --- | --- |
| `observe_spreadsheet`（workbook/2 协议、facets、coverage） | 合并 | `workbook_read`，保留"覆盖状态三分法" |
| `trace_spreadsheet_formulas` | 合并 | `workbook_read formula_graph` |
| `extract_table` | 合并 | `workbook_read table` |
| `analyze_spreadsheet`、`query_spreadsheet`（SQLite）、`compare_spreadsheets`、`validate_spreadsheet`（含 cell 断言、total） | 合并 | `workbook_analyze` |
| `apply_spreadsheet_changes`（ChangeSet、dry_run、WorkbookSpec） | 重做 | `workbook_edit`，操作类型扩展（图表、条件格式、数据验证） |
| `calculate_spreadsheet`（LibreOffice 重算） | 重做 | 写入后自动用 Univer 引擎计算；不依赖 LibreOffice |
| `preview_spreadsheet`（Playwright + Univer） | 重做 | `workbook_render`；桌面用 Electron 离屏窗口，不打包 Playwright 浏览器 |
| `convert_spreadsheet`、`split_spreadsheet` | 合并 | `workbook_export` |
| `.xls/.xlsb` 上传自动转换（LibreOffice） | 重做 | 导入为 xlsx（实现方式待 spike） |
| 工作簿对象图片抽取（object-image） | 保留 | `workbook_read objects` + 下载 |
| 合并冲突审阅（merge-review，旧版未实现） | 重做 | 冲突条（[02 §4.7](02-interaction.md#47-用户与代理同时编辑硬性)） |
| 内容版本 CAS（`expected_version`） | 重做 | 修订号 + 区域级冲突检测（[03 §6.1](03-architecture.md#61-文档内)）；内容哈希仅用于文本文件与外部修改检测 |
| HTTP 操作持久回执（崩溃后不重放） | 重做 | `tool.intent` / `tool.result` 日志记录 + `open_intents` 投影（[04 §8.1](04-agent-runtime.md#81-意图与结果记录硬性)） |
| 图片转表格（receipt-visual-replica） | 保留 | `image-to-sheet` 技能 |

## 3. 文件与历史

| 旧能力 | 去向 | 说明 |
| --- | --- | --- |
| 上传（100 MB）、从 URL 上传 | 保留 / 删除 | 上传保留（200 MB）；从 URL 上传删除（SSRF 风险，需要时用 MCP） |
| 文件树、建目录、建空文件、重命名、删除 | 保留 | 删除改为进回收站 |
| `read` / `write` / `edit` / `ls` | 保留 / 合并 | `ls` 并入 `find` |
| `copy_file` / `rename_file` / `delete_file` | 合并 | `files` 批量工具 |
| 文本文件预览 | 保留 | P1 |
| 修订历史（revisions）、修订预览、恢复、删除修订 | 删除 | 由修改前备份替代（[07 §7](07-workbook-engine.md#7-修改前备份)）（内部保留逆操作仅用于失败回退） |
| 会话操作历史与撤销（operations/undo） | 删除 | |
| 审批撤销（approvals/undo，旧版恒 501） | 删除 | |
| 文件注册表（registry，旧版空实现） | 删除 | |
| "在文件夹中显示"（旧版不支持） | 保留 | 桌面实现 |
| 多工作区登记、排序、默认工作区 | 保留 | 新版会话始终真实绑定工作区；首选工作区恢复、自动空白落点复用与显式新建行为见 02 §2.3、ADR 0015；排序仍按现有阶段范围 |
| 附件（图片） | 保留 | 按内容寻址存储 |

## 4. Word

| 旧能力 | 去向 |
| --- | --- |
| `read_word` / `inspect_word` / `search_word` / `write_word`、Word 快照/写入 API、Word 预览编辑界面、`word-basic` / `word-code-runner` 技能 | 删除 |

## 5. 代码执行

| 旧能力 | 去向 | 说明 |
| --- | --- | --- |
| `run_code`（JS/TS，Node 子进程 + Node 权限模型 + Seatbelt/bwrap，或 QuickJS） | 重做 | `run_script`，只保留 QuickJS worker 一种引擎（[08](08-sandbox.md)） |
| 暂存区事务发布、`expected_versions` | 重做 | 工作簿写入缓冲为逐文档 ChangeSet 提交给文档 actor，失败用逆操作回退；文本文件仍暂存后原子替换（[08 §4](08-sandbox.md#4-设计推荐)） |
| Python 沙箱（更早版本） | 删除 | |
| Docker 隔离执行（isolated compose） | 删除 | |

## 6. 子代理

| 旧能力 | 去向 | 说明 |
| --- | --- | --- |
| `spawn_subagent`（后台/前台等待）、`list/read/control_subagent` | 重做 | 可互相通信的代理团队（[05](05-multi-agent.md)） |
| 子代理 explorer / subagent 角色 | 重做 | reader / worker / lead |
| 子代理审批经父会话弹出 | 保留 | 标明来源代理 |
| 任务面板（暂停/继续/补充指令） | 保留 | 团队视图 |

## 7. 模型

| 旧能力 | 去向 | 说明 |
| --- | --- | --- |
| 模型档案 CRUD、默认档案、`/model` | 保留 | |
| 协议选择（openai-completions / responses / anthropic / gemini / auto） | 重做 | 由提供商预设决定适配包，用户一般不需选协议 |
| 连接测试、拉取远端模型、占位符检查 | 保留 / 删除 | 占位符检查删除 |
| 能力探测（合成工具、色块图、思考观测）与手动覆盖 | 保留 | |
| 思考强度（thinking.json） | 合并 | 档案字段 + 会话覆盖 |
| canonical 模型名匹配开关 | 删除 | 使用 models.dev 快照 |
| 内置模型目录（84 个模型、12 个提供商，手工维护） | 重做 | models.dev 快照 + 小覆盖文件 |
| Codex 订阅（浏览器、设备码、粘贴回调） | 保留 | 粘贴回调地址方式在远程部署时需要，v1 本机不需要 |
| WorkBuddy（国内/国际）、Antigravity 订阅 | 推迟 | P2，经 `SubscriptionProvider` 接入 |
| 账号池管理（/admin/pool，旧版后端已不存在） | 删除 | |
| 配置导出/导入（EMX1 加密令牌） | 重做 | 导出不含密钥的设置文件 |
| 按角色选模型（RoleModelSection） | 保留 | P1 |

## 8. 扩展

| 旧能力 | 去向 | 说明 |
| --- | --- | --- |
| 12 个内置技能 | 重做 | 按独立任务重写方法包，当前清单见 [12 §1.6](12-skills-memory-mcp.md#16-v1-内置技能推荐)，不按数量验收 |
| 用户技能 CRUD、本地/GitHub 导入 | 保留 | |
| 技能 `requires_tools` 裁剪、`@skills/` 虚拟路径 | 保留 | `skill://` |
| 技能 hooks、多目录发现（`~/.claude/skills` 等，旧版文档有、代码无） | 推迟 / 删除 | hooks P2；外部目录发现删除，改为导入 |
| 知识门户 `introspect_capability`（BM25、8 主题、多种查询） | 删除 | 工具契约随工具提供；产品说明进入用户帮助与设置 UI |
| 记忆条目（查看、删除） | 保留 | 增加代理 `memory` 工具与注入策略 |
| 全局/会话规则 | 保留 | |
| MCP（stdio/HTTP/SSE、脱敏、自动批准、测试、重载） | 保留 | |
| 插件页（PluginsTab） | 删除 | |
| Agent 自我管理（inspect_agent / configure_agent） | 删除 | |

## 9. 系统与平台

| 旧能力 | 去向 | 说明 |
| --- | --- | --- |
| `/health` 状态字段（工具数、会话数等）与状态栏 | 重做 | `/bootstrap` + `app` 主题推送 |
| 登录保护（单管理员、Cookie、限流） | 推迟 | 服务器部署时（P2）；本机用访问令牌 |
| 管理令牌 `EXCELMANUS_MANAGE_TOKEN`、`X-Requested-With` 护栏 | 重做 | 每次启动的随机访问令牌 + Host/Origin 校验 |
| 首次引导（向导、教程、演示会话） | 重做 | [02 §8](02-interaction.md#8-首次引导) |
| 设置中心与搜索 | 保留 | |
| 版本检查、网页自助升级、备份管理、数据迁移（旧版多为 501） | 删除 | 桌面自动更新保留 |
| 部署脚本、滚动升级、Docker、nginx 模板 | 推迟 | P2 服务器部署 |
| 桌面：Electron、动态端口、前端端口持久化、崩溃重启、优雅退出、菜单、更新下载校验、Windows 安装器定制 | 重做 | 单后端进程、自定义协议、electron-updater（[13](13-desktop-mobile.md)） |
| 桌面打包 Node、Next standalone、Playwright Chromium | 删除 | 用 Electron 自带 Node 与离屏窗口 |
| Android WebView 客户端、扫码配对、局域网网关 | 推迟 | P2/P3，v1 遵守 [13 §5](13-desktop-mobile.md#5-手机端预留p2) 的约束 |
| 远程中继（设计稿） | 推迟 | P3 |
| 移动端布局 | 推迟 | 窄屏布局预留 |
| 隐私政策、服务条款页面 | 保留 | |
| 旧数据导入（excelmanus.db、Fernet 解密） | 删除 | 不迁移 |

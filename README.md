# ExcelManus Next

本机优先的表格代理：TypeScript / Node 24、SQLite、WebSocket、React/Univer 工作台、QuickJS 沙箱与 Electron 桌面。

## 当前交付

2026-10-10 V1 源码候选，基于现有仓库增量开发。不是静态演示页面，也不是已签名的正式安装包。

- [最新前端整体重构、371 项回归及待完成视觉验收](docs/acceptance/frontend-redesign-2026-10-10.md)
- [本次开发、验证与剩余发布条件](docs/acceptance/v1-2026-10-10.md)
- [使用帮助](docs/user-guide.md)
- [完整设计文档](docs/README.md)
- [本次架构取舍](docs/decisions/0023-v1-static-completion.md)

## 启动

需要 Node >=24、pnpm 10.11.0。下载源码后在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm start
```

打开终端输出的本机地址，在设置中配置自己的模型档案。默认数据目录为 `~/.excelmanus-next`；可通过 `EXCELMANUS_HOME` 指定新的测试目录。不要将真实密钥写入仓库或分享数据目录。

开发模式：`pnpm dev`。只启动后端：`node packages/server/src/main.ts --data-dir /绝对路径/测试数据`。

## 验证与构建

```sh
pnpm check:all
pnpm build:desktop
node scripts/evaluate-v1.ts --validate
```

安装 LibreOffice 后，保真测试会额外执行实际打开/转换；未安装时测试会明确输出缺少此证据。受限环境应给 LibreOffice 一个可写 HOME 和缓存目录。`build:desktop` 只构建产物，不等于仓库外安装、自检、签名或更新成功。

真实三模型评测需要独立的模型配置和显式执行，会产生 API 费用。本次只完成 40 个任务语料及离线验证，没有调用真实模型。

## 交付边界

当前已补齐原生图表/图片、条件格式/验证、表格读取分析、文件面板、REST 契约和诊断，并修复关闭/取消、结果分页与沙箱清理。确切能力范围、操作支持边界和无法在本次环境完成的发布验收请看当前验收记录。没有向 GitHub 推送、发布网站或创建安装器发布。

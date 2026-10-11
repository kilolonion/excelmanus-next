# ExcelManus Next

本机优先的表格代理：TypeScript / Node 24、SQLite、WebSocket、React/Univer 工作台、QuickJS 沙箱与 Electron 桌面。小型开源项目，功能优先。

## 当前状态

V1 功能与前端整体重构的源码已完成，还不是正式发布版，也没有签名安装包。还没做的功能和已知问题见 [待办与缺口](docs/backlog.md)。

- [使用帮助](docs/user-guide.md)
- [设计文档](docs/README.md)
- [开发约定](AGENTS.md)

## 启动

需要 Node >=24、pnpm 10.11.0。下载源码后在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm start
```

打开终端输出的本机地址，在设置中配置自己的模型档案。默认数据目录为 `~/.excelmanus-next`；可通过 `EXCELMANUS_HOME` 指定新的测试目录。不要将真实密钥写入仓库或分享数据目录。

开发模式：`pnpm dev`。只启动后端：`node packages/server/src/main.ts --data-dir /绝对路径/测试数据`。

## 检查与构建

```sh
pnpm check:all
pnpm build:desktop
```

装了 LibreOffice 时，部分测试会额外实际打开生成的文件；没装就跳过这一步。受限环境要给 LibreOffice 一个可写的 HOME 和缓存目录。`build:desktop` 只构建产物，不包含签名和安装器。

真实模型评测（`node scripts/evaluate-v1.ts`）需要你自己的模型配置，会产生 API 费用，按需运行。

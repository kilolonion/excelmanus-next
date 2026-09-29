# Spike：`node:sqlite` 在 Node 24 与 Electron 44 中的可用性（T-8）

> 结论先行。所有数据来自 `results/*.json`，由同一套 `src/probe.ts` 跑出。
> 唯一未测：Electron utilityProcess（原因见偏离 2）。

## 摘要表

| 能力 | Node 24.1.0 | Electron 44.4.3 run-as-node | Electron 44.4.3 主进程 | Electron 44.4.3 utilityProcess |
|---|---|---|---|---|
| `import "node:sqlite"` 免 flag | ✅（有 ExperimentalWarning） | ✅（无警告） | ✅（process.type=browser） | ⛔ 未运行（见偏离 2） |
| `--experimental-sqlite` flag | ✅ 接受且可用 | ✅ 接受且可用 | ✅（子进程探针） | ⛔ |
| `sqlite_version()` | 3.49.1 | **3.53.4** | 3.53.4 | ⛔ |
| WAL + synchronous=NORMAL + foreign_keys + busy_timeout 读回 | ✅ 全生效 | ✅ | ✅ | ⛔ |
| FTS5 `fts5(content)` | ✅ | ✅ | ✅ | ⛔ |
| 中文子串 `trigram` | ✅ 3 字以上命中正确 | ✅ 相同 | ✅ 相同 | ⛔ |
| 默认 `unicode61` 对中文 | ⚠️ 子串 0 命中（整句一 token） | ⚠️ 相同 | ⚠️ 相同 | ⛔ |
| JSON1 `json_extract` | ✅ | ✅ | ✅ | ⛔ |
| 事务延迟 p99（10k × [1 log+1 投影]/txn） | 0.051ms | 0.055ms | 0.106ms | ⛔ |
| 崩溃耐久 SIGKILL | ✅ 500/500 + integrity ok | ✅ | ✅ | ⛔ |
| 双连接 busy_timeout | ✅ 等锁成功/超时 `database is locked` | ✅ | ✅ | ⛔ |

## 关键测量数据

- **事务延迟**（Node / run-as-node / Electron 主进程）：p50 ≈0.015ms、p99 ≈0.05–0.11ms、max 6–11ms；批量 100 条事务 ≈0.3ms。**远低于 docs/10 §2「单事务 <5ms、p99<20ms」目标**。
- **SQLite 版本**：Node 24.1 构建 3.49.1；Electron 44.4.3（Node v24.21.0）构建 3.53.4——不同构建的 SQLite 版本不同，迁移/特性判断应以 Electron 侧实测为准。
- **FTS5 中文**：`unicode61` 整句一 token（`生成`/`模型生成`/`检索`/`沙箱隔离模型` 全 0 命中）；`trigram` 3 字以上子串精确命中（`生成代`→row1、`模型生成`→row1、`要可靠`→row2），**2 字查询 `沙箱` 0 命中**——trigram 需 ≥3 字符，产品中文搜索需处理 <3 字查询。
- **崩溃耐久**：子进程逐条提交，第 500 条 SIGKILL；重开库 committed=500（=杀前确认数）、`integrity_check=ok`。
- **双连接锁**：持锁 ~1.5s，第二进程 busy_timeout=5000 → 等 ~1.5s 写入成功；bt=200 → ~220–245ms 后 `database is locked`。
- **Node 24.1 免 flag 但有警告**（每进程 `ExperimentalWarning: SQLite`）；**Electron 44 的 Node 24.21 免 flag 且无警告**。

## 环境

| 项 | 值 |
|---|---|
| 机器 | macOS arm64 |
| Node | v24.1.0（/opt/homebrew，V8 13.6.233.10） |
| Electron | **44.4.3**（npm 精确锁定，二进制经 install.js 默认 GitHub 源下载成功，约 110MB/140KB/s） |
| Electron 内 Node | v24.21.0，V8 14.x |
| SQLite | Node 构建 3.49.1 / Electron 构建 3.53.4 |

## 偏离与意外（重要）

1. **shell 环境全局有 `ELECTRON_RUN_AS_NODE=1`**：跑真实主进程必须 `env -u ELECTRON_RUN_AS_NODE`，否则进程静默退化为 Node 模式（`process.type` undefined、`import "electron"` 只得 npm 桩）。本机 Devin.app 曾因此误判为"不暴露主进程 API"。
2. **utilityProcess 未测**：本环境下 Electron 44.4.3 的 `app.whenReady()` 永不 resolve（`isReady()` 轮询 75s 恒 false；`--no-sandbox`/`--disable-gpu`/打包目录形态同样不触发），而 `utilityProcess.fork` 硬性要求 ready（实测抛 `utilityProcess cannot be created before app is ready`）。`electron-main` 探针在 browser 主进程上下文直接执行成功（node:sqlite 加载路径不依赖 ready），**推测** ready 不触发与本 shell 会话缺少 GUI 交互上下文有关；建议在真实桌面会话或带显示环境的 CI 上补测 utilityProcess。
3. Electron 44 二进制下载**最终成功**——首次失败实为下载慢（~140KB/s、110MB）被 120s 超时掐断；`timeout 2400` 的后台任务完整下完。未换镜像、未改 `.npmrc`。
4. `PRAGMA busy_timeout` 读回列名是 `timeout` 而非 `busy_timeout`。
5. 崩溃用例给子进程 2ms/条 pacing 保证父进程能在第 500 条时 SIGKILL（不改变逐条 COMMIT 语义）；直接拉高 stdout 缓冲的 Electron-Node 子进程会在父进程反应前写完。
6. ai SDK 无关——本 spike 无第三方 SQLite 库，全部 `node:sqlite`。

## 复现

```bash
cd spikes/node-sqlite
pnpm install                                        # electron@44.4.3
node src/probe.ts node                              # → results/node.json
ELECTRON_RUN_AS_NODE=1 "$(pnpm exec electron --version >/dev/null 2>&1; node -e 'console.log(require("electron"))')" \
  src/probe.ts electron-run-as-node                  # → results/electron-run-as-node.json
env -u ELECTRON_RUN_AS_NODE node_modules/.pnpm/electron@44.4.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  src/electron-main.mjs                              # → results/electron-main.json
env -u ELECTRON_RUN_AS_NODE <同上二进制> src/electron-utility.mjs   # utilityProcess（需 ready 可触发）
```

探针自带 240s 看门狗；Electron 入口 60s 看门狗 + ready 15s 竞速兜底。

## 对 ADR 的提示（未支撑处标"推测"）

- 已验证：Node 24 与 Electron 44 主进程内 `node:sqlite` 完整满足 docs/10 §2 的打开参数、FTS5/JSON1、事务延迟、崩溃耐久、锁行为——性能余量约 200–400 倍于判据。
- **未验证**：Electron 44 utilityProcess（ready 门未过）。utilityProcess 本质是 Chromium 托管的 Node 进程，**推测** node:sqlite 可用性与主进程一致，但 ADR 需把"utilityProcess 实测补跑"列为遗留项。
- unicode61 中文行为证实：FTS5 中文检索必须用 `trigram` 且处理 <3 字查询。

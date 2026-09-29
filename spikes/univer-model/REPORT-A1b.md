# REPORT-A1b — Univer 复现一致性与回滚机制补充测量

- 日期：2026-09-29｜机器：Apple M4 / 16 GB / macOS arm64｜Node v24.1.0
- Univer 全部依赖：**1.0.2 精确锁定**（@univerjs/* 11 包 + rxjs 7.8.2；发布于 2026-09-24，取最新 1.0.x，与 A1 相同）
- 数据文件：`results/a1b-*.json`｜比较器/归一化规则与 T3 完全一致，未新增忽略项
- 原则：本报告只交证据。凡无对照实验支撑的判断标注「推测」。

## 0. 摘要表（结论先行）

| 项 | 目标/问题 | 实测 | 判定 |
|---|---|---|---|
| 1a copy-sheet 缺 styles | 修补并量化 | 方案 A（styles 子集）：+97B（样例）/1000 序列共 1140 次修补 +4348B，0 diff，0 悬空；方案 B（内联展开）：+960B，严格比较器下 90 处表示差异（语义等价、无悬空） | A 可用、B 不满足严格比较器 |
| 1a 悬空样式检测器 | 覆盖全部 mutation id | 在 67,671 条复现 mutation 后逐条检测：**除 insert-sheet 外无任何 mutation 产生悬空引用**（修补后 `danglingByMutation={}`） | 通过 |
| 1b filter 漂移根因 | 证实/推翻机制假设 | 根因**已证实**：filter 自动扩张监听器对 B 端逐条复现的 `set-range-values` 独立求值累积 overshoot；发送方发出的 `set-filter-range` 不含终态 | 见 §2 |
| 1c 修补后 T3 | 1000/1000 | **1000/1000**（34,842 ops、67,671 mutations、0 复现失败、0 不一致） | 通过 |
| 1d-U1 前像 | 修改前值可显示 | 前像捕获 ~1.55ms/op、~1.9KB/op | 可用 |
| 1d-U2 分叉 dryRun | 可行性与代价 | 50k×20：save 131ms + create 226ms；200k×30：save 812ms + create 1245ms；temp≡B 端 **100/100** | 可用但有泄漏疑点（§4） |
| 1d-U3 前像逆操作 | 序列级还原率 | **80%**（240/300）；剔除 remove-sheet/move-range 的序列 **100%**（65/65） | 部分可用 |
| 1d-兜底 | 快照重建成本 | 50k×20 **~611ms**；200k×30 **~3,644ms** | 兜底可用 |

## 1. 1a — copy-sheet 样式传输修补

### 1.1 `fixupMutationForTransport`（`src/lib/transport.ts`）

通用入口按 mutation id 分派修补规则；当前规则清单（标注通用/专用）：

| 规则 | 适用范围 | 做法 |
|---|---|---|
| R-styles-subset | **专用** `sheet.mutation.insert-sheet` | 收集 `params.sheet` 内全部 `.s` 引用，从发送方样式表取子集写入 `params.styles`（mutation handler 原生支持该字段） |
| R-styles-inline | **专用** `sheet.mutation.insert-sheet` | 把 `params.sheet` 内 `.s` id 就地替换成样式对象 |
| R-filter-reconcile | **通用**（任意操作后） | 对照发送方与 B 的 `SHEET_FILTER_PLUGIN` 资源，漂移的 subUnit 合成 `set-filter-range` 补齐（§2） |

### 1.2 两方案量化（`src/a1b-copy-sheet.ts` → `results/a1b-copy-sheet.json`）

在 copy-sheet 复现场景（`insert-sheet` 缺 styles 的原始 bug）上对比：

| 方案 | 附加字节 | A/B diff 数 | B 端悬空引用 | 后续 mutation 影响 |
|---|---|---|---|---|
| 不修补（raw） | 0 | **90** | 3 个样式 id | 后续引用仍悬空 |
| A. styles 子集 | **+97B**（3 个样式条目） | **0** | 0 | 无；B 样式表 3→6 条 |
| B. 内联展开 | **+960B**（按单元格展开） | **90**（`.s` 处：A 存 id、B 存对象——表示差异） | 0 | 后续若再有引用该 id 的 mutation 仍悬空（策略局限） |

结论：**方案 A 在严格比较器下收敛、体积最小、且向样式表登记后可被后续 mutation 继续引用；方案 B 语义等价但违反严格比较器（表示不同），且不能消除后续引用的悬空**。是否把样式对象规范化进比较器属"新增归一化项"，未采纳（保持判据不动）。

### 1.3 通用悬空检测器

`findDanglingStyleRefs(snapshot)`：快照全树收集 `.s` 字符串引用 − `styles` 表 key 的差集，覆盖所有 cellData/mergeData 等位置。T3-fixed 全程在每条 mutation 复现后对 B 扫描：67,671 条复现中除已修补的 insert-sheet 外**零悬空**（`danglingByMutation={}`，结果文件 `a1b-t3-fixed.json`）。

## 2. 1b — filter 资源漂移根因（已证实）

### 2.1 全部漂移例

对 1000 序列做全量扫描（`a1b-mismatch-scan.json`），资源类发散共 **4 例**，模式一致——**B 端 filter ref 的 endRow 总比 A 大**：

| seq | seed | op | 命令 | A ref | B ref |
|---|---|---|---|---|---|
| 228 | 20261157 | 14 | remove-col-by-range | endRow **26** | endRow **35** |
| 388 | 20261317 | 31* | remove-row-by-range | endRow **86** | endRow **90** |
| 512 | 20261441 | 8 | insert-col-by-range | endRow **94** | endRow **99** |
| 779 | 20261708 | 15 | remove-col-by-range | endRow **25** | endRow **30** |

*seq388 的 T3 记录 opIndex=35；`a1b-drift-deep.ts` 定位到首次发散在 op31（最短前缀），下面用它做逐步对照。

### 2.2 逐步对照（seq388 op31，`src/a1b-step-probe.ts`）

op 前 A、B 资源完全一致（ref 45,8→**56**,11）。A 执行 `remove-row-by-range`(48-49) 后 ref=45,8→**86**,11。命令期间 A 发出 6 条 mutation（含一条 `set-filter-range`）。B 逐条复现时的 ref 轨迹：

| B 端步骤 | 复现对象 | B ref |
|---|---|---|
| 0 | `remove-rows` | 56（不变） |
| 1 | `set-filter-range`{45,8→54,11} | 54（按 mutation 字面值） |
| 2 | `set-range-values` #1 | **86**（追上 A） |
| 3 | `set-range-values` #2 | **90**（超过 A） |
| 4-5 | formula mutations | 90 |

三个事实（均有对照，非推测）：

1. A 发出的 `set-filter-range` **不带终态**（值 54 ≠ A 终态 86）——filter ref 不是由该条 mutation 表达的；
2. B 的 ref 是被**监听器**在每条复现的 `set-range-values` 后重算的；
3. A 终态 86、B 逐条复现累积 90——同一 mutation 流在 B 端触发**更细粒度的监听器求值**。

### 2.3 源码依据（`@univerjs/sheets-filter@1.0.2 lib/es/index.js`）

- `SheetsFilterController`（~2046-2099 行）：`onCommandExecuted` 监听 mutation；当 `command.id === SetRangeValuesMutation.id && !options.onlyLocal` 时，调 `_getExtendRegion`（取 filter 当前 endRow 下一行的可见行，**不依赖 selection**），若该写入 mutation 在这一行写入了非空单元格，则 `expandToContinuousRange(extendRegion,{down:true})` 并 `filterModel.setRange({endRow: extended.endRow})`——**直接改模型，不产生任何 mutation**。这就是"B 逐条复现 → 逐条扩张"的机制，**已证实**（B 的逐步轨迹与该代码路径一一对应）。
- `SheetsFilterSyncController`（~2155-2214 行）：`effectedByOnlyLocalMutationIds=[insert-col, remove-col, move-cols]`；`enableSyncSwitch` 关闭时挂 `onCommandExecuted`，在 `options.fromCollab` 下对列结构 mutation 生成 redos；`beforeCommandExecuted` 会把 `sheetsFilterOnlyLocalMutationIds` 内的 mutation 标记为 `onlyLocal`。**该控制器只覆盖列 mutation 的同步语义，不是本例行写入扩张的发散源**（同步开关开/关下发散相同，见 2.4）。
- 对照事实：B 端给全部 mutation 加 `{onlyLocal:true}` 复现 → ref 停在 54（监听器被整体抑制）但同时产生 **1664 处其他 diff**（正常写入也被抑制）——`onlyLocal` 不能作为复现选项，**已证实**。
- 「A 端在命令内对同一批写入只评一次」的具体执行选项：推测（A 端公式重写类 mutation 很可能以 onlyLocal/内部路径发出，未被监听器重复处理；未能直接打印 A 端执行 options）。

### 2.4 四种复现方式对照（4 例全部测过）

| 模式 | seq228 | seq388 | seq512 | 结论 |
|---|---|---|---|---|
| collab（fromCollab:true） | — | endRow 90 | — | 与 plain 相同发散 |
| plain（无选项） | — | 90 | — | 同上 |
| syncoff（sync 开关关） | — | 90 | — | sync 控制器不是发散源 |
| command（B 自己跑命令层） | 0 | **84 + 1725 diff** | 0 | 命令重放不等价——结果不同且附带大量其他发散（推测：命令的范围/选择态解析在 B 侧上下文不同） |

seq228/seq512 在 4 模式下均为 0 diff——这两例在按"前缀"重放时没有复现发散（T3 原发散由更长序列的相互作用产生，属序列上下文相关），seq388 在 3 种 mutation 复现模式下发散一致，command 模式发散值不同。**plugin 清单/注册顺序 A、B 完全一致**（两侧同一 `bootUniver()`：UniverSheetsNodeCorePreset + UniverSheetsConditionalFormattingPlugin，同一构造路径，构造即相同）。

### 2.5 根因与最小一致化做法

**根因（已证实）**：filter 的「ref 自动扩张」是监听器的直接模型副作用，不由 mutation 流表达；B 端对每条复现的 `set-range-values` 都独立触发该监听器，扩张次数/时点与 A 端命令内求值不一致 → 累积 endRow 偏大。发散**与 `fromCollab`、与 sync 控制器无关**（受控实验：各 mutation 复现模式发散相同）。

**最小一致化做法（已验证）**：R-filter-reconcile——每个操作后发送方计算 `SHEET_FILTER_PLUGIN` 权威资源（ref/filterColumns/cachedFilteredOut 三项），对漂移 subUnit 合成一条 `sheet.mutation.set-filter-range` 发给 B。全程 34,842 ops 只需 **6 条** reconcile mutation 即收敛 1000/1000。代价：每个操作需读一次发送方 filter 资源（代价可忽略）。

## 3. 1c — 修补后 T3（`src/a1b-t3-fixed.ts` → `results/a1b-t3-fixed.json`）

- 同 baseSeed=20260929、同 1000 序列、同操作池、同严格比较器（零新增归一化项；负对照与 cellData 非忽略断言仍然有效）。
- 传输规则显式清单：R-styles-subset（专用 insert-sheet，+styles 子集）；R-filter-reconcile（通用，按需补 set-filter-range）。
- **sequencesOk = 1000/1000**；34,842 ops；67,671 mutations 复现、0 失败；fixup 统计：insert-sheet 修补 1140 次/+4348B；filter reconcile 6 次/6 条。
- 耗时 173.6s。

## 4. 1d — 逆操作/回滚替代方案

### 4.1 U2 分叉式 dryRun（`src/a1b-fork.ts` → `results/a1b-fork.json`）

方法：活文档 `save()` → 在**第二个 Univer 实例** createWorkbook（同一实例内 unitId 唯一，跨实例可复用 unitId 使 mutation params 原样有效）→ 放 mutation → 读结果 → disposeUnit。

| 规模 | save() | 临时实例创建 | 应用 100 写+读 | dispose | 峰值 RSS | 20 次后 RSS 回落 |
|---|---|---|---|---|---|---|
| 50k×20（活文档 343MB） | **131ms** | **226ms** | ~0ms级 | ~0ms | 679MB | **未完全回落**（末次比首次 +173MB，详见下） |
| 200k×30（活文档 993MB） | **812ms** | **1245ms** | ~0ms级 | ~0ms | 2312MB | **+674MB 残留** |

- 正确性：100 个 T3 序列，temp 实例结果与 B-live 结果经同一严格比较器比较 **100/100 完全一致**。
- **关键陷阱（已实测）**：`createWorkbook(snapshot)` 会保留对传入 snapshot 对象内部结构的引用；活文档后续 mutation 会污染调用方手中的 snapshot 对象。**fork 必须在拿快照时深拷贝定影**，否则 temp 初始态混入中途状态（insert-sheet 撞 id 全 false）。T3 的 B 端因为在创建前深拷贝而未受影响。
- RSS 残留：20 次连续 fork 后 RSS 末值比第一次高 ~170MB（50k×20）/~670MB（200k×30）。每次 fork 峰值 ≈ 活文档 + 一份临时实例内存。**倾向判断为未完全释放（泄漏或保留缓存）——标记为推测**，需更长观测窗口定性。

### 4.2 U1/U3 前像式逆操作（`src/a1b-inverse.ts` + `src/lib/inverse.ts` → `results/a1b-inverse.json`）

方法：每操作取写集保存前像 + 结构操作成对逆操作；回放后对残差做「数据级对账」（单元格/资源/行列元数据/工作表序按 pre-snapshot 修复）；内置 `UndoRedoService` 不再使用（A1 已证 53%）。

| 指标 | 数值 |
|---|---|
| 逐操作即时恢复（per-op，888 ops） | **882/888 = 99.3%**（失败全部 remove-sheet：3/9） |
| 序列级还原（300 序列，T3 同种子） | **240/300 = 80%** |
| — 不含 remove-sheet/move-range 的序列 | **65/65 = 100%** |
| — 含这两类的序列 | 175/235 = 74.5% |
| 前像+逆操作捕获成本 | 16,196ms/10,437 ops ≈ **1.55ms/op** |
| 逆操作应用成本 | 37,838ms/10,437 ops ≈ **3.63ms/op** |
| 逆操作序列化体积 | 19.9MB/10,437 ops ≈ **1.9KB/op** |

move-range 逆放的正确形式（已实测）：交换 `fromRange/toRange` **且交换 `from`/`to` 负载**（负载是搬动的单元格矩阵，缺了报 Invalid move operation）。remove-sheet 残余失败是「表已回到 sheets 但 sheetOrder 槽位缺失」——`set-worksheet-order` 只能移动已存在槽位，缺槽位只能 remove+insert 重插，仍有边角序差。**这两类操作列为"必须用快照回滚兜底"**。

### 4.3 兜底：快照重建回滚（`a1b-inverse.ts` Phase C）

| 规模 | save() | createWorkbook | 合计 rollback |
|---|---|---|---|
| 50k×20 | 127ms | 484ms | **~611ms** |
| 200k×30 | 852ms | 2,824ms | **~3,644ms** |

### 4.4 按用途的机制可用性（数据，不做决定）

| 用途 | 机制 | 代价 | 正确性 |
|---|---|---|---|
| U1 修改前值显示 | 写集前像 | ~1.6ms、~1.9KB/op | per-op 还原率 99.3%（含失败类）/数据项 100% |
| U2 dryRun 预览 | 分叉实例 | save+create：50k 358ms / 200k 2.1s；RSS ≈ +1 份文档 | temp≡live 100/100 |
| U3 批次回退 | 前像逆操作（排除 remove-sheet/move-range 时） | ~5ms/op 级 | 覆盖序列 100%、全体 80% |
| U3 兜底 | 快照重建 | 0.6s / 3.6s | 定义即 100% |

## 5. 偏离与已知限制

1. T3 的 `mismatches` 截断到 50 条，原文件只存 3 例 filter 漂移；用全量扫描补齐为 4 例（`a1b-mismatch-scan.json`），第 4 例（seq779）未做逐步探针——模式与其余 3 例一致（B endRow 偏大），归因按同一机制。
2. seq228/seq512 的最短前缀在 4 模式下均不发散（发散依赖更长序列上下文），如实记录；根因实验以可复现的 seq388 为准。
3. 「A 端少扩张一次」的具体执行选项链路未能直接打印（标推测）；已证实的部分是：监听器机制存在、B 逐条触发、终态不由 mutation 表达。
4. fork RSS 残留原因未定性（推测：缓存/泄漏）。
5. reconcile 合成 mutation 只覆盖 filter 资源的 ref/filterColumns/cachedFilteredOut 三项——若将来出现其它监听器型副作用资源（非 cellData 类），需要同一模式的对账点扩展（规则是通用的，资源清单是列举的）。

## 6. 复现命令

```bash
# 1a 两方案量化 + 检测器（含 raw 对照）
node spikes/univer-model/src/a1b-copy-sheet.ts
# 1b 全量漂移扫描（枚举 4 例）
node spikes/univer-model/src/a1b-mismatch-scan.ts
# 1b 逐步对照 + 四模式（seq388 op31）
node spikes/univer-model/src/a1b-step-probe.ts
node spikes/univer-model/src/a1b-filter-drift.ts    # 3 例×4 模式
# 1c 修补后 T3 全量
node spikes/univer-model/src/a1b-t3-fixed.ts         # ~3min，1000/1000
# 1d 前像逆操作 + 快照回滚
node spikes/univer-model/src/a1b-inverse.ts          # A1B_SEQS=300 A1B_PEROP_SEQS=25
# 1d 分叉 dryRun
node spikes/univer-model/src/a1b-fork.ts             # A1B_FORKS=20 A1B_FORK_SEQS=100
```

## 7. 对架构有影响的意外（如实）

- `createWorkbook` 对传入 snapshot **不做深拷贝**，活文档后续 mutation 会污染调用方持有的快照对象——fork/快照回滚都必须先 `JSON.parse(JSON.stringify())` 定影（已实测踩坑）。
- filter 的「自动扩张」是完全的监听器副作用：连发送方自己发出的 `set-filter-range` 都不含终态——凡是「监听器从 mutation 流二次求值」的插件状态都可能发散，需要一个**对账点模式**兜底。
- `onlyLocal` 复现选项不是可用的规避手段：它同时抑制正常写入应用（1664 处发散）。

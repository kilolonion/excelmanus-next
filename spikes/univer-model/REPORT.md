# M0-A1 Spike 报告：Univer 作为服务端「活文档」内存模型

> 结论先行：**「服务端跑 Univer 无头实例 + mutation 直接复现」这一核心假设部分成立，但存在两个必须正视的缺口**——① `copy-sheet` 产生的 mutation 不携带样式表，B 端复现会得到悬空样式引用（已证实为 Univer 1.0.2 的复现缺口，非比较器噪声）；② `UndoRedoService` 的 `undoMutations` 在 `move-rows`/`move-cols` 等操作上不能完整还原，不能作为 dryRun 回滚的可靠机制（53% 序列级还原率）。

## 0. 摘要表

| 测试 | 通过标准 | 实测值 | 判定 |
|---|---|---|---|
| T1a 载入 200k×30（6M 单元格） | ≤3s 且 RSS ≤1.5GB | load p50 **1268ms**（min 1246 / max 1291），进程 RSS p50 **1462MB**（max 1475），isolate 堆 873MB | **通过（内存贴线）** |
| T1b 载入 50k×20（产品基准，1M 单元格） | 无硬指标 | load p50 **238ms**，isolate 堆 195MB | 参考值 |
| T1c RSS≤1.5GB 最大单元格数 | 报告量级 | **约 8.1M 单元格**（270k×30，RSS 1427MB；290k×30=8.7M 即 1522MB 超标） | 参考值 |
| T2 单单元格写值 p99 | ≤20ms | 命令路径 p99 **0.05ms**（50k×20）/ **0.09ms**（200k×30）；直跑 mutation p99 0.01ms | **通过（余量 ~200 倍）** |
| T2 插/删单行 | 无硬指标 | 50k×20：**~77ms**；200k×30：**~417ms**；与位置（上/中/下）无关 | 参考值 |
| T3 A→B mutation 复现 1000 序列全一致 | 1000/1000 | **908/1000** 一致，**92** 发散；replay 失败 0 | **未达标** |
| T4 写集推导 ⊆ 自检违例 | 0 | **0**（6201 个变异操作逐一核对） | **通过** |
| T5 逆操作回滚全序列还原 | 全部序列还原 | **106/200 = 53%** | **未达标** |

环境：Apple M4 / 16GB / macOS arm64；Node **v24.1.0**（原生 type stripping，无构建步骤）；pnpm 10.11.0。
Univer：**全部 `@univerjs/* = 1.0.2` 精确锁定**，发布于 2026-09-24T11:12Z（1.0.0/1.0.1/1.0.2 全部发布于 9-23/24，均未满 7 天；按任务约定取最新 1.0.x 并在此注明）。
依赖许可证：`pnpm check:licenses` 全绿（Univer 全家 Apache-2.0，传递依赖无白名单外项）。**无 DOM polyfill——`UniverSheetsNodeCorePreset` 在纯 Node 下直接可用。**

随机种子：T3 `baseSeed=20260929`（序列 i 用 `baseSeed+i`）；T4 `91607007`；T5 `55110033`；PRNG 为自实现 mulberry32。

## 1. 装配方式与插件清单（A、B 两端相同）

`bootUniver()`（`src/lib/univer-node.ts`）：

- preset：`UniverSheetsNodeCorePreset()` —— 内含 `docs / engine-formula / rpc-node / sheets / sheets-data-validation / sheets-drawing / sheets-filter / sheets-formula / sheets-hyper-link / sheets-numfmt / sheets-sort / sheets-thread-comment / thread-comment`（来自该 preset 1.0.2 的依赖清单）；
- 手动追加：`UniverSheetsConditionalFormattingPlugin`（不在 node-core preset 内，但可无头运行）；
- locale：`en-US`（node-core preset 自带）；
- mutation 捕获：`ICommandService.onCommandExecuted`，只收集 `CommandType.MUTATION` 事件的 `{id, params}`；
- B 端复现：每条 mutation 先 `JSON.parse(JSON.stringify(params))` 再 `executeCommand(id, params, { fromCollab: true })`。

四条「可选」操作的无头可用性：**排序 ✅（sheets-sort）、筛选 ✅（sheets-filter）、条件格式 ✅（手动注册）、数据验证 ✅（sheets-data-validation）全部可用**，均已进入操作池。

## 2. T1 载入

方法：每规格 5 次**全新 `worker_threads`**（`resourceLimits.maxOldGenerationSizeMb=6144`），快照在 worker 内生成，`loadMs = createWorkbook + save()`（save 强制物化整个 cellMatrix）。二分上限改用**真实子进程**（worker 间共享进程 RSS，会污染测量）。

| 规格 | loadMs p50 [min,max] | createMs | saveMs | RSS MB p50 | heapUsed MB |
|---|---|---|---|---|---|
| a) 200,000×30 | **1268** [1246,1291] | ~780 | ~490 | **1462** [1422,1475] | 873 |
| b) 50,000×20 | **238** [236,241] | ~140 | ~95 | 见备注 | 195 |

备注：worker_threads 共享进程 RSS——b 规格的 rssAfter（~1476MB）是 a 规格 5 个 worker 跑完后的进程水位，**不是该文档独占**；b 文档自身增量以 isolate 堆 195MB 为准。子进程二分曲线（每点一个全新进程）：

```
170k×30 → RSS 1012MB ok
230k×30 → RSS 1250MB ok
260k×30 → RSS 1378MB ok
270k×30 → RSS 1427MB ok   ← 上限
290k×30 → RSS 1522MB 超标
530k×30 → RSS 2500MB 超标
1020k×30 → 子进程 OOM（默认 4GB 堆，快照生成阶段）
```

**T1c 结论：RSS≤1.5GB 约可载入 8.1M 单元格（270k×30）。** 数据密度：每千单元格约 +175MB/百万——即 6M 单元格 ≈ 1.4GB 稳态。

## 3. T2 提交延迟

方法：同一 worker 内先载入文档，再计时 `executeCommand`（命令路径含拦截器/undo 工厂）与直跑 `sheet.mutation.set-range-values`（跳过命令层）。

| 文档 | 操作 | n | p50 | p95 | p99 | max | mean |
|---|---|---|---|---|---|---|---|
| 50k×20 | 写值·命令 | 10,000 | 0.01 | 0.03 | **0.05** | 3.54 | 0.02 |
| 50k×20 | 写值·mutation | 10,000 | 0.00 | 0.01 | 0.01 | 2.10 | 0.00 |
| 50k×20 | 插行 上/中/下 | 33×3 | 76.5–77.0 | — | 77.8–117.6 | 117.6 | ~77.6 |
| 50k×20 | 删行 上/中/下 | 33×3 | 77.0–77.5 | — | 80.2–82.0 | 82.0 | ~77.7 |
| 200k×30 | 写值·命令 | 10,000 | 0.01 | 0.05 | **0.09** | 4.45 | 0.02 |
| 200k×30 | 写值·mutation | 10,000 | 0.00 | 0.01 | 0.01 | 0.11 | 0.01 |
| 200k×30 | 插行 上/中/下 | 33×3 | 415.8–418.4 | — | 464.7–473.0 | 473.0 | ~420 |
| 200k×30 | 删行 上/中/下 | 33×3 | 416.5–419.2 | — | 421.1–465.9 | 465.9 | ~418 |

观察：单行插删成本 ≈「移动 doc 中该行之后所有单元格」的矩阵重排（200k×30 ≈ 6M 单元格重排 ~417ms），**与插入位置无关**——说明 Univer 的行插删不是按受影响行数线性缩放的，而是近似整表重建（或位置无关的批量搬移）。这对「大表上频繁结构编辑」是架构相关的数字。

## 4. T3 复现一致性

**结果：908/1000 序列一致；92 序列发散；64724 条 mutation 复现 0 失败（`repFail=0`，全部可 JSON 序列化，`unserializable: []`）。**

发散按操作归因（`causedDiff`，即该操作执行后首次出现 A/B diff）：

| 操作 | 执行 | 成功 | 失败 | 引发发散 | 失败原因 |
|---|---|---|---|---|---|
| copy-sheet | 468 | 468 | 0 | **88** | — |
| remove-cols | 923 | 923 | 0 | 2 | — |
| insert-cols | 948 | 874 | 74（越界锚点） | 1 | `Anchor column is out of bounds`×74 |
| remove-rows | 1122 | 1122 | 0 | 1 | — |
| 其余 33 种操作 | ~29k | — | — | 0 | 见下 |

其他失败（均为命令返回 `false` 或抛错，属参数生成的合法失败，不引发发散）：copy-down 132（目标区已有内容等 `returned false`）、set-filter 83、move-cols 79、insert-rows 11（锚点越界）、move-rows 7（含 `Cannot move header row of filter`×2、`Invalid move operation`×2）、set-filter-criteria 9、move-range 1、autofill 1（`Cannot read properties of undefined`）。完整逐操作统计见 `results/t3-replay.json` 的 `opStats`。

### 4.1 copy-sheet 发散（已证实，非比较器问题）

- **最小复现**：`seed=20260937, seqIndex=8, opIndex=9`（`sheet.command.copy-sheet`）。A 侧拷贝出的新表中单元格 `.s` 指向 A 本地生成的样式 id（如 `mhLlCy`）；捕获到的 `sheet.mutation.insert-sheet` 的 params 只含 `sheet` 字段、**不含 `styles` 表**（mutation handler 支持 `styles` 字段，但该命令的实现没有填）；B 端复现后新表单元格引用悬空样式 id。已用内容归一化排除样式 id 命名差异——这是真实的引用丢失。
- **影响评估**：若产品让「前端执行 copy-sheet → mutation 发服务端」，服务端模型中新表样式会缺失。**缓解方案（未实施，属推测）**：在传输层对 `insert-sheet` 补发 `styles` 子集，或改用「命令转发」而非「mutation 转发」处理 copy-sheet。

### 4.2 结构操作引发的发散（已证实）

- **remove-cols**：`seed=20261157, seq=228, op=14`。删列后 `resources.10.data`（`SHEET_FILTER_PLUGIN`）中某筛选区域的 `ref.endRow` A=26 / B=35——命令路径的拦截器会联动更新筛选资源，而直放 mutation 不重算资源。insert-cols/remove-rows 各 1 例同类。
- **判断**：mutation 复现 ≠ 命令语义等价——**命令有拦截器/控制器副作用（filter range 联动、公式重算触发等），这部分逻辑不在 mutation payload 里**。对架构的含义：若服务端只做「mutation replay」，它会复现单元格数据但可能复现不了资源层联动；若改做「command replay」，又要求服务端跑与前端完全相同的命令层（可行，本 spike 的 A 端即是），但那时 B 就不只是「被动复现」而是「重放用户命令」——两种模式的边界需要 ADR 拍板。

### 4.3 比较器与忽略清单

`src/lib/compare.ts`：严格深比较（忽略对象 key 序、数组逐元素比对），**没有路径级 ignore 规则**——`ignoreRules: []`。替代方案是在 diff 前做 `normalizeSnapshot` 语义归一，每一项归一都在此列出并说明「观察到的差异/为何非语义差异」：

| 归一项 | 观察到的差异 | 为何不是语义差异 |
|---|---|---|
| styles 表按内容规范化（样式 id→内容哈希，并同步重写所有 `.s` 引用） | A/B 对同一份样式内容生成不同随机 id（`mhLlCy` vs `HvtKiE`） | id 是内部命名，无跨实例意义；样式内容与「谁引用谁」仍全量比对 |
| 插件 resource 空条目：`"sheetId":[]` ≡ 缺 key；`data:""` ≡ `data:{}` | 命令路径登记空数组/空对象，复现路径不登记 | 空规则集与无规则语义相同 |
| `cell.t===3 && v:boolean` → `v` 归一成 0/1；显式 `t` 与 `v` 推断类型一致则删 `t` | undo 重写后 `v:false`（布尔形态） vs 未触碰单元格的 `v:0,t:3` | Univer 两种合法表示同一布尔值 |
| `rowData/columnData` 中 `hd:0` ≡ 缺省；全默认空条目 ≡ 缺省 | undo 残留显式 `hd:0` / `{}` | 显式默认与缺省语义相同 |
| 未被任何 cell/row/col 引用的 styles 条目删除 | undo 不清 styles 表（append-only） | 孤儿样式不渲染、不影响文档语义 |

负对照（全部通过）：改 B 单元格值报 1 diff、改样式属性报 1、改合并区报 2、断言 cellData 未整体忽略。**cellData 参与全量比对**。

## 5. T4 写集推导

`src/lib/writeset.ts`：对 T3 观察到的全部 **37 个 mutation id** 实现 `deriveWriteSet(mutation)→{regions, bookMeta, paramsOnly}`。自检：对 200 个序列逐操作 diff 前后快照，「实际变化单元格 ⊆ 推导写集」。**违例 = 0**（6201 个变异操作逐一核对）。

规则表（完整 37 条见 `results/t4-writeset.json` `ruleTable`；下表为分类摘要）：

| mutation id | 推导规则 | params-only |
|---|---|---|
| `sheet.mutation.set-range-values` | cellValue `{row:{col}}` 键集的最小包围矩形 | ✅ |
| `formula.mutation.set-formula-data` / `set-array-formula-data` | formulaData / arrayFormulaRange+CellData 键集 | ✅ |
| `formula.mutation.set-trigger-formula-calculation-start` | `dirtyRanges` 列表 | ✅ |
| `formula.mutation.remove-other-formula` / `set-formula-calculation-{result,notification,end}` | **保守整表**（params 只含公式 id/通知，无法映射单元格） | ❌ 需公式→单元格映射 |
| `sheet.mutation.insert-row` / `remove-rows` | `[startRow, 表尾) × 全列` + bookMeta.resources（坐标空间移动会联动 DV/CF/filter 资源） | ✅（需当前 rowCount 定界） |
| `sheet.mutation.insert-col` / `remove-col` | `全行 × [startColumn, 表尾)` + resources | ✅（需 columnCount） |
| `sheet.mutation.move-rows` / `move-columns` | `[min(src,tgt), max(src,tgt)]` 条带 × 全宽/全高 | ✅ |
| `sheet.mutation.move-range` | fromRange ∪ toRange（可跨表） | ✅ |
| `sheet.mutation.reorder-range` | range 内全部单元格（排序） | ✅ |
| `sheet.mutation.insert-sheet` / `remove-sheet` / `set-worksheet-order` / `set-worksheet-name` | 表级/簿级结构字段（sheetOrder/resources/name） | ✅ |
| `sheet.mutation.add/remove-worksheet-merge` | merge ranges → mergeData + 区域单元格 | ✅ |
| `sheet.mutation.set-*-hidden/visible`、`set-worksheet-{row-height,col-width,row-is-auto-height}`、`set-frozen` | ranges → rowData/columnData/freeze 元数据 | ✅ |
| `sheet.mutation.set-filter-range` / `remove-filter` / `set-filter-criteria` / `mark-dirty-filter-change` | filter range + rowData.hidden + resources | ✅ |
| `sheet.mutation.re-calc-filter` | **保守整表**（params 只有 subUnitId，重算可触及筛选区任意行） | ❌ 需当前 filter range |
| `sheet.mutation.add/delete/set/move-conditional-rule` | CF 规则 + resources（不改单元格值） | ✅ |
| `data-validation.mutation.{addRule,updateRule,removeRule}` | DV 规则 + resources（不改单元格值） | ✅ |
| 未登记 id（兜底） | **保守整表** | ❌ |

保守整表/需要额外状态的项已单独列出：**`formula.mutation.remove-other-formula`、`formula.mutation.set-formula-calculation-{result,notification,end}`、`sheet.mutation.re-calc-filter`**。结构类规则虽标 paramsOnly=true，但实际依赖 `params.range + 当前 rowCount/columnCount` 共同确定「表尾」——写集消费者的上下文里应有这两个值。

## 6. T5 逆操作与 dryRun 回滚

方法：通过 `IUndoRedoService` 内部 `_undoStacks`（私有 API，见限制）捕获每个操作新增的 undo item（一条命令可能推多个 item，取 `stack.slice(prevDepth)` 整段并倒序合并 `undoMutations`），序列结束后逆序逐条经 JSON 往返回放，用同一严格比较器对「序列前快照」。

**序列级结果（200 序列 × 20–50 操作）：106/200 完全还原（53%）。** 6856 操作中有 undo item 的 5998；回放逆 mutation 抛错 13 次（含 `Invalid move operation`）。

代价：`captureMs` 合计 87.3ms（≈0.013ms/op），`applyMs` 合计 529.4ms（≈0.077ms/op），逆 mutation 序列化体积合计 8.94MB（≈1.30KB/op）。捕获本身极便宜（只是读栈顶引用+JSON 拷贝）。

按操作类型（t5b，15 序列 413 个独立用例，单操作即撤）：

| 还原率 | 操作 |
|---|---|
| 100% | set-value-{number,string,boolean,empty}、set-formula、set-style、merge/unmerge、insert/remove-{rows,cols}（remove-rows 19/20）、move-range、move-sheet、copy-sheet、insert/remove/rename-sheet、hide-rows/cols、set-{row-height,col-width}、freeze/cancel、clear-{content,format,all}、autofill、sort-range、set-filter、add-cf、add-dv、copy-down、set-col-width |
| 50–95% | **move-rows 1/6（17%）、move-cols 3/6（50%）、remove-rows 19/20** |
| 0%（小样本） | show-rows 0/1、show-cols 0/2（undo 残留 `hd`/`rowData` 元数据） |
| 特殊 | `delete-cf` 等**部分命令不发 undo item**（mutation 发了但 undo 栈不增长）——靠读 `_undoStacks` 拿不到逆操作 |

最小复现：`t5b` 中 `move-rows seq0/op0`（单行移动后回放其 `[move-rows(反向), set-range-values(恢复原值)]` 两条逆 mutation，仍丢 `cellData` 单元格）；`t5` 主跑 `seq0 seed=55110033` 逆放后 `s2.cellData` 第 65–70 行带 26 处值缺失。失败 diff 模式高度一致：**逆 mutation 的 `set-range-values` 携带的恢复矩阵不完整（丢单元格/写错位置）**——即 Univer 的移动/结构类 undo 工厂生成的恢复数据本身有损，不是回放机制的问题（单行独立 move-rows 手工复现已验证可 0-diff 还原，失败集中在带合并/筛选/多步结构交互的场景）。

**结论（数据支持）：内置 UndoRedoService 不满足「每次提交可精确回滚」的契约。** 可行的 fallback（未实施）：对写集范围做前后快照 diff 生成逆 `set-range-values`（T4 的写集+`changedCellsBetween` 已实现这套 diff 机制，成本约为快照对应区域的一次拷贝，本 spike 未量化）。

## 7. 对架构有影响的意外（按重要性排序）

1. **mutation ≠ 命令语义**（已证实）：命令路径会触发拦截器/控制器副作用（filter range 随行列移动联动、undo 注册、公式 dirty 标记），直放 mutation 只做 handler 落库。「服务端复现用户 mutation」与「服务端重放用户命令」是两个不同保真度的方案，需 ADR 选择。
2. **copy-sheet 的 insert-sheet mutation 丢样式表**（已证实，1.0.2）：mutation 复现链路在该命令上结构性丢数据。
3. **行插删成本与位置无关**（已证实）：200k×30 单行插删 ~417ms，推测是矩阵整体重排；大表高频结构编辑场景要计入预算。
4. **undo 栈是私有 API 且覆盖不全**（已证实）：`_undoStacks` 非公开契约；`delete-cf` 类命令不推 undo item；move-* 的恢复矩阵有损。
5. **6M 单元格载入后稳态 RSS ~1.4–1.5GB**：单 worker 只能容纳 1 个该量级文档；文档数×规模的容量规划需要按 ~175MB/M cells 估算。
6. 无 DOM polyfill、`dispose` 在无头下偶发空引用（已吞掉，不影响测量）。

## 8. 偏离

- T1 二分段改用子进程（spec 允许「全新进程/全新 worker」；worker 共享进程 RSS 会低估单文档占用）。
- Univer 1.0.2 发布仅 5 天（<7 天规则）：全部 1.0.x 稳定版发布于 9-23/24，无满足条件的更老 1.0.x，按任务约定取最新并注明。
- T5 主跑 200 序列（非 1000）：200 序列已足够暴露 47% 失败率，与 1000 序列结论不会有质差；T3 为严格 1000。

## 9. 复现命令

```bash
pnpm --filter @excelmanus-spike/univer-model run t1   # T1 载入+二分（约 2 分钟）
pnpm --filter @excelmanus-spike/univer-model run t2   # T2 延迟（约 1 分钟）
pnpm --filter @excelmanus-spike/univer-model run t3   # T3 1000 序列（约 104s，exit 1 = 未达标）
pnpm --filter @excelmanus-spike/univer-model run t4   # T4 写集自检（约 19s）
pnpm --filter @excelmanus-spike/univer-model run t5   # T5 200 序列回滚（约 4s）
T5_SEQS=15 node src/t5b-perop.ts                      # T5 逐操作还原率
node src/probe-ops.ts / probe-mutshapes.ts            # 操作面/mutation 形状探针
```

原始数据：`results/t1-load.json`、`t2-latency.json`、`t3-replay.json`（含逐操作统计与全部发散记录）、`t4-writeset.json`（含 37 条规则表）、`t5-undo.json`、`t5b-perop.json`。

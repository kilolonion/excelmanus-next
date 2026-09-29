# M0-A2 Spike 报告：Univer 公式引擎无头计算

> 结论先行：**函数覆盖达标，增量重算性能不达标**。常用 150 函数 150/150 正确（与 LibreOffice 三方对照无语义分歧）；但 5 万行 × 10 列公式修改一个输入后重算 **p50 ≈ 7.1 s**（门槛 500 ms，超 14 倍），根因是引擎每轮计算都对**全部公式**重新生成依赖树，耗时与公式总数线性相关、与实际受影响单元格数无关。重算期间 JS 线程被整段占用（事件循环最长停顿 ≈ 7–9 s）。

## 0. 摘要表

| 验证项（07 §12） | 通过标准 | 实测 | 判定 |
|---|---|---|---|
| 常用 150 函数覆盖 | ≥ 95% | **150/150**（快照载入路径与命令写入路径各一遍） | **通过** |
| 错误值用例 | — | 4 例中 3 例正确；`=Data!A1+Missing!A1` 返回 `#NAME?`（Excel 为 `#REF!`） | 已知差异 |
| 不支持函数可检测 | — | 56 个候选函数中 50 个已注册；未注册 6 个：`PIVOTBY INFO GETPIVOTDATA WEBSERVICE STOCKHISTORY CUBEVALUE`；引擎自带 lexer 抽取函数名比正则基线更准（正则漏 `MAP` 类裸名） | 可用 |
| 中文场景 | — | 中文表名（含引号/不含）、中文定义名、中文字符串函数全部正确；**中文函数名 `=求和()` → `#NAME?`**（zh-CN locale 下也不接受本地化函数名） | 见 §3 |
| 5 万行 × 10 列，改一个输入的增量重算 | ≤ 500 ms | **p50 7,120 ms / p95 7,248 ms**（n=20，结果逐格校验 0 失败） | **未通过** |
| 同上，全局参数（影响全部 50 万公式） | 无硬指标 | p50 17,356 ms | 参考 |
| 同上，只影响汇总公式 | 无硬指标 | p50 7,133 ms（与单输入相同） | 参考 |
| 快照载入后首次全量计算 | 无硬指标 | ≈ 18 s，峰值 RSS 1.8–2.3 GB | 参考 |
| 命令返回延迟（不等计算） | — | p50 < 1 ms，max 2 ms | 参考 |

环境：Apple M4 / 16 GB / macOS arm64；Node v24.1.0；`@univerjs/* 1.0.2` 精确锁定（与 A1 相同）；LibreOffice 26.2.1.2 作对照。

## 1. 函数覆盖（`src/run-cases.ts` → `results/cases.json`）

- 用例：`cases.json` 150 个函数（数学/统计/文本/逻辑/查找/日期/财务/信息/数组），每个带期望值与类型（`num`/`numRange`/`str`/`bool`/`err`）。
- **判定器修正（本轮）**：Univer 把布尔计算结果存为 `t=3`（BOOLEAN）+ `v∈{0,1}`，显示为 `TRUE/FALSE`（`getDisplayValue` 实测）。原判定器只认 `v===true`，把 16 个逻辑/信息函数误判为失败。修正后按 `t===3` 解释 0/1，16 例全部通过。这是**判定器 bug，不是引擎错误**；已核对 16 例的实际值全部等于期望布尔值的 0/1 表示。
- LibreOffice 三方对照（`src/lo-compare.ts` → `results/lo/three-way.json`）：150 行中 32 行 LO 值与 Univer 值字面不同，逐条归因均非语义分歧：随机/时间函数 3（`RAND RANDBETWEEN NOW`，值域均正确）、LO 15 位有效数字 vs JS 17 位 10（`STDEV STDEV.S VAR VAR.S PI PMT FV PV NPV IRR`）、布尔 0/1 表示 16、LO 不支持 `UNIQUE`/`SEQUENCE` 2（Univer 正确）、错误值表示方式 1（`NA`：LO 值为空、显示 `#N/A`；Univer 为 `"#N/A"`）。
- **对产品的含义（数据）**：写 xlsx 时布尔公式结果必须按 `t=3` 输出 `<c t="b">`，不能当数值写；`workbook_read` 报告公式计算值时同样按 `t` 解释。

## 2. 增量重算性能（`src/recalc-bench.ts` → `results/recalc.json`）

### 2.1 测量有效性修正（本轮）

原 `recalc.json` 的 p1（全量首次计算 ≈ 160 ms）**无效**，已另存为 `results/recalc-invalid-timer-overflow.json` 留作记录。原因：等待函数的"无新会话判空闲"定时器传入 `Number.MAX_SAFE_INTEGER`，超过 `setTimeout` 32 位上限，Node 将其改为 1 ms（运行时有 `TimeoutOverflowWarning`），于是在计算尚未开始时就判"空闲"返回。`src/prof-load.ts` 证实：旧写法下载入后 `computedD=0`（没有一个公式有值）；改为 `2e9` 后 5 万行 `computedD=50000`，抽样值与参考实现一致。p2–p5 在同一 bug 下仍有效（它们的等待以"出现新会话"为准，实测 `outcome=done` 且逐格校验通过），修正后重跑数值与旧值一致（p2 旧 6,921 / 新 7,120 ms）。

### 2.2 重跑结果（修正后，p5 采样 20 次）

| 阶段 | 内容 | calc p50 | p95 | max |
|---|---|---|---|---|
| p1 | 载入含 50 万公式快照 → 全量计算完成 | ≈ 18,200 ms（5 次 17.7–18.8 s） | — | RSS 1.8–2.3 GB |
| p2 | A25000 改值 → 同行 C..L + N1 汇总 | **7,120** | 7,248 | 8,321 |
| p3 | O1（被全部 C 列引用）改值 | 17,356 | 17,620 | 17,620 |
| p4 | L1 改常量 → 只影响 N1 | 7,133 | 7,255 | 7,255 |
| p5 | A 列随机行改值 | 6,811 | 6,900 | 6,943 |

p2 每次写后逐格对照 JS 参考实现（C..L 与 N1）：**0 失败**——结果正确，只是慢。

### 2.3 根因（`src/prof-*.ts` → `results/diag/scaling.jsonl`）

缩放实验：同一次单输入修改，改变行数与公式形态（每组 3 次，取稳态）：

| 形态 | 5k 行 | 10k 行 | 20k 行 |
|---|---|---|---|
| full（10 列公式 + `$O$1` + 汇总） | 660–710 ms | 1,340–1,376 | 2,731–2,775 |
| noAbsNoAgg（去掉绝对引用与汇总） | 632–638 | 1,232–1,316 | 2,571–2,588 |
| single（每行只 1 条公式） | 46–53 | 133–145 | 256–274 |
| 共享公式 `si`（10 列，10k / 50k） | 712–752（10k） | — | 3,549–3,618（50k） |

- 耗时与**公式总数**线性（≈ 0.13 ms/公式），与依赖形态无关：去掉 `$O$1` 与汇总公式后几乎不变，而受影响单元格只有同一行 10 个。
- 共享公式（`si`）只快约 2 倍，不改变线性。
- CPU profile（10k 行 noAbsNoAgg）：热点为 `BaseReferenceObject`/`_defineProperty`/`BaseAstNode`/`LexerNode`/`_parse`/`FormulaDependencyTree` 构造——即**重新解析公式与构建依赖树**，不是函数求值。
- 源码依据（`@univerjs/engine-formula@1.0.2 lib/es/index.js`）：`FormulaDependencyGenerator.generate()` 每轮调用 `_generateTreeList(formulaData, …)`，对 `formulaData` 中**全部**公式执行 `_registerFormulas → _createFDtree`、`_getTreeNode`（AST）、`_getRangeListByNode`；AST 有 LRU 缓存 `FORMULA_AST_CACHE`，但容量只有 **5,000** 条（`FORMULA_CACHE_LRU_COUNT$1 = 5e3`），5 万行 × 10 列场景下缓存必然全部失效。增量体现在"只求值脏树"，但依赖树生成本身是全量的。
- 阻塞（`src/prof-block.ts`）：重算过程中 10 ms 间隔定时器在 7 s 内只触发 2 次，**事件循环最长停顿 6,940 ms**。命令本身仍 < 1 ms 返回（先入队），但同线程上的其他工作（读请求、同步通道推送）会被挡住。

### 2.4 未验证 / 推测

- 调大 `FORMULA_AST_CACHE` 容量能否显著缩短：它是模块级常量，不能通过配置修改，本 spike 未 patch 验证（**推测**只能省掉解析部分，依赖树与区间索引重建仍是全量）。
- `UniverSheetsNodeCorePreset({ workerSrc })` 可把公式引擎放到 rpc-node worker（`notExecuteFormula` 主侧）。它能解决**阻塞**，不能解决**耗时**；未测。

## 3. 中文场景（`src/zh-scenarios.ts` → `results/zh.json`）

| 场景 | 结果 |
|---|---|
| `=销售数据!A1*2`、`='销售数据'!A1+1` | 正确 |
| 中文定义名 `=销售数据!A1*税率` | 正确 |
| `=LEN("你好，世界")` | 5，正确 |
| zh-CN locale 下 `=SUM(...)` | 正确 |
| zh-CN locale 下 `=求和(...)` | `#NAME?`——引擎不接受本地化函数名 |

对产品的含义（数据）：xlsx 中函数名本来就以英文存储，影响只在"用户/模型直接键入中文函数名"；可在输入层提示或拒绝，不影响文件保真。

## 4. 偏离

- p5 按原脚本设计只采样 20 次（门禁描述为 1 万次写入）：单次 ≈ 7 s，1 万次不可行；分布已稳定（p50/p95 差 < 2%）。
- 修正的两个测量缺陷（布尔判定、定时器溢出）见 §1、§2.1；修正前的无效数据保留在 `results/recalc-invalid-timer-overflow.json`。

## 5. 复现

```bash
cd spikes/univer-formula
node src/run-cases.ts                         # 150 函数 → results/cases.json
node src/unsupported.ts                       # → results/unsupported.json
node src/zh-scenarios.ts                      # → results/zh.json
node src/lo-compare.ts                        # 需 soffice → results/lo/
A2_WRITES=20 node --expose-gc src/recalc-bench.ts   # ≈ 10 min → results/recalc.json
ROWS=10000 VARIANT=full node src/prof-scale.ts      # 缩放（VARIANT: full|noAbs|noAgg|noAbsNoAgg|single）
ROWS=50000 node src/prof-si.ts                      # 共享公式
ROWS=50000 node src/prof-block.ts                   # 事件循环阻塞
ROWS=50000 node src/prof-load.ts                    # 载入后公式是否已计算
```

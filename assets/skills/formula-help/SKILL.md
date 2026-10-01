---
name: formula-help
description: 公式编写、解释与排错。用户问"这个公式什么意思""怎么写公式""为什么显示 #REF!/#N/A"时使用。
requires-tools: [workbook_read, workbook_edit]
file-patterns: ["*.xlsx", "*.xlsm"]
user-invocable: true
model-invocable: true
version: 1.0.0
---

# 公式帮助

## 解释公式
- 先用 `workbook_read` 读取单元格的公式与缓存值，再按从内到外的顺序用中文解释，每个引用说明指向的数据含义。
- 指出潜在问题：相对/绝对引用是否正确、区域是否会随新增行遗漏、是否依赖易变函数。

## 编写公式
1. 确认输入区域、输出位置和期望结果，先在一个单元格写并验证结果，再填充整列。
2. 优先使用兼容 Excel 与 WPS 的函数：查找用 XLOOKUP（需要兼容旧版时用 INDEX+MATCH）；条件汇总用 SUMIFS/COUNTIFS。
3. 引用整列会影响性能，使用明确的数据区域。
4. 写入后读回缓存值确认计算结果合理。

## 排错
| 错误 | 常见原因 |
| --- | --- |
| `#REF!` | 引用的行列或工作表被删除 |
| `#N/A` | 查找值不存在，或两边格式不一致（文本与数字） |
| `#VALUE!` | 参与运算的单元格是文本 |
| `#DIV/0!` | 除数为 0 或空 |
| `#NAME?` | 函数名拼错，或使用了当前软件不支持的函数 |

用 `workbook_analyze` 的 check（formula_errors）可以一次找出所有错误单元格。修复前先说明原因。

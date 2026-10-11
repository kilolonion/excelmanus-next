// 40 个独立任务；全部为合成输入，固定输出口径，不能把资源校验当成模型成绩。
import { type CellCheck, type SkillEvalCase, skillEvalCases } from "../skill-evals/cases.ts";

function task(
  id: string,
  skill: string,
  files: Record<string, string>,
  instruction: string,
  rows: (string | number)[][],
  manual: string,
  formulas: string[] = [],
): SkillEvalCase {
  const cells: CellCheck[] = rows.flatMap((row, r) =>
    row.map((value, c) => ({
      ref: `Result!${String.fromCharCode(65 + c)}${r + 1}`,
      value,
      ...(formulas.includes(`${String.fromCharCode(65 + c)}${r + 1}`) ? { formula: true } : {}),
    })),
  );
  return {
    id,
    skill,
    files,
    prompt: `${instruction} 保留所有源文件。输出 result.xlsx 的 Result 表，从 A1 起按指定列和顺序写入，含表头，不增加其他数据行。完成后回读核验并报告口径。`,
    outputs: [{ path: "result.xlsx", cells }],
    manual: [manual, "检查额外行/列、数据类型、来源和最终说明；自动断言不代替人工复核。"],
  };
}

const additional: SkillEvalCase[] = [
  task(
    "csv-quoted-fields",
    "data-cleaning",
    { "quoted.csv": '编号,备注,金额\n001,"含逗号,保留",10\n002,"第一行\n第二行",20\n' },
    "正确解析带引号的 CSV，保留逗号和嵌入换行，编号保留文本，列编号/备注/金额。",
    [
      ["编号", "备注", "金额"],
      ["001", "含逗号,保留", 10],
      ["002", "第一行\n第二行", 20],
    ],
    "不能按逗号或换行简单切割字段",
  ),
  task(
    "month-status-filter",
    "report-building",
    {
      "orders.csv":
        "日期,状态,金额\n2026-01-01,完成,100\n2026-01-31,完成,200\n2026-02-01,完成,900\n2026-01-20,取消,50\n",
    },
    "只汇总 2026 年 1 月已完成订单，列为月份/金额/条数。",
    [
      ["月份", "金额", "条数"],
      ["2026-01", 300, 2],
    ],
    "月份边界与取消订单都被正确排除",
  ),
  task(
    "signed-refunds",
    "report-building",
    { "sales.csv": "地区,金额\n东,100\n东,-20\n西,50\n西,-60\n" },
    "负金额是退款，不取绝对值。按东、西汇总，列为地区/净额，末行合计。",
    [
      ["地区", "净额"],
      ["东", 80],
      ["西", -10],
      ["合计", 70],
    ],
    "保留退款符号",
  ),
  task(
    "two-key-group",
    "report-building",
    { "sales.csv": "地区,产品,金额\n东,A,10\n东,B,20\n西,A,30\n东,A,5\n" },
    "按地区和产品两个键汇总，顺序东A、东B、西A，列地区/产品/金额。",
    [
      ["地区", "产品", "金额"],
      ["东", "A", 15],
      ["东", "B", 20],
      ["西", "A", 30],
    ],
    "没有仅按一个键合并",
  ),
  task(
    "weighted-price",
    "report-building",
    { "sales.csv": "产品,数量,单价\nA,1,10\nA,9,20\nB,2,30\n" },
    "按 A、B 输出产品/数量/销售额/加权均价，均价为销售额除数量，不是单价的简单平均。",
    [
      ["产品", "数量", "销售额", "加权均价"],
      ["A", 10, 190, 19],
      ["B", 2, 60, 30],
    ],
    "权重与计量单位正确",
  ),
  task(
    "zero-base-growth",
    "report-building",
    { "months.csv": "项目,上期,本期\nA,100,120\nB,0,30\nC,20,0\n" },
    "输出项目/增长率，增长率为(本期-上期)/上期，数值形式不乘100；分母为0时写文本不可比。按 A、B、C。",
    [
      ["项目", "增长率"],
      ["A", 0.2],
      ["B", "不可比"],
      ["C", -1],
    ],
    "零基期未编造百分比",
  ),
  task(
    "running-balance",
    "report-building",
    { "cash.csv": "日期,收支\n2026-01-03,-10\n2026-01-01,100\n2026-01-02,-30\n" },
    "期初余额50，按日期升序输出日期/收支/余额，日期保留 ISO 文本。",
    [
      ["日期", "收支", "余额"],
      ["2026-01-01", 100, 150],
      ["2026-01-02", -30, 120],
      ["2026-01-03", -10, 110],
    ],
    "先排序再累计，期初只加一次",
  ),
  task(
    "trim-values",
    "data-cleaning",
    { "names.csv": "姓名,部门\n 张三 , 销售 \n李 四,研发\n" },
    "只去除字段首尾空格，保留内部空格，列姓名/部门。",
    [
      ["姓名", "部门"],
      ["张三", "销售"],
      ["李 四", "研发"],
    ],
    "不删除内部空格",
  ),
  task(
    "casefold-email",
    "data-cleaning",
    { "users.csv": "邮箱,姓名\nA@EXAMPLE.COM,甲\na@example.com,乙\nb@example.com,丙\n" },
    "邮箱转小写后按邮箱去重，保留首次出现行，列邮箱/姓名。",
    [
      ["邮箱", "姓名"],
      ["a@example.com", "甲"],
      ["b@example.com", "丙"],
    ],
    "去重规则明确，未随机选行",
  ),
  task(
    "long-identifiers",
    "data-cleaning",
    { "ids.csv": "身份证明编码\n001234567890123456\n123456789012345678\n" },
    "所有编码是标识而非数值，逐行原样保存为文本，列身份证明编码。",
    [["身份证明编码"], ["001234567890123456"], ["123456789012345678"]],
    "未科学计数法或丢失长整数精度",
  ),
  task(
    "missing-versus-zero",
    "data-cleaning",
    { "values.csv": "项目,值\nA,0\nB,\nC,5\n" },
    "列项目/值/状态；空值的值列写文本缺失，状态待补；真实0保留数值，非空状态正常。",
    [
      ["项目", "值", "状态"],
      ["A", 0, "正常"],
      ["B", "缺失", "待补"],
      ["C", 5, "正常"],
    ],
    "0 与缺失没有混为一类",
  ),
  task(
    "normalize-units",
    "data-cleaning",
    { "weights.csv": "项目,重量,单位\nA,1.5,kg\nB,500,g\nC,2,kg\n" },
    "统一为克，列项目/重量g，顺序 A、B、C。",
    [
      ["项目", "重量g"],
      ["A", 1500],
      ["B", 500],
      ["C", 2000],
    ],
    "单位转换没有二次乘1000",
  ),
  task(
    "ambiguous-date",
    "data-cleaning",
    { "dates.csv": "编号,日期\nA,01/02/2026\nB,2026-02-03\n" },
    "没有地区约定的斜线日期不猜测日月顺序。列编号/日期/状态，原日期保留文本，歧义行状态待确认，ISO 日期状态正常。",
    [
      ["编号", "日期", "状态"],
      ["A", "01/02/2026", "待确认"],
      ["B", "2026-02-03", "正常"],
    ],
    "没有把歧义日期自动解释成美式或欧式",
  ),
  task(
    "quote-price-diff",
    "reconciliation",
    { "old.csv": "SKU,价格\nA,10\nB,20\n", "new.csv": "SKU,价格\nA,12\nC,30\n" },
    "全外连接比较报价，列SKU/旧价/新价/差额/类别，按A、B、C；缺失用文本缺失，对应差额写不可比。差额为新减旧，类别变价、删除、新增。",
    [
      ["SKU", "旧价", "新价", "差额", "类别"],
      ["A", 10, 12, 2, "变价"],
      ["B", 20, "缺失", "不可比", "删除"],
      ["C", "缺失", 30, "不可比", "新增"],
    ],
    "缺失没有当成真实0报价",
  ),
  task(
    "composite-key-join",
    "reconciliation",
    {
      "plan.csv": "订单,行号,数量\nO1,1,2\nO1,2,3\n",
      "actual.csv": "订单,行号,数量\nO1,2,2\nO1,1,2\n",
    },
    "按订单+行号匹配，按行号升序，列订单/行号/计划/实际/差额，差额实际减计划。",
    [
      ["订单", "行号", "计划", "实际", "差额"],
      ["O1", 1, 2, 2, 0],
      ["O1", 2, 3, 2, -1],
    ],
    "不会只按订单造成连接膨胀",
  ),
  task(
    "reconcile-tolerance",
    "reconciliation",
    { "check.csv": "编号,账面,实际\nA,100,100.004\nB,100,100.02\nC,50,49.999\n" },
    "绝对差额≤0.01为匹配，输出编号/状态，按 A、B、C。",
    [
      ["编号", "状态"],
      ["A", "匹配"],
      ["B", "不匹配"],
      ["C", "匹配"],
    ],
    "容差按绝对金额而非百分比",
  ),
  task(
    "inventory-equation",
    "reconciliation",
    { "stock.csv": "SKU,期初,入库,出库,实盘\nA,10,5,8,7\nB,20,0,3,16\n" },
    "计算理论期末=期初+入库-出库，列SKU/理论期末/实盘/盘差，盘差实盘减理论。",
    [
      ["SKU", "理论期末", "实盘", "盘差"],
      ["A", 7, 7, 0],
      ["B", 17, 16, -1],
    ],
    "方向和库存恒等式正确",
  ),
  task(
    "lookup-missing-key",
    "reconciliation",
    { "staff.csv": "工号,姓名\n01,甲\n02,乙\n", "dept.csv": "工号,部门\n01,财务\n03,技术\n" },
    "以 staff 为左表，按工号关联部门，列工号/姓名/部门，缺失写未登记，工号保留文本。",
    [
      ["工号", "姓名", "部门"],
      ["01", "甲", "财务"],
      ["02", "乙", "未登记"],
    ],
    "左表未丢行且没有加入仅右表人员",
  ),
  task(
    "formula-sumif",
    "formula-help",
    { "data.csv": "地区,金额\n东,10\n西,20\n东,30\n" },
    "Result 的 A1:B4 保留源数据，D1=地区,E1=金额,D2=东,E2 用 SUMIF 公式汇总东。",
    [
      ["地区", "金额"],
      ["东", 10],
      ["西", 20],
      ["东", 30],
    ],
    "E2 必须是 SUMIF，范围正确",
  ),
  task(
    "formula-countif",
    "formula-help",
    { "data.csv": "状态\n完成\n待办\n完成\n" },
    "A1:A4 保留源列，B1=完成数，B2 写 COUNTIF 公式计算完成数。",
    [["状态", "完成数"], ["完成", 2], ["待办"], ["完成"]],
    "计数公式不包含标题",
    ["B2"],
  ),
  task(
    "formula-iferror",
    "formula-help",
    { "data.csv": "分子,分母\n10,2\n10,0\n" },
    "A1:B3 保留数据，C1=商，C2:C3 用 IFERROR 包裹除法，除零显示文本不可算。",
    [
      ["分子", "分母", "商"],
      [10, 2, 5],
      [10, 0, "不可算"],
    ],
    "除零不是默认为0",
    ["C2", "C3"],
  ),
  task(
    "formula-round",
    "formula-help",
    { "data.csv": "数量,单价\n3,1.235\n2,2.344\n" },
    "A1:B3 保留数据，C1=金额，C2:C3 用 ROUND(数量*单价,2) 公式。",
    [
      ["数量", "单价", "金额"],
      [3, 1.235, 3.71],
      [2, 2.344, 4.69],
    ],
    "先乘再四舍五入，不先圆整单价",
    ["C2", "C3"],
  ),
  task(
    "formula-running-sum",
    "formula-help",
    { "data.csv": "金额\n10\n-3\n5\n" },
    "A1:A4 保留源数据，B1=累计，B2:B4 写可下拉填充的 SUM 固定首格至当前行公式。",
    [
      ["金额", "累计"],
      [10, 10],
      [-3, 7],
      [5, 12],
    ],
    "首格绝对引用，末格相对引用",
    ["B2", "B3", "B4"],
  ),
  task(
    "formula-conditional",
    "formula-help",
    { "data.csv": "成绩\n59\n60\n100\n" },
    "A1:A4 保留源数据，B1=判定，B2:B4 写 IF 公式，成绩≥60 为合格，否则不合格。",
    [
      ["成绩", "判定"],
      [59, "不合格"],
      [60, "合格"],
      [100, "合格"],
    ],
    "60 边界包含在合格内",
    ["B2", "B3", "B4"],
  ),
  task(
    "analysis-median",
    "report-building",
    { "data.csv": "值\n1\n2\n3\n100\n" },
    "输出指标/值两列，依次为计数、均值、中位数。",
    [
      ["指标", "值"],
      ["计数", 4],
      ["均值", 26.5],
      ["中位数", 2.5],
    ],
    "偶数中位数与均值区分",
  ),
  task(
    "analysis-population-variance",
    "report-building",
    { "data.csv": "值\n1\n2\n3\n" },
    "输出指标/值两列，依次为均值、总体方差，明确分母为 N，不使用样本方差。",
    [
      ["指标", "值"],
      ["均值", 2],
      ["总体方差", 2 / 3],
    ],
    "方差口径明确",
  ),
  task(
    "analysis-outlier-rule",
    "data-cleaning",
    { "data.csv": "编号,值\nA,10\nB,100\nC,101\nD,-1\n" },
    "不删除数据。列编号/值/状态，值闭区间[0,100]为正常，否则异常，保持源顺序。",
    [
      ["编号", "值", "状态"],
      ["A", 10, "正常"],
      ["B", 100, "正常"],
      ["C", 101, "异常"],
      ["D", -1, "异常"],
    ],
    "上下界含端点且未擅自删除异常",
  ),
  task(
    "native-column-chart",
    "report-building",
    { "data.csv": "地区,金额\n东,100\n西,200\n" },
    "A1:B3 保留源数据，在 Result 创建一张原生柱状图，引用 A1:B3，标题地区销售，不能用图片代替。",
    [
      ["地区", "金额"],
      ["东", 100],
      ["西", 200],
    ],
    "检查图表类型、标题、系列范围与实际 Excel 打开结果",
  ),
  task(
    "batch-twelve-total",
    "batch-files",
    Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `branch-${i + 1}.csv`,
        `分公司,金额\nB${i + 1},${(i + 1) * 10}\n`,
      ]),
    ),
    "汇总12个 branch-N.csv，列分公司/金额，按 B1 至 B12 的数字顺序，末行为合计。可自行选择并行方式。",
    [
      ["分公司", "金额"],
      ...Array.from({ length: 12 }, (_, i) => [`B${i + 1}`, (i + 1) * 10]),
      ["合计", 780],
    ],
    "12个输入都有完成记录，不遗漏或词典序误排",
  ),
  task(
    "batch-header-alias",
    "batch-files",
    { "a.csv": "品名,金额\nA,10\n", "b.csv": "产品名称,销售额\nB,20\n" },
    "两份文件的品名与产品名称同义、金额与销售额同单位，合并为产品/金额，按A、B顺序。",
    [
      ["产品", "金额"],
      ["A", 10],
      ["B", 20],
    ],
    "按声明映射表头，不按错误列号拼接",
  ),
  task(
    "batch-empty-input",
    "batch-files",
    { "a.csv": "项目,金额\nA,10\n", "empty.csv": "项目,金额\n", "c.csv": "项目,金额\nC,30\n" },
    "三个文件合并为项目/金额，保持a、empty、c文件顺序；空文件只有表头不算明细。末行合计。",
    [
      ["项目", "金额"],
      ["A", 10],
      ["C", 30],
      ["合计", 40],
    ],
    "空文件有状态报告，没有虚构数据行",
  ),
  task(
    "style-percent-values",
    "sheet-styling",
    { "data.csv": "项目,比率\nA,0.125\nB,1\n" },
    "A1:B3 保留数据，比率底层仍是0.125和1；比率列显示百分比一位小数；表头加粗。",
    [
      ["项目", "比率"],
      ["A", 0.125],
      ["B", 1],
    ],
    "检查显示12.5%和100.0%，不是改为12.5和100",
  ),
  task(
    "style-negative-currency",
    "sheet-styling",
    { "data.csv": "项目,金额\n收入,1234.5\n退款,-20\n" },
    "A1:B3 原样保留数据，金额列千分位两位小数，负数保持负号；表头加粗。",
    [
      ["项目", "金额"],
      ["收入", 1234.5],
      ["退款", -20],
    ],
    "格式不改变正负号与数值",
  ),
];

// Formula/format/object checks supplement every expected data cell.
const sumif = additional.find((c) => c.id === "formula-sumif");
sumif?.outputs[0]?.cells.push(
  { ref: "Result!D1", value: "地区" },
  { ref: "Result!E1", value: "金额" },
  { ref: "Result!D2", value: "东" },
  { ref: "Result!E2", value: 40, formula: true },
);
for (const c of additional.filter((c) => c.id.startsWith("style-"))) {
  c.outputs[0]?.cells.push({ ref: "Result!A1", styled: true }, { ref: "Result!B2", styled: true });
}
const chart = additional.find((c) => c.id === "native-column-chart");
if (chart?.outputs[0]) chart.outputs[0].nativeCharts = 1;
export const v1EvalCases: SkillEvalCase[] = [...skillEvalCases, ...additional];

export interface CellCheck {
  ref: string;
  value?: string | number;
  formula?: boolean;
  styled?: boolean;
}
export interface SkillEvalCase {
  id: string;
  skill: string;
  files: Record<string, string>;
  image?: string;
  prompt: string;
  outputs: { path: string; cells: CellCheck[] }[];
  manual: string[];
}

export const skillEvalCases: SkillEvalCase[] = [
  {
    id: "report-subtotal",
    skill: "report-building",
    files: {
      "sales.csv": "地区,类型,金额\n华东,明细,100\n华东,明细,200\n华东,小计,300\n华南,明细,50\n",
    },
    prompt:
      "制作地区销售汇总报表，只汇总类型为明细的行，金额单位元。不要修改 sales.csv。输出 result.xlsx 的 Report 表：A1:B1 为地区/金额，A2:A3 为华东、华南，B2:B3 为对应明细金额汇总，第 4 行写合计。请独立核验并说明口径。",
    outputs: [
      {
        path: "result.xlsx",
        cells: [
          { ref: "Report!A2", value: "华东" },
          { ref: "Report!B2", value: 300 },
          { ref: "Report!B3", value: 50 },
          { ref: "Report!B4", value: 350 },
        ],
      },
    ],
    manual: ["是否解释排除小计；是否独立核验源明细；没有未经请求增加新口径"],
  },
  {
    id: "clean-identifiers",
    skill: "data-cleaning",
    files: {
      "dirty.csv":
        '编码,金额,日期\n0012,"1,200.00",2026-02-01\n0012,"1,200.00",2026-02-01\n0013,50,2026-02-30\n',
    },
    prompt:
      "清洗 dirty.csv：只删除完全重复的行，编码保留文本和前导零，金额采用英文千分位转数值，无效日期保留原文本并在状态列写待确认。输出 result.xlsx 的 Clean 表，列为编码/金额/日期/状态，按原顺序输出处理后的行；有效日期保留 ISO 日期文本，状态写正常。原 CSV 不改。报告删除与失败转换条数。",
    outputs: [
      {
        path: "result.xlsx",
        cells: [
          { ref: "Clean!A2", value: "0012" },
          { ref: "Clean!B2", value: 1200 },
          { ref: "Clean!A3", value: "0013" },
          { ref: "Clean!B3", value: 50 },
          { ref: "Clean!C3", value: "2026-02-30" },
          { ref: "Clean!D3", value: "待确认" },
        ],
      },
    ],
    manual: ["是否区分编码和度量；删除一行完全重复；无效日期未被猜测修正"],
  },
  {
    id: "reconcile-one-to-many",
    skill: "reconciliation",
    files: {
      "invoices.csv": "单号,金额\nI01,300\nI02,200\n",
      "payments.csv": "单号,金额\nI01,100\nI01,200\nI03,50\n",
    },
    prompt:
      "核对 invoices.csv 与 payments.csv，按单号累计金额核对；容差 0，方向为发票减付款。保留原文件。生成 result.xlsx 的 Diff 表，列为单号/发票金额/付款金额/差额/类别。按 I01、I02、I03 顺序，缺失金额以 0 展示，类别分别为匹配、仅发票、仅付款。第 5 行 A5 写合计，B5:D5 为三列合计。请解释一对多的处理和总差额。",
    outputs: [
      {
        path: "result.xlsx",
        cells: [
          { ref: "Diff!B2", value: 300 },
          { ref: "Diff!C2", value: 300 },
          { ref: "Diff!D2", value: 0 },
          { ref: "Diff!D3", value: 200 },
          { ref: "Diff!D4", value: -50 },
          { ref: "Diff!B5", value: 500 },
          { ref: "Diff!C5", value: 350 },
          { ref: "Diff!D5", value: 150 },
        ],
      },
    ],
    manual: ["是否先汇总付款；未产生连接膨胀；是否说明缺失展示为零仅用于该报告"],
  },
  {
    id: "formula-fill",
    skill: "formula-help",
    files: { "prices.csv": "产品,数量,单价\n甲,2,10\n乙,3,20\n" },
    prompt:
      "基于 prices.csv 生成 result.xlsx 的 Calc 表，A1:C3 保留源数据，F1 放税率 0.1。D1 写含税金额，D2:D3 写数量乘单价乘(1+F1)的可填充公式，F1 固定引用。验证首末行计算结果，原 CSV 不改。",
    outputs: [
      {
        path: "result.xlsx",
        cells: [
          { ref: "Calc!F1", value: 0.1 },
          { ref: "Calc!D2", value: 22, formula: true },
          { ref: "Calc!D3", value: 66, formula: true },
        ],
      },
    ],
    manual: ["F1 是否固定引用；是否实际核验计算值而非只写公式；缓存缺失时说明未验证"],
  },
  {
    id: "style-readability",
    skill: "sheet-styling",
    files: {
      "layout.csv": "客户代码,金额,备注\n0012,1200,需要换行阅读的长备注\n0013,50,普通备注\n",
    },
    prompt:
      "将 layout.csv 输出为 result.xlsx 的 Layout 表，不改源文件。A1:C3 保留全部内容、编码文本和金额数值；优化阅读布局，表头加粗，金额千分位两位小数，备注换行，列宽合理。单纯美化不改变数据。说明视觉核验是否可用。",
    outputs: [
      {
        path: "result.xlsx",
        cells: [
          { ref: "Layout!A1", value: "客户代码", styled: true },
          { ref: "Layout!A2", value: "0012" },
          { ref: "Layout!B2", value: 1200, styled: true },
          { ref: "Layout!B3", value: 50 },
        ],
      },
    ],
    manual: ["检查金额数字格式、备注换行、列宽和实际可读性；没有视觉证据时未声称截图通过"],
  },
  {
    id: "batch-same-name",
    skill: "batch-files",
    files: {
      "north/sales.csv": "项目,金额\nA,100\nB,200\n",
      "south/sales.csv": "项目,金额\nC,50\n",
    },
    prompt:
      "批量处理 north/sales.csv 和 south/sales.csv，分别在 output/north.xlsx、output/south.xlsx 的 Summary 表中写 A1=总额、B1=源行数，A2/B2 为对应金额合计和明细条数。保留原输入，核验并报告每个输入的状态。不要将同名输入覆盖为一个结果。处理方式自行选择。",
    outputs: [
      {
        path: "output/north.xlsx",
        cells: [
          { ref: "Summary!A2", value: 300 },
          { ref: "Summary!B2", value: 2 },
        ],
      },
      {
        path: "output/south.xlsx",
        cells: [
          { ref: "Summary!A2", value: 50 },
          { ref: "Summary!B2", value: 1 },
        ],
      },
    ],
    manual: ["两个输入均有状态与核验；没有为了两个文件强制团队；输出未覆盖"],
  },
  {
    id: "image-table",
    skill: "image-to-sheet",
    files: {},
    image: "image-source.png",
    prompt:
      "把附件表格转为 result.xlsx 的 Extracted 表，A1:B4 保留原图表头和三行内容。代码保留文本前导零，金额写数值，独立校验合计，并渲染结果与原图对照。保持标题单位 CNY；不得把合计当明细再次累加。",
    outputs: [
      {
        path: "result.xlsx",
        cells: [
          { ref: "Extracted!A1", value: "Code" },
          { ref: "Extracted!B1", value: "Amount" },
          { ref: "Extracted!A2", value: "0012" },
          { ref: "Extracted!B2", value: 12.5 },
          { ref: "Extracted!A3", value: "0013" },
          { ref: "Extracted!B3", value: 7.25 },
          { ref: "Extracted!A4", value: "Total" },
          { ref: "Extracted!B4", value: 19.75 },
        ],
      },
    ],
    manual: ["需真实视觉模型与渲染端；实际对照列数/行数/单位；不能只凭单元格断言证明视觉质量"],
  },
];

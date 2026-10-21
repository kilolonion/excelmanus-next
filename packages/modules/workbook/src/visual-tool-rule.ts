import { FileOperationError } from "@excelmanus/kernel";

/** Agent fields compiled to the same native rules used by the UI and XLSX codec. */
export function visualToolRule(op: {
  kind: string;
  values?: number[];
  colors?: string[];
  fill?: string;
}) {
  const colors = op.colors ?? ["#F8696B", "#FFEB84", "#63BE7B"];
  const count = op.kind === "dataBar" ? 2 : colors.length;
  if (
    op.values &&
    (op.values.length !== count || op.values.some((v, i) => i > 0 && v <= op.values![i - 1]!))
  )
    throw new FileOperationError(
      "INVALID_ARGUMENT",
      `视觉规则 values 需要 ${count} 个递增阈值，与颜色/数据条端点对应`,
    );
  if (op.kind === "dataBar" && op.colors)
    throw new FileOperationError(
      "INVALID_ARGUMENT",
      "dataBar 颜色请用 fill，colors 仅用于 colorScale",
    );
  const values =
    op.values?.map((value) => ({ type: "num", value })) ??
    (count === 2
      ? [{ type: "min" }, { type: "max" }]
      : [{ type: "min" }, { type: "percentile", value: 50 }, { type: "max" }]);
  if (op.kind === "dataBar") {
    const color = op.fill ?? "#4472C4";
    return {
      type: "dataBar",
      isShowValue: true,
      config: {
        min: values[0],
        max: values[1],
        isGradient: true,
        positiveColor: color,
        nativeColor: color,
      },
    };
  }
  return {
    type: "colorScale",
    config: colors.map((color, index) => ({ index, color, value: values[index] })),
  };
}

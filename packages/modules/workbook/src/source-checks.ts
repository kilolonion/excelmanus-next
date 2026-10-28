import { parseRange } from "@excelmanus/core";
import {
  SourceCheckDeclaration,
  type SourceCheckFinding,
  type SourceCheckLocation,
  type SourceCheckResult,
} from "@excelmanus/protocol";

export interface SheetDomain {
  id: string;
  path: string;
  sheet: string;
  range: string;
  headerRows: number[];
  blankPolicy?: "all_cells_blank" | "none";
  rows: { worksheetRow: number; cells: unknown[] }[];
  columnNames: string[];
  complete: boolean;
}

type Value = string | number | boolean | null;
type Row = { worksheetRow: number; cells: Value[] };
type ResolvedDomain = {
  domain: SheetDomain;
  rows: Row[];
  columns: Map<string, number>;
};
type CoverageCheck = Extract<SourceCheckDeclaration, { kind: "row_coverage" }>;
type LookupCheck = Extract<SourceCheckDeclaration, { kind: "typed_lookup" }>;
type AggregateCheck = Extract<SourceCheckDeclaration, { kind: "typed_aggregate" }>;
type Origin = { source: ResolvedDomain; row: Row };
const same = (left: Value, right: Value) => typeof left === typeof right && left === right;
const tuple = (values: Value[]) => JSON.stringify(values.map((value) => [typeof value, value]));
const location = (domain: SheetDomain, row?: number, column?: string): SourceCheckLocation => ({
  domainId: domain.id,
  path: domain.path,
  sheet: domain.sheet,
  ...(row === undefined ? {} : { worksheetRow: row }),
  ...(column === undefined ? {} : { column }),
});

class CannotVerify extends Error {
  readonly code: string;
  readonly location: SourceCheckLocation | undefined;
  constructor(code: string, message: string, location?: SourceCheckLocation) {
    super(message);
    this.code = code;
    this.location = location;
  }
}

class CheckContext {
  private work = 0;
  private cells = 0;
  private cellEvidence = new Map<string, { domainId: string; column: string; rows: Set<number> }>();
  readonly result: SourceCheckResult;
  constructor(result: SourceCheckResult) {
    this.result = result;
  }
  tick(count = 1) {
    this.work += count;
    if (this.work > 500000)
      throw new CannotVerify("WORK_BUDGET_EXCEEDED", "声明检查超出工作预算，不能据此声称通过。");
  }
  add(finding: SourceCheckFinding, unverified = false) {
    if (unverified) this.result.unverifiedCount++;
    else this.result.failedCount++;
    if (this.result.findings.length < 100) this.result.findings.push(finding);
  }
  cover(domain: SheetDomain, column: string, rows: Iterable<number>) {
    const key = JSON.stringify([domain.id, column]);
    let entry = this.cellEvidence.get(key);
    if (!entry) {
      entry = { domainId: domain.id, column, rows: new Set<number>() };
      this.cellEvidence.set(key, entry);
    }
    for (const row of rows) entry.rows.add(row);
  }
  resolve(id: string, domains: SheetDomain[]): ResolvedDomain {
    const matches = domains.filter((domain) => domain.id === id);
    if (matches.length !== 1)
      throw new CannotVerify("DOMAIN_MISSING_OR_AMBIGUOUS", "声明域不存在或标识不唯一。");
    const domain = matches[0]!;
    const where = location(domain);
    if (!domain.complete)
      throw new CannotVerify("DOMAIN_INCOMPLETE", "声明域未完整读取，不能缩小检查分母。", where);
    let range: ReturnType<typeof parseRange>;
    try {
      range = parseRange(domain.range);
    } catch {
      throw new CannotVerify("DOMAIN_RANGE_INVALID", "声明域范围不是可解析的矩形。", where);
    }
    const width = range.endCol - range.startCol + 1;
    const height = range.endRow - range.startRow + 1;
    if (
      (range.sheet !== undefined && range.sheet !== domain.sheet) ||
      !domain.path ||
      !domain.sheet ||
      domain.columnNames.length !== width ||
      domain.rows.length !== height
    )
      throw new CannotVerify(
        "DOMAIN_PHYSICAL_COVERAGE_INCOMPLETE",
        "范围、工作表、列宽或物理行总数不一致。",
        where,
      );
    this.cells += width * height;
    if (this.cells > 200000)
      throw new CannotVerify("CELL_BUDGET_EXCEEDED", "声明域超过单次检查的单元格预算。", where);
    if (domain.headerRows.length !== 1)
      throw new CannotVerify(
        "HEADER_LAYOUT_UNSUPPORTED",
        "按列名检查目前要求唯一的真实表头行。",
        where,
      );
    const physicalRows = new Set<number>();
    for (const row of domain.rows) {
      this.tick(width + 1);
      if (
        !Number.isSafeInteger(row.worksheetRow) ||
        row.worksheetRow < range.startRow ||
        row.worksheetRow > range.endRow ||
        physicalRows.has(row.worksheetRow) ||
        row.cells.length !== width
      )
        throw new CannotVerify(
          "DOMAIN_PHYSICAL_COVERAGE_INCOMPLETE",
          "缺失、重复、越界或不完整的物理行不能作为完整来源。",
          where,
        );
      physicalRows.add(row.worksheetRow);
      for (const value of row.cells)
        if (
          value !== null &&
          typeof value !== "string" &&
          typeof value !== "boolean" &&
          !(typeof value === "number" && Number.isFinite(value))
        )
          throw new CannotVerify(
            "VALUE_TYPE_UNSUPPORTED",
            "存在未解析值或不支持的值类型；未进行隐式转换。",
            location(domain, row.worksheetRow),
          );
    }
    const header = domain.rows.find((row) => row.worksheetRow === domain.headerRows[0]);
    if (
      !header ||
      header.cells.some(
        (cell, index) =>
          typeof cell !== "string" || cell.length === 0 || cell !== domain.columnNames[index],
      ) ||
      new Set(domain.columnNames).size !== width
    )
      throw new CannotVerify(
        "HEADER_MISSING_DUPLICATE_OR_RENAMED",
        "列名必须对应唯一真实表头，不接受推测或改名后的列元数据。",
        where,
      );
    if (
      domain.blankPolicy !== undefined &&
      domain.blankPolicy !== "none" &&
      domain.blankPolicy !== "all_cells_blank"
    )
      throw new CannotVerify("BLANK_POLICY_UNSUPPORTED", "空行规则未获支持。", where);
    const rows = (domain.rows as Row[]).filter(
      (row) =>
        row.worksheetRow !== domain.headerRows[0] &&
        !(domain.blankPolicy === "all_cells_blank" && row.cells.every((cell) => cell === null)),
    );
    if (!this.result.coveredDomains.includes(id)) this.result.coveredDomains.push(id);
    return {
      domain,
      rows,
      columns: new Map(domain.columnNames.map((name, index) => [name, index])),
    };
  }
  finish() {
    this.result.status = this.result.failedCount
      ? "failed"
      : this.result.unverifiedCount
        ? "unverified"
        : "passed";
    this.result.findingsTruncated =
      this.result.failedCount + this.result.unverifiedCount > this.result.findings.length;
    this.result.coveredCells =
      this.result.status === "passed"
        ? [...this.cellEvidence.values()]
            .filter((entry) => entry.rows.size > 0)
            .map((entry) => ({
              domainId: entry.domainId,
              column: entry.column,
              worksheetRows: [...entry.rows].sort((a, b) => a - b),
            }))
        : [];
    return this.result;
  }
}

function column(domain: ResolvedDomain, name: string) {
  const index = domain.columns.get(name);
  if (index === undefined)
    throw new CannotVerify(
      "COLUMN_MISSING",
      "声明列不存在于真实表头中。",
      location(domain.domain, undefined, name),
    );
  return index;
}
function uncovered(context: CheckContext, domain: ResolvedDomain, covered: string[]) {
  const names = new Set(covered);
  context.result.uncoveredFields = domain.domain.columnNames
    .filter((name) => !names.has(name))
    .map((name) => `${domain.domain.id}.${name}`);
}

function rowCoverage(
  check: CoverageCheck,
  sources: SheetDomain[],
  outputs: SheetDomain[],
  context: CheckContext,
  allPhysicalRows = false,
) {
  const raw = check.sourceIds.map((id) => context.resolve(id, sources));
  const target = context.resolve(check.target, outputs);
  if (
    allPhysicalRows &&
    [...raw, target].some((item) => item.domain.blankPolicy === "all_cells_blank")
  )
    throw new CannotVerify(
      "EVENT_SCOPE_BLANK_POLICY_UNSUPPORTED",
      "事件来源分区要求保留全部物理数据行。",
    );
  const lineage = check.lineage;
  const referenceColumn = column(target, lineage.sourceReferenceColumn);
  const rowColumn = column(target, lineage.sourceRowColumn);
  const sheetColumn =
    lineage.sourceSheetColumn === undefined ? undefined : column(target, lineage.sourceSheetColumn);
  const periodColumn =
    check.expansion === undefined ? undefined : column(target, check.expansion.targetPeriodColumn);
  const periods = check.expansion?.periods ?? [null];
  const targetAnchors = lineage.anchors.map((anchor) => column(target, anchor.targetColumn));
  const sourceAnchors = new Map(
    raw.map((source) => [
      source.domain.id,
      lineage.anchors.map((anchor) =>
        anchor.sourceId === undefined || anchor.sourceId === source.domain.id
          ? column(source, anchor.sourceColumn)
          : undefined,
      ),
    ]),
  );
  uncovered(context, target, [
    lineage.sourceReferenceColumn,
    lineage.sourceRowColumn,
    ...(lineage.sourceSheetColumn ? [lineage.sourceSheetColumn] : []),
    ...lineage.anchors.map((anchor) => anchor.targetColumn),
    ...(check.expansion ? [check.expansion.targetPeriodColumn] : []),
  ]);

  const origins = new Map<number, Origin>();
  const byReference = new Map<string, Origin[]>();
  const expected = new Map<string, { origin: Origin; period: Value; count: number }>();
  const physical = new Set<string>();
  let overlapping = false;
  for (const source of raw) {
    const reference = lineage.sourceReference === "path" ? source.domain.path : source.domain.id;
    for (const row of source.rows) {
      const origin = { source, row };
      const refKey = tuple([reference, row.worksheetRow]);
      const existing = byReference.get(refKey) ?? [];
      existing.push(origin);
      byReference.set(refKey, existing);
      const physicalKey = tuple([source.domain.path, source.domain.sheet, row.worksheetRow]);
      if (physical.has(physicalKey)) overlapping = true;
      physical.add(physicalKey);
      for (const period of periods) {
        context.tick();
        if (expected.size >= 200000)
          throw new CannotVerify("EXPANSION_BUDGET_EXCEEDED", "行与期间展开超出检查预算。");
        expected.set(tuple([source.domain.id, row.worksheetRow, period]), {
          origin,
          period,
          count: 0,
        });
      }
    }
  }
  if (overlapping)
    throw new CannotVerify(
      "SOURCE_DOMAIN_OVERLAP",
      "多个来源域包含同一物理来源行，不能把别名重复计入原始行集合。",
    );

  for (const row of target.rows) {
    context.tick();
    const at = location(target.domain, row.worksheetRow);
    const reference = row.cells[referenceColumn]!;
    const sourceRow = row.cells[rowColumn]!;
    const sheet = sheetColumn === undefined ? undefined : row.cells[sheetColumn];
    const period = periodColumn === undefined ? null : row.cells[periodColumn]!;
    if (
      typeof reference !== "string" ||
      typeof sourceRow !== "number" ||
      !Number.isSafeInteger(sourceRow) ||
      sourceRow < 1 ||
      (sheetColumn !== undefined && typeof sheet !== "string")
    ) {
      context.add({
        code: "LINEAGE_INVALID",
        message: "来源路径、工作表或物理行号的值类型不正确。",
        location: at,
        actual: { reference, sheet, sourceRow },
      });
      continue;
    }
    const candidates = (byReference.get(tuple([reference, sourceRow])) ?? []).filter(
      (origin) => sheet === undefined || origin.source.domain.sheet === sheet,
    );
    if (candidates.length !== 1) {
      context.add({
        code: candidates.length > 1 ? "LINEAGE_AMBIGUOUS" : "LINEAGE_OUT_OF_UNIVERSE",
        message:
          candidates.length > 1
            ? "来源引用对应多个原始物理行域。"
            : "来源引用不在声明的原始物理行集合内。",
        location: at,
        actual: { reference, sheet, sourceRow },
      });
      continue;
    }
    const origin = candidates[0]!;
    const entry = expected.get(tuple([origin.source.domain.id, sourceRow, period]));
    if (!entry) {
      context.add({
        code: "LINEAGE_OUT_OF_UNIVERSE",
        message: "该来源行与期间组合不在声明的展开集合内。",
        location: at,
        actual: period,
      });
      continue;
    }
    entry.count++;
    origins.set(row.worksheetRow, origin);
    if (entry.count > 1)
      context.add({
        code: "LINEAGE_DUPLICATE",
        message: "同一来源物理行与期间被重复输出。",
        location: at,
        sourceLocation: location(origin.source.domain, sourceRow),
        actual: entry.count,
        expected: 1,
      });
    for (const [index, anchor] of lineage.anchors.entries()) {
      if (anchor.sourceId !== undefined && anchor.sourceId !== origin.source.domain.id) continue;
      context.tick();
      const actual = row.cells[targetAnchors[index]!]!;
      const value = origin.row.cells[sourceAnchors.get(origin.source.domain.id)![index]!]!;
      if (!same(actual, value))
        context.add({
          code: "LINEAGE_ANCHOR_MISMATCH",
          message: "来源锚点值或类型不一致。",
          location: location(target.domain, row.worksheetRow, anchor.targetColumn),
          sourceLocation: location(origin.source.domain, sourceRow, anchor.sourceColumn),
          actual,
          expected: value,
        });
      else context.cover(target.domain, anchor.targetColumn, [row.worksheetRow]);
    }
  }
  for (const entry of expected.values())
    if (!entry.count)
      context.add({
        code: "LINEAGE_MISSING",
        message: "原始来源行或其声明期间没有对应输出行。",
        sourceLocation: location(entry.origin.source.domain, entry.origin.row.worksheetRow),
        expected: check.expansion ? { count: 1, period: entry.period } : 1,
        actual: 0,
      });
  for (const name of [
    lineage.sourceReferenceColumn,
    lineage.sourceRowColumn,
    ...(lineage.sourceSheetColumn ? [lineage.sourceSheetColumn] : []),
    ...(check.expansion ? [check.expansion.targetPeriodColumn] : []),
  ])
    context.cover(
      target.domain,
      name,
      target.rows.map((row) => row.worksheetRow),
    );
  return origins;
}

function typedLookup(
  check: LookupCheck,
  sources: SheetDomain[],
  outputs: SheetDomain[],
  context: CheckContext,
) {
  let selectedOrigins: Map<number, Origin> | undefined;
  if (check.eventScope) {
    const scope = check.eventScope;
    selectedOrigins = rowCoverage(
      {
        kind: "row_coverage",
        obligationId: check.obligationId,
        requirement: check.requirement,
        purpose: check.purpose,
        sourceIds: scope.universeSourceIds,
        target: check.target,
        lineage: {
          ...scope.lineage,
          anchors: scope.sourceIds.flatMap((sourceId) =>
            scope.keys.map((key) => ({ ...key, sourceId })),
          ),
        },
      },
      sources,
      outputs,
      context,
      true,
    );
    if (context.result.failedCount || context.result.unverifiedCount) return;
  }
  const source = context.resolve(check.dictionary, sources);
  const target = context.resolve(check.target, outputs);
  const sourceKeys = check.keys.map((key) => column(source, key.sourceColumn));
  const targetKeys = check.keys.map((key) => column(target, key.targetColumn));
  const selectedSourceIds = new Set(check.eventScope?.sourceIds);
  const targetRows = check.eventScope
    ? target.rows.filter((row) =>
        selectedSourceIds.has(selectedOrigins!.get(row.worksheetRow)!.source.domain.id),
      )
    : target.rows;
  const sourceValues = check.values.map((value) => column(source, value.sourceColumn));
  const targetValues = check.values.map((value) => column(target, value.targetColumn));
  const duplicates = check.duplicateColumns.map((name) => column(source, name));
  const eligibility = check.eligibility.map((condition) => ({
    column: column(source, condition.column),
    equals: condition.equals,
  }));
  if (check.duplicatePolicy === "equivalent_rows") {
    const covered = new Set(check.duplicateColumns);
    if (
      [
        ...check.keys.map((key) => key.sourceColumn),
        ...check.values.map((value) => value.sourceColumn),
        ...check.eligibility.map((condition) => condition.column),
      ].some((name) => !covered.has(name))
    )
      throw new CannotVerify(
        "DUPLICATE_COLUMNS_INCOMPLETE",
        "重复等价列必须覆盖键、返回值及主表资格字段。",
        location(source.domain),
      );
  }
  uncovered(
    context,
    target,
    check.values.map((value) => value.targetColumn),
  );
  const eligible = (row: Row) =>
    eligibility.every((condition) => same(row.cells[condition.column]!, condition.equals));
  const groups = new Map<string, Row[]>();
  for (const row of source.rows) {
    context.tick(sourceKeys.length + eligibility.length + 1);
    if (check.order === "filter_then_classify" && !eligible(row)) continue;
    const key = tuple(sourceKeys.map((index) => row.cells[index]!));
    const rows = groups.get(key) ?? [];
    rows.push(row);
    groups.set(key, rows);
  }
  const relation = new Map<string, { conflict: boolean; rows: Row[]; eligibleRows: Row[] }>();
  for (const [key, rows] of groups) {
    const signatures = new Set<string>();
    for (const row of rows) {
      context.tick(duplicates.length + eligibility.length + 1);
      signatures.add(tuple(duplicates.map((index) => row.cells[index]!)));
    }
    relation.set(key, {
      conflict: rows.length > 1 && (check.duplicatePolicy === "reject" || signatures.size !== 1),
      rows,
      eligibleRows: rows.filter(eligible),
    });
  }
  for (const row of targetRows) {
    context.tick(targetKeys.length + targetValues.length + 1);
    const keys = targetKeys.map((index) => row.cells[index]!);
    const blankKey = keys.some((key) => key === null || key === "");
    const entry = relation.get(tuple(keys));
    let policy: "expect_blank" | "unverified" | undefined;
    let reason = "";
    if (blankKey && check.blankKeyPolicy !== "match") {
      policy = check.blankKeyPolicy;
      reason = "LOOKUP_BLANK_KEY";
    } else if (entry?.conflict) {
      policy = check.conflictPolicy;
      reason = "LOOKUP_CONFLICT";
    } else if (!entry?.eligibleRows.length) {
      policy = check.missingPolicy;
      reason = entry ? "LOOKUP_INELIGIBLE" : "LOOKUP_MISSING";
    }
    if (policy === "unverified") {
      context.add(
        {
          code: reason,
          message: "按声明策略，该键的身份值无法核验。",
          location: location(target.domain, row.worksheetRow),
          actual: keys,
        },
        true,
      );
      continue;
    }
    // A representative is used only after explicit duplicate equivalence and eligibility checks.
    const matched = policy === undefined ? entry!.eligibleRows[0]! : undefined;
    for (const [index, value] of check.values.entries()) {
      const actual = row.cells[targetValues[index]!]!;
      const expected = matched ? matched.cells[sourceValues[index]!]! : check.blankValue;
      if (!same(actual, expected))
        context.add({
          code: "LOOKUP_VALUE_MISMATCH",
          message: "目标身份值与原始字典的类型化关系结果不一致。",
          location: location(target.domain, row.worksheetRow, value.targetColumn),
          ...(matched
            ? {
                sourceLocation: location(source.domain, matched.worksheetRow, value.sourceColumn),
              }
            : {}),
          actual,
          expected,
        });
    }
  }
  const targetKeyNames = new Set(check.keys.map((key) => key.targetColumn));
  for (const value of check.values)
    if (!targetKeyNames.has(value.targetColumn) || check.eventScope)
      context.cover(
        target.domain,
        value.targetColumn,
        targetRows.map((row) => row.worksheetRow),
      );
}

function typedAggregate(
  check: AggregateCheck,
  sources: SheetDomain[],
  outputs: SheetDomain[],
  context: CheckContext,
) {
  const source = context.resolve(check.sourceId, sources);
  const target = context.resolve(check.target, outputs);
  if (outputs.some((output) => output.path === source.domain.path))
    throw new CannotVerify(
      "AGGREGATE_SOURCE_IS_OUTPUT",
      "聚合来源必须是独立原始域，不能引用自身或生成的输出文件。",
      location(source.domain),
    );
  if (
    source.domain.blankPolicy === "all_cells_blank" ||
    target.domain.blankPolicy === "all_cells_blank"
  )
    throw new CannotVerify(
      "AGGREGATE_BLANK_POLICY_UNSUPPORTED",
      "聚合检查要求保留全部物理数据行；只能用显式来源谓词筛选。",
    );
  const groupColumns = check.groupBy.map((field) => column(source, field.sourceColumn));
  const targetFields = [...check.groupBy, ...check.metrics].map((field) => field.targetColumn);
  const targetColumns = targetFields.map((field) => column(target, field));
  if (new Set(targetColumns).size !== targetColumns.length)
    throw new CannotVerify(
      "AGGREGATE_TARGET_ALIAS",
      "多个聚合字段不能覆盖同一物理输出列。",
      location(target.domain),
    );
  const predicates = check.filter.map((predicate) => ({
    predicate,
    index: column(source, predicate.column),
  }));
  const metrics = check.metrics.map((metric) => ({
    metric,
    index: metric.op === "count_rows" ? undefined : column(source, metric.sourceColumn),
  }));
  type State = { count: number; sum: bigint; extreme: number | null };
  type Group = { keys: Value[]; states: State[] };
  const groups = new Map<string, Group>();
  const groupFor = (keys: Value[]): Group => {
    const key = tuple(keys);
    let group = groups.get(key);
    if (!group) {
      group = { keys, states: metrics.map(() => ({ count: 0, sum: 0n, extreme: null })) };
      groups.set(key, group);
    }
    return group;
  };
  if (!groupColumns.length) groupFor([]);
  for (const row of source.rows) {
    context.tick(predicates.length + groupColumns.length + metrics.length + 1);
    let selected = true;
    // Evaluate every predicate, even when another is false: AND order cannot hide invalid types.
    for (const { predicate, index } of predicates) {
      const actual = row.cells[index]!;
      let matches: boolean;
      if (predicate.op === "eq" || predicate.op === "ne") {
        const equal = same(actual, predicate.value);
        matches = predicate.op === "eq" ? equal : !equal;
      } else if (actual === null) matches = false;
      else {
        if (typeof actual !== "number" || typeof predicate.value !== "number")
          throw new CannotVerify(
            "AGGREGATE_FILTER_TYPE_UNSUPPORTED",
            "有序聚合筛选仅支持有限数值，不隐式转换文本或布尔值。",
            location(source.domain, row.worksheetRow, predicate.column),
          );
        matches =
          predicate.op === "lt"
            ? actual < predicate.value
            : predicate.op === "lte"
              ? actual <= predicate.value
              : predicate.op === "gt"
                ? actual > predicate.value
                : actual >= predicate.value;
      }
      selected = selected && matches;
    }
    if (!selected) continue;
    const group = groupFor(groupColumns.map((index) => row.cells[index]!));
    for (const [index, { metric, index: sourceColumn }] of metrics.entries()) {
      const state = group.states[index]!;
      if (metric.op === "count_rows") {
        state.count++;
        continue;
      }
      const value = row.cells[sourceColumn!]!;
      if (value === null) continue;
      state.count++;
      if (metric.op === "count_non_null") continue;
      if (typeof value !== "number" || (metric.op === "sum" && !Number.isSafeInteger(value)))
        throw new CannotVerify(
          "AGGREGATE_OPERAND_UNSUPPORTED",
          "SUM 仅支持安全整数；MIN/MAX 仅支持有限数值，不能隐式转换或舍入。",
          location(source.domain, row.worksheetRow, metric.sourceColumn),
        );
      if (metric.op === "sum") state.sum += BigInt(value);
      else if (
        state.extreme === null ||
        (metric.op === "min" ? value < state.extreme : value > state.extreme)
      )
        state.extreme = value;
    }
  }
  const expected = new Map<string, { values: Value[]; remaining: number }>();
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  for (const group of groups.values()) {
    context.tick(group.keys.length + metrics.length + 1);
    const values: Value[] = [
      ...group.keys,
      ...metrics.map(({ metric }, index): Value => {
        const state = group.states[index]!;
        if (metric.op === "count_rows" || metric.op === "count_non_null") return state.count;
        if (metric.op === "sum") {
          if (!state.count) return null;
          if (state.sum > max || state.sum < -max)
            throw new CannotVerify(
              "AGGREGATE_SUM_OVERFLOW",
              "精确聚合结果超出安全整数范围，不能舍入后认定通过。",
              location(source.domain),
            );
          return Number(state.sum);
        }
        return state.extreme;
      }),
    ];
    const key = tuple(values);
    const existing = expected.get(key);
    if (existing) existing.remaining++;
    else expected.set(key, { values, remaining: 1 });
  }
  for (const row of target.rows) {
    context.tick(targetColumns.length + 1);
    const values = targetColumns.map((index) => row.cells[index]!);
    const entry = expected.get(tuple(values));
    if (entry && entry.remaining > 0) entry.remaining--;
    else
      context.add({
        code: "AGGREGATE_UNEXPECTED_ROW",
        message: "输出聚合行的类型化字段值不符、额外出现或重复出现。",
        location: location(target.domain, row.worksheetRow),
        actual: values,
      });
  }
  for (const entry of expected.values())
    for (let i = 0; i < entry.remaining; i++)
      context.add({
        code: "AGGREGATE_MISSING_ROW",
        message: "原始域按声明方法计算的聚合行未在输出中出现。",
        sourceLocation: location(source.domain),
        expected: entry.values,
      });
  if (!context.result.failedCount && !context.result.unverifiedCount) {
    context.result.coveredFields = targetFields.map((field) => `${target.domain.id}.${field}`);
    for (const field of targetFields)
      context.cover(
        target.domain,
        field,
        target.rows.map((row) => row.worksheetRow),
      );
    uncovered(context, target, targetFields);
  }
}

export function runSourceChecks(input: {
  checks: SourceCheckDeclaration[];
  sources: SheetDomain[];
  outputs: SheetDomain[];
}): SourceCheckResult[] {
  return input.checks.map((declaration) => {
    const outputBound =
      declaration.kind === "row_coverage" ||
      declaration.kind === "typed_lookup" ||
      declaration.kind === "typed_aggregate" ||
      input.outputs.some((domain) => domain.id === declaration.target);
    const result: SourceCheckResult = {
      kind: declaration.kind,
      obligationId: declaration.obligationId,
      requirement: declaration.requirement,
      purpose: outputBound ? "required_output" : declaration.purpose,
      status: "unverified",
      assurance: declaration.kind === "typed_aggregate" ? "declared_expression" : "source_derived",
      findings: [],
      coveredDomains: [],
      ...(declaration.kind === "typed_aggregate" ? { coveredFields: [] } : {}),
      uncoveredFields: [],
      failedCount: 0,
      unverifiedCount: 0,
      findingsTruncated: false,
    };
    const context = new CheckContext(result);
    try {
      const parsed = SourceCheckDeclaration.safeParse(declaration);
      if (!parsed.success)
        throw new CannotVerify("INVALID_DECLARATION", "检查声明不符合受支持的类型化协议。");
      const check = parsed.data;
      if (check.kind === "row_coverage") rowCoverage(check, input.sources, input.outputs, context);
      else if (check.kind === "typed_lookup")
        typedLookup(check, input.sources, input.outputs, context);
      else if (check.kind === "typed_aggregate")
        typedAggregate(check, input.sources, input.outputs, context);
      else {
        result.assurance = "unsupported";
        context.add(
          {
            code: "HOST_ADAPTER_REQUIRED",
            message:
              "该旧版检查必须由宿主按原有模式协议验证并绑定已保存快照；纯来源检查器不执行自定义表达式。",
          },
          true,
        );
      }
    } catch (error) {
      context.add(
        {
          code: error instanceof CannotVerify ? error.code : "CHECK_UNSUPPORTED",
          message:
            error instanceof CannotVerify ? error.message : "检查输入不受支持，不能据此声称通过。",
          ...(error instanceof CannotVerify && error.location ? { location: error.location } : {}),
        },
        true,
      );
    }
    const finished = context.finish();
    if (finished.status !== "passed") {
      finished.coveredDomains = [];
      if (declaration.kind === "typed_aggregate") finished.coveredFields = [];
      const targets = input.outputs.filter((domain) => domain.id === declaration.target);
      finished.uncoveredFields =
        targets.length === 1
          ? targets[0]!.columnNames.map((field) => `${declaration.target}.${field}`)
          : [];
    } else if (["row_coverage", "typed_lookup", "typed_aggregate"].includes(declaration.kind)) {
      const target = input.outputs.find((domain) => domain.id === declaration.target)!;
      const rows = target.rows
        .filter((row) => !target.headerRows.includes(row.worksheetRow))
        .map((row) => row.worksheetRow);
      finished.uncoveredFields = target.columnNames
        .filter((field) => {
          const evidence = finished.coveredCells?.find(
            (entry) => entry.domainId === target.id && entry.column === field,
          );
          const proved = new Set(evidence?.worksheetRows);
          return !evidence || rows.some((row) => !proved.has(row));
        })
        .map((field) => `${target.id}.${field}`);
    }
    return finished;
  });
}

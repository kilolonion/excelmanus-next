// ContextItem[] → AI SDK ModelMessage[] 转换。AI SDK 类型只出现在 gateway 目录内。

import { type ContextItem, numericEvidence } from "@excelmanus/protocol";
import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";

type ImagePart = { type: "file"; data: { type: "data"; data: string }; mediaType: string };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function candidateTable(evidence: NonNullable<ReturnType<typeof numericEvidence>>) {
  return {
    shown: evidence.candidates.shown, total: evidence.candidates.total,
    truncated: evidence.candidates.truncated,
    columns: ["refId", "pointer", "valueType", "fieldName", "fieldPointer", "column"],
    rows: evidence.candidates.items.map(candidate => [
      candidate.refId, candidate.pointer, candidate.valueType, candidate.field.name,
      candidate.field.pointer === candidate.pointer ? null : candidate.field.pointer,
      candidate.column ?? null,
    ]),
  };
}

/** Only the describe receipt is projected; original host schema/data remain untouched. */
function compactCheckDescription(item: Extract<ContextItem, {kind: "toolResult"}>, output: Record<string, unknown>) {
  const data = record(output.data), schema = record(data?.verificationSchema);
  if (item.toolName !== "workbook_check" || data?.action !== "describe" || !schema) return output;
  const scoped = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(scoped);
    const object = record(value);
    return !!object && (Object.keys(object).some(key =>
      ["$ref", "$defs", "definitions", "$id", "$anchor", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"].includes(key)) ||
      Object.values(object).some(scoped));
  };
  if (scoped(schema)) return output;
  // Traverse schema positions, never const/enum/default data or a properties-map as a schema.
  const children = (node: Record<string, unknown>, visit: (node: Record<string, unknown>) => Record<string, unknown>) => {
    const next = {...node};
    for (const key of ["properties", "patternProperties", "dependentSchemas"]) {
      const map = record(node[key]);
      if (map) next[key] = Object.fromEntries(Object.entries(map).map(([name, child]) =>
        [name, record(child) ? visit(record(child)!) : child]));
    }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      const array = node[key];
      if (Array.isArray(array)) next[key] = array.map(child => record(child) ? visit(record(child)!) : child);
    }
    for (const key of ["items", "additionalProperties", "unevaluatedProperties", "contains", "not", "if", "then", "else", "propertyNames"]) {
      const child = node[key];
      if (record(child)) next[key] = visit(record(child)!);
      else if (key === "items" && Array.isArray(child)) next[key] = child.map(value => record(value) ? visit(record(value)!) : value);
    }
    return next;
  };
  const counts = new Map<string, number>();
  const count = (node: Record<string, unknown>): Record<string, unknown> => {
    const key = JSON.stringify(node);
    if (Buffer.byteLength(key, "utf8") >= 120) counts.set(key, (counts.get(key) ?? 0) + 1);
    children(node, count);
    return node;
  };
  children(schema, count);
  const names = new Map<string, string>();
  const definitions: Record<string, unknown> = {};
  const replace = (node: Record<string, unknown>): Record<string, unknown> => {
    const key = JSON.stringify(node);
    if ((counts.get(key) ?? 0) > 1) {
      let name = names.get(key);
      if (!name) {
        name = "v" + names.size;
        names.set(key, name);
        definitions[name] = children(node, replace);
      }
      return {$ref: "#/$defs/" + name};
    }
    return children(node, replace);
  };
  const compact = children(schema, replace);
  if (!names.size) return output;
  const projected = {...output, data: {...data,
    verificationSchema: {...compact, $defs: definitions},
    verificationSchemaGuide: "$ref:#/$defs/名称 引用本 verificationSchema.$defs 的完整子格式；按引用读取，所有字段、必填、约束和说明保持。",
  }};
  return Buffer.byteLength(JSON.stringify(projected), "utf8") < Buffer.byteLength(JSON.stringify(output), "utf8")
    ? projected : output;
}

/** Add copyable references after context truncation, using only this visible receipt.
 * This is guidance, not authority: present still checks visibility and freshness. */
function withNumericEvidence(item: Extract<ContextItem, { kind: "toolResult" }>, deliveryCatalog: boolean): unknown {
  const original = record(item.output);
  if (!original) return item.output;
  // This name belongs to the host. Tool/script-provided lookalikes cannot authorize a reference.
  const { numericEvidence: _untrusted, ...output } = original;
  if (item.isError) return output;
  // A proposal already contains every permission and state. Do not replay the
  // same full permissions three more times in active/pending/denied buckets.
  const contractData = record(output.data);
  if (item.toolName === "contract" && record(contractData?.contract)) {
    const {activePermissions: _active, pendingPermissions: _pending,
      deniedPermissions: _denied, ...data} = contractData!;
    return {...output, data: {...data,
      continuation: "contract.permissions 中每项 state=active 可直接用，needs_confirmation 需 confirm，denied 不可用；不要因无关待确认项停止已授权操作。",
    }};
  }
  const evidence = numericEvidence(item.toolCallId, item.toolName, output);
  if (!evidence) return compactCheckDescription(item, output);
  // Native delivery has an explicit inspect catalog. Keep the actual data and
  // receipt identity visible, rather than auto-expanding a second legacy catalog
  // for every cell on every subsequent model round. No host fact is changed.
  if (deliveryCatalog && ["workbook_read", "workbook_query", "workbook_analyze"].includes(item.toolName)) {
    return {...output, deliveryEvidence: {
      sourceToolCallId: item.toolCallId, toolName: item.toolName,
      scope: evidence.scope,
      catalog: {tool: "deliver", action: "inspect"},
      notice: "此处data为真实工具结果，保留原值/公式/读窗/来源与截断标记。需要交付引用时调用deliver.inspect获取当前完整factSets目录，再finalize选中所需factSetIds；不要自造引用，不以未展示目录声称已核验。",
    }};
  }
  // Wire presentation only: keep every selector, relation, scope and coverage flag.
  // The authoritative result and catalog remain unchanged for host verification.
  if (["workbook_query", "workbook_analyze"].includes(item.toolName) ||
      (item.toolName === "workbook_read" && record(output.data)?.mode === "overview")) {
    return { ...output, numericEvidence: {
      ...evidence,
      format: "candidate-catalog-table-v1",
      candidates: candidateTable(evidence),
      candidateUnitDefault: "未提供",
      tableGuide: "candidates.rows 按 columns 排列。refId 是原始完整引用，不能用行号替代。fieldPointer=null 表示该项 pointer；column=null 表示无 column。unit 统一为 candidateUnitDefault；实际值仍在原始 data 对应 pointer。所有来源、修订、覆盖和截断标记保留。",
    } };
  }
  if (item.toolName === "workbook_read" && record(output.data)?.mode === "range") {
    const refRows = new Map(evidence.candidates.items.map((candidate, index) => [candidate.refId, index]));
    const returnedRanges = [...new Set(evidence.bindingCandidates.items.flatMap(binding =>
      [binding.value.position.returnedRange, binding.label.position.returnedRange]))];
    const compact = {
      ...evidence,
      format: "range-catalog-table-v1",
      candidates: candidateTable(evidence),
      bindingCandidates: {
        shown: evidence.bindingCandidates.shown, total: evidence.bindingCandidates.total,
        truncated: evidence.bindingCandidates.truncated, selection: evidence.bindingCandidates.selection,
        returnedRanges,
        columns: ["bindingId", "valueCandidateRow", "labelCandidateRow", "relation", "unit", "unitSourcePointer",
          "valuePosition", "labelPosition"],
        rows: evidence.bindingCandidates.items.map(binding => [
          binding.bindingId, refRows.get(binding.valueRefId), refRows.get(binding.labelRefId),
          binding.relation, binding.unit.value, binding.unit.sourcePointer ?? null,
          [returnedRanges.indexOf(binding.value.position.returnedRange), binding.value.position.rowOffset, binding.value.position.columnOffset],
          [returnedRanges.indexOf(binding.label.position.returnedRange), binding.label.position.rowOffset, binding.label.position.columnOffset],
        ]),
      },
      tableGuide: "rows 按 columns 排列，行索引从0起。sources/refId、bindings/bindingId 原样复制完整字符串，不提交行索引。fieldPointer=null 表示该项 pointer。binding 的两个 CandidateRow 指向 candidates.rows；实际数值/标签原文在原始data对应pointer处，position=[returnedRanges索引,行偏移,列偏移]。无数据采样或删减。",
      candidateUnitDefault: "未提供",
      notice: "只复制所需 sources，不同时选 root 和子项。bindings 为默认选择；bindingCandidates 为互斥选项，不要把候选全部复制，每个数值最多选择一个；无候选时不得构造。位置为 returnedRange 内0基偏移；标签仅证实同次读回的左邻/首行位置，不认证业务语义；单位仅来自显式标签及 sourcePointer。candidateUnitDefault 不推断单位。服务器仍核验可见性、来源、修订。" +
        (evidence.scope === "visible-subset" ? "当前仅可见子集，不代表完整结果。" : "") +
        (!evidence.sources.length ? "仅有非数值解释候选，不能单独完成数值交付。" : "") +
        (evidence.candidates.truncated ? "候选目录已截断；未展示项须缩小范围重读。" : "") +
        (evidence.bindingCandidates.truncated ? "标签关系已截断；未展示关系须缩小范围重读。" : ""),
    };
    return { ...output, numericEvidence: compact };
  }
  return { ...output, numericEvidence: evidence };
}

export function toModelMessages(
  history: ContextItem[],
  opts: {
    vision?: boolean;
    /** Native deliver.inspect supplies the full current fact-set catalog on demand. */
    deliveryCatalog?: boolean;
    /**
     * Chat 协议的 tool 消息只能是字符串（openai-compatible、moonshotai）：工具结果图片改放在
     * 紧随这批 tool 消息之后的 user 消息里，避免被序列化成 base64 文本（P1-42）。
     */
    toolImagesAsUser?: boolean;
  } = {},
): ModelMessage[] {
  const raw: ModelMessage[] = [];
  let toolImageWireBytes = 0;
  const checkToolImages = (images: { mediaType: string; data: string }[]) => {
    for (const image of images) {
      if (
        !image ||
        typeof image.data !== "string" ||
        typeof image.mediaType !== "string" ||
        !image.mediaType.startsWith("image/")
      )
        throw new Error("工具图片字段无效，图片未发送");
      const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
      if (Math.floor((image.data.length * 3) / 4) - padding > 8 * 1024 * 1024)
        throw new Error("单张工具图片超过8MiB，请缩小截图范围；图片未发送");
      toolImageWireBytes += image.data.length;
      if (toolImageWireBytes > 16 * 1024 * 1024)
        throw new Error(
          "本次请求工具图片编码总量超过16MiB，请压缩已消费历史或缩小截图范围；图片未发送",
        );
    }
  };
  // toolImagesAsUser 时暂存的工具结果图片：遇到下一条非 tool 消息前作为 user 消息发出
  let pendingImages: ImagePart[] = [];
  const flushImages = () => {
    if (pendingImages.length === 0) return;
    raw.push({
      role: "user",
      content: [{ type: "text", text: "（上面工具结果中的图片）" }, ...pendingImages],
    });
    pendingImages = [];
  };
  const out = {
    push(msg: ModelMessage) {
      if (msg.role !== "tool") flushImages();
      raw.push(msg);
    },
  };
  for (const item of history) {
    switch (item.kind) {
      case "user": {
        // 01 §3 / 04 §7：图片附件发给支持视觉的模型；否则（或内容缺失）以文字说明代替
        const images = item.images ?? [];
        const sendable = opts.vision !== true ? [] : images.filter((img) => img.data);
        const skipped = images.length - sendable.length;
        const note =
          skipped > 0
            ? opts.vision !== true
              ? `\n\n（附件图片 ${skipped} 张未发送：${opts.vision === false ? "当前模型不支持图片" : "视觉能力尚未确认，请在模型设置中确认视觉能力或选择支持图片的模型"}）`
              : `\n\n（附件图片 ${skipped} 张已不可用，未发送）`
            : "";
        out.push({
          role: "user",
          content: [
            { type: "text", text: item.text + note },
            ...sendable.map((img) => ({
              type: "image" as const,
              image: img.data as string,
              mediaType: img.mediaType,
            })),
          ],
        });
        break;
      }
      case "assistant": {
        const content: AssistantModelMessage["content"] = [];
        if (item.reasoning != null && item.reasoning.length > 0) {
          content.push({
            type: "reasoning",
            text: item.reasoning,
            providerOptions: item.reasoningProviderOptions as never,
          });
        }
        if (item.text != null && item.text.length > 0) {
          content.push({ type: "text", text: item.text });
        }
        for (const tc of item.toolCalls ?? []) {
          content.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.args,
          });
        }
        // 空输出（无文本/思考/工具调用）不发送：Anthropic 拒绝空 assistant 消息（P1-43）
        if (content.length === 0) break;
        out.push({ role: "assistant", content });
        break;
      }
      case "toolResult": {
        const outputValue = withNumericEvidence(item, opts.deliveryCatalog === true);
        // 06 §2.3：ToolResult.images 作为视觉输入；其余字段仍以 JSON 文本给模型。
        const images =
          outputValue && typeof outputValue === "object"
            ? ((outputValue as { images?: unknown }).images as
                | { mediaType: string; data: string }[]
                | undefined)
            : undefined;
        if (Array.isArray(images) && images.length > 0 && (opts.vision !== true || item.isError)) {
          const { images: _drop, ...rest } = outputValue as Record<string, unknown>;
          out.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: item.toolCallId,
                toolName: item.toolName,
                output: {
                  type: item.isError ? "error-json" : "json",
                  value: {
                    ...rest,
                    note: item.isError
                      ? "工具失败，图片未作为视觉输入发送"
                      : opts.vision === false
                        ? "当前模型不支持视觉，图片未发送"
                        : "视觉能力尚未确认，图片未发送；请在模型设置中确认视觉能力或选择支持图片的模型",
                  } as never,
                },
              },
            ],
          });
          break;
        }
        if (Array.isArray(images) && images.length > 0) checkToolImages(images);
        if (Array.isArray(images) && images.length > 0 && opts.toolImagesAsUser) {
          const { images: _drop, ...rest } = outputValue as Record<string, unknown>;
          out.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: item.toolCallId,
                toolName: item.toolName,
                output: {
                  type: "json",
                  value: { ...rest, note: `图片 ${images.length} 张见下一条消息` } as never,
                },
              },
            ],
          });
          pendingImages.push(
            ...images.map((img) => ({
              type: "file" as const,
              data: { type: "data" as const, data: img.data },
              mediaType: img.mediaType,
            })),
          );
          break;
        }
        if (Array.isArray(images) && images.length > 0) {
          const { images: _drop, ...rest } = outputValue as Record<string, unknown>;
          out.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: item.toolCallId,
                toolName: item.toolName,
                output: {
                  type: "content",
                  value: [
                    { type: "text", text: JSON.stringify(rest) },
                    ...images.map((img) => ({
                      type: "file" as const,
                      mediaType: img.mediaType,
                      data: { type: "data" as const, data: img.data },
                    })),
                  ],
                },
              },
            ],
          });
          break;
        }
        const part: ToolModelMessage["content"][number] = {
          type: "tool-result",
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          output:
            typeof outputValue === "string"
              ? item.isError
                ? { type: "error-text", value: outputValue }
                : { type: "text", value: outputValue }
              : item.isError
                ? { type: "error-json", value: outputValue as never }
                : { type: "json", value: outputValue as never },
        };
        out.push({ role: "tool", content: [part] });
        break;
      }
    }
  }
  flushImages();
  return mergeAdjacentUsers(raw);
}

/** 跳过空 assistant 或插入图片消息后，相邻 user 消息合并为一条（保持角色交替）。 */
function mergeAdjacentUsers(messages: ModelMessage[]): ModelMessage[] {
  const merged: ModelMessage[] = [];
  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (prev?.role === "user" && msg.role === "user") {
      const asParts = (c: typeof msg.content) =>
        typeof c === "string" ? [{ type: "text" as const, text: c }] : c;
      merged[merged.length - 1] = {
        role: "user",
        content: [...asParts(prev.content), ...asParts(msg.content)],
      };
      continue;
    }
    merged.push(msg);
  }
  return merged;
}

// ChatGPT/Codex 订阅薄适配（09 §4.2 方案 3）：协议解析仍由官方 @ai-sdk/openai 的 Responses
// 实现完成；这里只经自定义 fetch 注入订阅令牌与接口约束。约束来源为 openai/codex 开源
// 客户端（2026-10 核实）：端点 chatgpt.com/backend-api/codex/responses，store=false，
// 系统提示放 instructions，必须流式，带 chatgpt-account-id 与 originator 请求头。
// 接口非公开，可能随时变化；失败时由运行时的错误分类给出指引。
import { registerSecret } from "./secrets.ts";

const DROP_FIELDS = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "previous_response_id",
  "metadata",
  "service_tier",
  "truncation",
  "user",
] as const;

interface InputItem {
  type?: string;
  role?: string;
  content?: unknown;
  id?: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p) =>
        p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "",
      )
      .join("");
  return "";
}

/** 改写 Responses 请求体以符合订阅接口约束（导出供测试）。 */
export function rewriteCodexBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const f of DROP_FIELDS) delete out[f];
  const input = Array.isArray(out.input) ? (out.input as InputItem[]) : [];
  const instructions: string[] = typeof out.instructions === "string" ? [out.instructions] : [];
  const kept: InputItem[] = [];
  for (const item of input) {
    if (item.role === "system" || item.role === "developer") {
      instructions.push(textOf(item.content));
      continue;
    }
    // store=false 时服务端不保存条目，引用型条目无法解析
    if (item.type === "item_reference") continue;
    const { id: _id, ...rest } = item;
    kept.push(item.type === "reasoning" ? item : (rest as InputItem));
  }
  out.input = kept;
  out.instructions =
    instructions.filter((s) => s.trim() !== "").join("\n\n") || "You are a helpful assistant.";
  out.store = false;
  out.stream = true;
  const include = new Set(Array.isArray(out.include) ? (out.include as string[]) : []);
  include.add("reasoning.encrypted_content");
  out.include = [...include];
  return out;
}

export function chatgptFetch(
  sub: { accessToken(): Promise<string>; accountId?: string },
  base: typeof fetch,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const token = await sub.accessToken();
    registerSecret(token);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("originator", "codex_cli_rs");
    headers.set("accept", "text/event-stream");
    if (sub.accountId) headers.set("chatgpt-account-id", sub.accountId);
    let body = init?.body;
    if (typeof body === "string" && headers.get("content-type")?.includes("json")) {
      try {
        body = JSON.stringify(rewriteCodexBody(JSON.parse(body) as Record<string, unknown>));
      } catch {
        // 非 JSON 请求体原样发送
      }
    }
    return base(input, { ...init, headers, body });
  }) as typeof fetch;
}

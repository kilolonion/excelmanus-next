import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { NUMERIC_DELIVERY_GUIDANCE, numericDeliveryState } from "../src/numeric-delivery.ts";
import { buildSystemPrompt } from "../src/prompts.ts";
import { ACCESS_DELIVERY_GUIDANCE } from "../src/turn-access.ts";

test("query numeric results retain the same delivery obligation as legacy analyze", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE session_log (seq INTEGER PRIMARY KEY, session_id TEXT, agent_id TEXT, type TEXT, data TEXT)",
  );
  const append = db.prepare(
    "INSERT INTO session_log(session_id,agent_id,type,data) VALUES('s','main',?,?)",
  );
  try {
    for (const toolName of ["workbook_analyze", "workbook_query"]) {
      append.run("turn.started", JSON.stringify({ turnId: toolName }));
      append.run(
        "tool.result",
        JSON.stringify({
          toolName,
          status: "ok",
          result: { status: "ok", data: { docId: "d", mode: "sql", rows: [[9]] } },
        }),
      );
      expect(numericDeliveryState(db, "s", "main", toolName).required).toBe(true);
    }
    append.run("turn.started", JSON.stringify({ turnId: "chat" }));
    expect(numericDeliveryState(db, "s", "main", "chat").required).toBe(false);
  } finally {
    db.close();
  }
});

test("restricted-path runtime guidance uses deliver without weakening source or access-fact restrictions", () => {
  expect(ACCESS_DELIVERY_GUIDANCE).toContain("deliver");
  expect(ACCESS_DELIVERY_GUIDANCE).toContain("inspect");
  expect(ACCESS_DELIVERY_GUIDANCE).toContain("finalize");
  expect(ACCESS_DELIVERY_GUIDANCE).toContain("partial");
  expect(ACCESS_DELIVERY_GUIDANCE).toContain("blocked");
  expect(ACCESS_DELIVERY_GUIDANCE).not.toMatch(/present|status=incomplete/);
  expect(ACCESS_DELIVERY_GUIDANCE).toContain("源文件只读");
  expect(ACCESS_DELIVERY_GUIDANCE).toContain("不得枚举父目录或查找其他文件");
  expect(ACCESS_DELIVERY_GUIDANCE).toContain("范围不明确时停止文件操作");
  expect(ACCESS_DELIVERY_GUIDANCE).toContain("访问清单由宿主生成");
  expect(ACCESS_DELIVERY_GUIDANCE).toContain("当前授权");
  expect(ACCESS_DELIVERY_GUIDANCE).toContain("不得自由声称未访问文件");
});

test("harness guidance uses current handles and never presentation size as verification", () => {
  const prompt = buildSystemPrompt({
    workspaceName: "ws",
    permissionMode: "default",
    date: "2026-10-22",
  });
  expect(prompt).toContain("身份");
  expect(prompt).toContain("排除计算不自动抹掉已知身份");
  expect(prompt).toContain("原始来源");
  expect(prompt).toContain("unverified");
  expect(prompt).toContain("原始范围");
  expect(prompt).toContain("普通");
  expect(prompt).toMatch(
    /检查能力不支持.*停止无效重试.*保留未验证义务.*partial.*blocked.*不得声称完成/,
  );
  expect(NUMERIC_DELIVERY_GUIDANCE).toContain("deliver");
  expect(NUMERIC_DELIVERY_GUIDANCE).toContain("inspect");
  expect(NUMERIC_DELIVERY_GUIDANCE).toContain("finalize");
  expect(NUMERIC_DELIVERY_GUIDANCE).toContain("required_output");
  expect(NUMERIC_DELIVERY_GUIDANCE).not.toMatch(/present|summary|32个|bindingId|sources:\[/);
});

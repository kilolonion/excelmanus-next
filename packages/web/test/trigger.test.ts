import { describe, expect, it } from "vitest";
import { triggerAt } from "../src/trigger.ts";

describe("triggerAt", () => {
  it("@ 在开头或空白后触发，取到光标为止的查询词", () => {
    expect(triggerAt("@销", 2)).toEqual({ kind: "@", start: 0, query: "销" });
    expect(triggerAt("看看 @月度", 6)).toEqual({ kind: "@", start: 3, query: "月度" });
    expect(triggerAt("看看 @", 4)).toEqual({ kind: "@", start: 3, query: "" });
  });
  it("邮箱、词中的 @ 与光标后的内容不触发", () => {
    expect(triggerAt("a@b.com", 7)).toBeNull();
    expect(triggerAt("@月度 之后", 7)).toBeNull();
  });
  it("/ 只在消息开头触发", () => {
    expect(triggerAt("/comp", 5)).toEqual({ kind: "/", start: 0, query: "comp" });
    expect(triggerAt("算 1/2", 5)).toBeNull();
    expect(triggerAt("/compact 再", 10)).toBeNull();
  });
});

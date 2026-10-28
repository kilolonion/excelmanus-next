import { expect, test } from "vitest";
import { sampleCopies } from "../src/lib/sample-files.ts";

test("each example attempt has independent filenames and preserves bytes and extensions", async () => {
  const source = new File(["项目,金额\n甲,3"], "月度销售报表.csv", { type: "text/csv" });
  const [a] = sampleCopies([source], "attempt-a");
  const [b] = sampleCopies([source], "attempt-b");
  expect(a?.name).toBe("月度销售报表-示例-attempt-a.csv");
  expect(b?.name).not.toBe(a?.name);
  expect(await a?.text()).toBe(await source.text());
  expect(a?.type).toBe(source.type);
  expect(source.name).toBe("月度销售报表.csv");
});

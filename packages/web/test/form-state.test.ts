import { expect, test } from "vitest";

const state = await import("../src/form-state.ts").catch(() => null);
test("表单快照比较实际值与选中状态，忽略按钮", () => {
  expect(state).not.toBeNull();
  const initial = [
    { name: "name", type: "text", value: "daily" },
    { name: "on", type: "checkbox", checked: false },
  ];
  expect(state!.formSignature(initial)).not.toBe(
    state!.formSignature([{ ...initial[0]!, value: "edited" }, initial[1]!]),
  );
  expect(state!.formSignature(initial)).not.toBe(
    state!.formSignature([initial[0]!, { ...initial[1]!, checked: true }]),
  );
  expect(state!.formSignature(initial)).toBe(
    state!.formSignature([...initial, { type: "submit", value: "save" }]),
  );
});

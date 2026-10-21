import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listAllFiles: vi.fn(), listSkills: vi.fn(), version: 0 }));
vi.mock("@/lib/backend/api", () => ({ api: () => mocks }));
vi.mock("@/stores/chat-store", () => ({
  useChatStore: { getState: () => ({ workspaceId: "ws" }) },
}));
vi.mock("@/stores/files-store", () => ({
  listAllFiles: mocks.listAllFiles,
  useFilesStore: { getState: () => ({ version: mocks.version }) },
}));

import {
  buildMentionPopoverItems,
  buildSkillPopoverItems,
  useChatMentions,
} from "../src/components/chat/ChatMentionList";

function loader() {
  let load!: ReturnType<typeof useChatMentions>["fetchMentionData"];
  function Probe() {
    load = useChatMentions().fetchMentionData;
    return null;
  }
  renderToString(createElement(Probe));
  return load;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.version = 0;
  mocks.listAllFiles.mockResolvedValue([{ path: "sample.xlsx" }]);
  mocks.listSkills.mockResolvedValue({ items: [] });
});

test("reopening file mentions retries failed reads instead of caching a false empty list", async () => {
  mocks.listAllFiles.mockRejectedValueOnce(new Error("temporary failure"));
  const load = loader();
  await load();
  await load();
  expect(mocks.listAllFiles).toHaveBeenCalledTimes(2);
});

test("reopening skills retries a failed skill read", async () => {
  mocks.listSkills.mockRejectedValueOnce(new Error("temporary failure"));
  const load = loader();
  await load();
  await load();
  expect(mocks.listSkills).toHaveBeenCalledTimes(2);
});

test("successful candidate reads still use the short-lived cache", async () => {
  const load = loader();
  await load();
  await load();
  expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);
  expect(mocks.listSkills).toHaveBeenCalledTimes(1);
});

test("candidate read errors are distinct from empty file and skill lists", () => {
  const data = { files: [], skills: [], filesError: true, skillsError: true };
  expect(buildMentionPopoverItems("at", "", data)[0]?.description).toContain("读取失败");
  expect(buildSkillPopoverItems("", data)[0]?.description).toContain("读取失败");
});

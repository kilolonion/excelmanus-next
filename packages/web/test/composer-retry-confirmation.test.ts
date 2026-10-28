import type { ReactElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { StateCreator } from "zustand";

const h = vi.hoisted(() => ({
  states: [] as unknown[],
  pickerStates: [] as unknown[],
  index: 0,
  mobile: false,
  switchAgentModel: vi.fn(),
  rewindAgent: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.index++;
    const states = h.states;
    if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
    return [
      states[i],
      (value: unknown) => {
        states[i] = typeof value === "function" ? value(states[i]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useLayoutEffect: () => {},
}));
vi.mock("zustand", async (original) => {
  const actual = await original<typeof import("zustand")>();
  return {
    ...actual,
    create:
      () =>
      <T>(initializer: StateCreator<T>) => {
        const store = actual.create(initializer);
        return Object.assign((select: (state: T) => unknown) => select(store.getState()), store);
      },
  };
});
vi.mock("@/hooks/use-mobile", async (original) => ({
  ...(await original<typeof import("@/hooks/use-mobile")>()),
  useIsMobile: () => h.mobile,
}));
vi.mock("@/hooks/use-model-selection", () => ({
  useCurrentProfileId: () => "current-profile",
  usePickerModels: () =>
    ["current-profile", "other-profile", "unhealthy-profile"].map((id) => ({
      id,
      label: id,
      profileName: id,
      model: id,
      provider: "openai",
      providerLabel: "OpenAI",
      brand: "openai",
      isDefault: id === "current-profile",
      unhealthy: id === "unhealthy-profile",
      vision: null,
    })),
}));
vi.mock("@/lib/backend/api", () => ({ api: () => h, errorMessage: (e: Error) => e.message }));
vi.mock("@/lib/backend/channel", () => ({
  onSync: vi.fn(),
  onConnection: vi.fn(),
  subscribeTopic: vi.fn(),
  unsubscribeTopic: vi.fn(),
}));

import { ChatInput } from "../src/components/chat/ChatInput";
import { ComposerRecoveryBar } from "../src/components/chat/ComposerRecoveryBar";
import { ModelListBottomSheet } from "../src/components/chat/ModelListBottomSheet";
import { RetryModelPicker } from "../src/components/chat/RetryModelPicker";
import { RollbackConfirmDialog } from "../src/components/chat/RollbackConfirmDialog";
import { DropdownMenu, DropdownMenuItem } from "../src/components/ui/dropdown-menu";
import { initialSessionState } from "../src/lib/session/reducer";
import type { UserItem } from "../src/lib/session/types";
import { useChatStore } from "../src/stores/chat-store";

const origin: UserItem = {
  kind: "user",
  id: "dispatch",
  seq: 1,
  at: "2026-10-20T00:00:00Z",
  agentId: "main",
  text: "将订单数量加一",
  mode: "queue",
  status: "applied",
  clientMessageId: "message",
  attachments: [],
  context: [],
};
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return [node, ...nodes(node.props?.children)];
}
function render() {
  h.index = 0;
  const root = ChatInput({});
  return nodes((root.type as (props: unknown) => unknown)(root.props));
}
function retryHandler() {
  const bar = render().find((node) => node.type === ComposerRecoveryBar);
  if (!bar) throw new Error("missing recovery bar");
  return bar.props.onRetryWithModel as (profileId: string) => void;
}
function retry() {
  retryHandler()("qa-model");
}
// Component/handler regression only: this does not mount Radix or synthesize browser keys.
function renderPicker(onSelect: (profileId: string) => void) {
  const composerStates = h.states;
  const composerIndex = h.index;
  h.states = h.pickerStates;
  h.index = 0;
  try {
    return nodes(RetryModelPicker({ onSelect }));
  } finally {
    h.states = composerStates;
    h.index = composerIndex;
  }
}
function pickerSurface(onSelect: (profileId: string) => void) {
  const type = h.mobile ? ModelListBottomSheet : DropdownMenu;
  const surface = renderPicker(onSelect).find((node) => node.type === type);
  if (!surface) throw new Error("missing picker surface");
  return surface.props;
}
function openPicker(onSelect: (profileId: string) => void) {
  const surface = pickerSurface(onSelect);
  expect(surface.open).toBe(false);
  (surface.onOpenChange as (open: boolean) => void)(true);
  expect(pickerSurface(onSelect).open).toBe(true);
}
function selectProfile(onSelect: (profileId: string) => void, profileId: string) {
  if (h.mobile) {
    (pickerSurface(onSelect).onSelect as (id: string) => void)(profileId);
    return;
  }
  const item = renderPicker(onSelect)
    .filter((node) => node.type === DropdownMenuItem)
    .find((node) => nodes(node).some((child) => child.props.children === profileId));
  if (!item) throw new Error(`missing selectable menu item: ${profileId}`);
  (item.props.onSelect as () => void)();
}
function dialog() {
  return render().find((node) => node.type === RollbackConfirmDialog)?.props;
}
async function flushRestart() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
function expectNoRestart() {
  expect(h.switchAgentModel).not.toHaveBeenCalled();
  expect(h.rewindAgent).not.toHaveBeenCalled();
  expect(h.sendMessage).not.toHaveBeenCalled();
}
function addWorkbookChange() {
  useChatStore.getState().session.changes.push({
    toolCallId: "write",
    docId: "book",
    path: "orders.xlsx",
    rev: 1,
    ranges: ["Sheet1!A1"],
    cells: 1,
    structural: [],
    agentId: "main",
    seq: 3,
  });
}
beforeEach(() => {
  h.states = [];
  h.pickerStates = [];
  h.index = 0;
  h.mobile = false;
  vi.clearAllMocks();
  h.switchAgentModel.mockResolvedValue({});
  h.rewindAgent.mockResolvedValue({});
  h.sendMessage.mockResolvedValue({});
  const session = initialSessionState();
  session.timelines.main = [
    origin,
    {
      kind: "turn",
      id: "turn:0",
      turnId: "turn",
      segment: 0,
      seq: 2,
      at: origin.at,
      agentId: "main",
      status: "interrupted",
      reason: "user",
      blocks: [],
      steps: 1,
    },
  ];
  useChatStore.setState({
    session,
    sessionId: "session",
    workspaceId: "workspace",
    viewAgentId: "main",
    loading: false,
    loadError: null,
    attachments: [],
    optimistic: [],
    notice: null,
    composerInsert: null,
  });
});

test.each(["workbook", "text"])(
  "composer model retry asks before restarting after a %s write and cancel does nothing",
  async (kind) => {
    if (kind === "workbook") addWorkbookChange();
    else
      useChatStore.getState().session.tools.write = {
        id: "write",
        name: "write",
        agentId: "main",
        seq: 3,
        args: { path: "notes.txt" },
        targets: [],
        phase: "done",
        status: "ok",
      };
    retry();
    await flushRestart();
    expectNoRestart();
    const pending = dialog();
    if (!pending) throw new Error("missing rollback dialog");
    expect(pending?.open).toBe(true);
    expect(pending?.files).toEqual([
      expect.objectContaining({ path: kind === "workbook" ? "orders.xlsx" : "notes.txt" }),
    ]);
    (pending.onCancel as () => void)();
    expect(dialog()?.open).toBe(false);
    await flushRestart();
    expectNoRestart();
  },
);

test("confirming composer retry switches model, rewinds and resends the original task once", async () => {
  addWorkbookChange();
  retry();
  expectNoRestart();
  const pending = dialog();
  if (!pending) throw new Error("missing rollback dialog");
  (pending.onConfirm as () => void)();
  await flushRestart();
  expect(dialog()?.open).toBe(false);
  expect(h.switchAgentModel).toHaveBeenCalledExactlyOnceWith("session", "main", {
    modelProfileId: "qa-model",
  });
  expect(h.rewindAgent).toHaveBeenCalledExactlyOnceWith("session", "main", {
    dispatchId: origin.id,
  });
  expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith(
    "session",
    "main",
    expect.objectContaining({ text: origin.text }),
  );
});

test("composer model retry without file changes still restarts immediately", async () => {
  retry();
  await flushRestart();
  expect(dialog()?.open ?? false).toBe(false);
  expect(h.switchAgentModel).toHaveBeenCalledOnce();
  expect(h.rewindAgent).toHaveBeenCalledOnce();
  expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith(
    "session",
    "main",
    expect.objectContaining({ text: origin.text }),
  );
});

test("desktop retry rows use Radix selection semantics for pointer and keyboard activation", () => {
  const tree = renderPicker(vi.fn());
  const items = tree.filter((node) => node.type === DropdownMenuItem);
  expect(items).toHaveLength(3);
  expect(items.map((item) => item.props.disabled)).toEqual([false, false, true]);
  for (const item of items) {
    expect(item.props.onSelect).toBeTypeOf("function");
    expect(item.props.onClick).toBeUndefined();
  }
});

test("rollback leaves initial focus to Radix instead of native button autofocus", () => {
  // Component-prop regression only. Browser focus trapping needs a mounted Radix lifecycle.
  const tree = nodes(
    RollbackConfirmDialog({ open: true, files: [], onCancel: vi.fn(), onConfirm: vi.fn() }),
  );
  expect(tree.filter((node) => node.props.autoFocus).map((node) => node.props.children)).toEqual(
    [],
  );
});

test.each([
  [false, "current-profile"],
  [false, "other-profile"],
  [true, "current-profile"],
  [true, "other-profile"],
])(
  "retry closes before confirmation and can reopen after cancel (mobile=%s, profile=%s)",
  async (mobile, profileId) => {
    h.mobile = mobile;
    addWorkbookChange();
    const requestRetry = retryHandler();
    const select = (id: string) => {
      expect(pickerSurface(select).open).toBe(false);
      expect(dialog()?.open).toBe(false);
      requestRetry(id);
    };

    openPicker(select);
    selectProfile(select, profileId);
    expect(dialog()?.open).toBe(true);
    expect(pickerSurface(select).open).toBe(false);
    await flushRestart();
    expectNoRestart();
    const pending = dialog();
    if (!pending) throw new Error("missing rollback dialog");
    (pending.onCancel as () => void)();
    expect(dialog()?.open).toBe(false);
    expect(pickerSurface(select).open).toBe(false);
    await flushRestart();
    expectNoRestart();

    openPicker(select);
    selectProfile(select, profileId);
    expect(dialog()?.open).toBe(true);
    const reopened = dialog();
    if (!reopened) throw new Error("missing reopened rollback dialog");
    (reopened.onConfirm as () => void)();
    await flushRestart();
    expect(dialog()?.open).toBe(false);
    expect(pickerSurface(select).open).toBe(false);
    expect(h.switchAgentModel).toHaveBeenCalledExactlyOnceWith("session", "main", {
      modelProfileId: profileId,
    });
    expect(h.rewindAgent).toHaveBeenCalledOnce();
    expect(h.sendMessage).toHaveBeenCalledOnce();
  },
);

test("dismissing a desktop retry menu keeps retry idle and permits reopening", async () => {
  const select = retryHandler();
  openPicker(select);
  (pickerSurface(select).onOpenChange as (open: boolean) => void)(false);
  expect(pickerSurface(select).open).toBe(false);
  openPicker(select);
  expect(dialog()?.open).toBe(false);
  await flushRestart();
  expectNoRestart();
});

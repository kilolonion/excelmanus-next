import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  mobile: true,
  ui: {
    sidebarOpen: false,
    sidebarTab: "chats",
    settingsOpen: true,
    settingsTab: "model",
    settingsOverview: true,
  } as any,
  book: { fullView: false, tabs: [] as any[], loading: false, activePath: null },
  state: { dirs: { "": [{ path: "Budget.xlsx", name: "Budget.xlsx", kind: "file" }] } },
  full: vi.fn(),
  picker: vi.fn(),
  sidebar: vi.fn(),
  sidebarTab: vi.fn(),
  settings: vi.fn(),
  overview: vi.fn(),
  close: vi.fn(),
  open: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.index++;
    if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? initial() : initial;
    return [
      h.slots[i],
      (next: any) => {
        h.slots[i] = typeof next === "function" ? next(h.slots[i]) : next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = h.index++;
    h.slots[i] ??= { current: initial };
    return h.slots[i];
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => unknown) => {
    fn();
  },
}));
vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));
vi.mock("framer-motion", () => ({
  motion: { div: "div", section: "section", button: "button" },
  AnimatePresence: "div",
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => h.mobile }));
vi.mock("@/stores/ui-store", () => ({
  useUIStore: Object.assign(
    (f: any) =>
      f({
        ...h.ui,
        openSettings: h.settings,
        showSettingsOverview: h.overview,
        closeSettings: h.close,
      }),
    {
      getState: () => ({
        setSidebarOpen: h.sidebar,
        setSidebarTab: h.sidebarTab,
        openWorkbookPicker: h.picker,
        openSettings: h.settings,
      }),
    },
  ),
}));
vi.mock("@/stores/workbook-store", () => ({
  useWorkbookStore: Object.assign((f: any) => f(h.book), { getState: () => h.book }),
  setFullView: h.full,
  openWorkbook: h.open,
}));
vi.mock("@/stores/files-store", () => ({
  useFilesStore: (f: any) => f(h.state),
  uploadFiles: vi.fn(),
}));
vi.mock("@/stores/chat-store", () => ({
  useChatStore: { getState: vi.fn() },
  addComposerFiles: vi.fn(),
  attachWorkspaceFile: vi.fn(),
}));
vi.mock("@/components/chat/chat-upload-bridge", () => ({ uploadChatFiles: h.upload }));
vi.mock("@/lib/backend/api", () => ({ errorMessage: (e: Error) => e.message }));

import { ChatUploadButton } from "../src/components/chat/ChatUploadButton";
import { MobileWorkbookDock } from "../src/components/excel/MobileWorkbookDock";
import { SettingsDialog } from "../src/components/settings/SettingsDialog";
import { WelcomePage } from "../src/components/welcome/WelcomePage";
import { WorkbookStart } from "../src/components/welcome/WorkbookStart";
import { MobileWorkspaceNav } from "../src/components/workspace/MobileWorkspaceNav";

type Node = { type: unknown; props: Record<string, any> };
function nodes(v: unknown): Node[] {
  if (Array.isArray(v)) return v.flatMap(nodes);
  if (!v || typeof v !== "object") return [];
  const n = v as Node;
  return [n, ...nodes(n.props?.children)];
}
function content(v: any): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(content).join("");
  return v && typeof v === "object" ? content(v.props?.children) : "";
}
function render(fn: () => unknown) {
  h.index = 0;
  return nodes(fn());
}
function action(tree: Node[], label: string) {
  const n = tree.find(
    (n) => n.props?.onClick && (n.props["aria-label"] === label || content(n) === label),
  );
  expect(n, label).toBeDefined();
  return n!.props;
}
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.mobile = true;
  h.ui = {
    sidebarOpen: false,
    sidebarTab: "chats",
    settingsOpen: true,
    settingsTab: "model",
    settingsOverview: true,
  };
  h.book = { fullView: false, tabs: [], loading: false, activePath: null };
  vi.clearAllMocks();
});

test("four mobile destinations are direct actions, preserving the existing session and workbook", () => {
  let tree = render(MobileWorkspaceNav);
  action(tree, "文件").onClick();
  expect(h.sidebarTab).toHaveBeenCalledWith("files");
  expect(h.sidebar).toHaveBeenCalledWith(true);
  action(tree, "表格").onClick();
  expect(h.picker).toHaveBeenCalledWith("full");
  action(tree, "设置").onClick();
  expect(h.settings).toHaveBeenCalledWith();
  h.book.tabs = [{ path: "Budget.xlsx" }];
  tree = render(MobileWorkspaceNav);
  action(tree, "表格").onClick();
  expect(h.full).toHaveBeenLastCalledWith(true);
  action(tree, "对话").onClick();
  expect(h.full).toHaveBeenLastCalledWith(false);
  expect(h.book.tabs).toEqual([{ path: "Budget.xlsx" }]);
});
test("phone settings starts with grouped index, deep-link opens detail, back retains that detail", () => {
  let tree = render(SettingsDialog);
  expect(tree.some((n) => n.props?.className === "em-settings-index")).toBe(true);
  expect(tree.some((n) => n.props?.className === "em-settings-detail-host")).toBe(false);
  const memory = tree.find((n) => n.type === "button" && content(n).startsWith("记忆"))!;
  memory.props.onClick();
  expect(h.settings).toHaveBeenCalledWith("memory");
  h.ui.settingsOverview = false;
  h.ui.settingsTab = "memory";
  tree = render(SettingsDialog);
  expect(tree.some((n) => n.props?.className === "em-settings-index")).toBe(false);
  action(tree, "返回设置分类").onClick();
  expect(h.overview).toHaveBeenCalledOnce();
  h.ui.settingsOverview = true;
  tree = render(SettingsDialog);
  const retained = tree.find((n) => n.props?.className === "em-settings-detail-host")!;
  expect(retained.props.hidden).toBe(true);
  expect(retained.props.inert).toBe(true);
  h.mobile = false;
  tree = render(SettingsDialog);
  expect(tree.some((n) => n.type === "aside")).toBe(true);
  expect(tree.find((n) => n.props?.className === "em-settings-detail-host")!.props.hidden).toBe(
    false,
  );
});
test("home opens full workbook on phone and panel on desktop, upload shares the composer pipeline", async () => {
  let tree = render(WorkbookStart);
  action(tree, "打开表格").onClick();
  expect(h.picker).toHaveBeenLastCalledWith("full");
  await action(tree, "Budget.xlsx").onClick();
  expect(h.open).toHaveBeenLastCalledWith("Budget.xlsx", { full: true });
  const upload = tree.find((n) => n.type === "input")!;
  const f = { name: "receipt.jpg" };
  h.upload.mockReturnValue(true);
  upload.props.onChange({ target: { files: [f], value: "x" } });
  expect(h.upload).toHaveBeenCalledExactlyOnceWith([f]);
  h.mobile = false;
  tree = render(WorkbookStart);
  action(tree, "打开表格").onClick();
  expect(h.picker).toHaveBeenLastCalledWith("panel");
});
test("phone home keeps examples opt-in, desktop retains the task gallery", () => {
  const home = () => WelcomePage({ onSuggestionClick: vi.fn() });
  let tree = render(home);
  expect(tree.filter((n) => n.props?.["aria-label"]?.startsWith("试用示例："))).toHaveLength(0);
  action(tree, "试用示例任务").onClick();
  tree = render(home);
  expect(tree.filter((n) => n.props?.["aria-label"]?.startsWith("试用示例："))).toHaveLength(4);
  action(tree, "收起示例").onClick();
  h.mobile = false;
  tree = render(home);
  expect(tree.filter((n) => n.props?.["aria-label"]?.startsWith("试用示例："))).toHaveLength(4);
});
test("table starts grid-first; tools toggle locally and selection-to-chat is a single explicit action", () => {
  const reference = vi.fn();
  const dock = () =>
    MobileWorkbookDock({
      range: "Sheet1!A1:C4",
      onReference: reference,
      format: "format controls",
      ask: "analysis controls",
      changes: "change controls",
      more: null,
    });
  let tree = render(dock);
  expect(content(tree[0])).not.toContain("format controls");
  action(tree, "格式").onClick();
  tree = render(dock);
  expect(content(tree[0])).toContain("format controls");
  action(tree, "变更").onClick();
  tree = render(dock);
  expect(content(tree[0])).not.toContain("format controls");
  expect(content(tree[0])).toContain("change controls");
  action(tree, "收起工具").onClick();
  tree = render(dock);
  expect(content(tree[0])).not.toContain("change controls");
  action(tree, "选区提问").onClick();
  expect(reference).toHaveBeenCalledOnce();
  expect(h.full).not.toHaveBeenCalled();
  tree = render(() =>
    MobileWorkbookDock({
      range: null,
      onReference: reference,
      format: null,
      ask: null,
      changes: null,
      more: null,
    }),
  );
  expect(action(tree, "先选区域").disabled).toBe(true);
});
test("mobile attachment source closes before handing off to workspace candidates, never sends", () => {
  const pick = vi.fn(),
    workspace = vi.fn();
  const upload = () => ChatUploadButton({ onPick: pick, onWorkspacePick: workspace });
  let tree = render(upload);
  action(tree, "添加文件").onClick();
  tree = render(upload);
  expect(tree.find((n) => n.props?.className === "em-mobile-actions-sheet")!.props.open).toBe(true);
  action(tree, "引用工作区文件").onClick();
  expect(workspace).toHaveBeenCalledOnce();
  expect(pick).not.toHaveBeenCalled();
  tree = render(upload);
  const sheet = tree.find((n) => n.props?.className === "em-mobile-actions-sheet")!.props;
  expect(sheet.open).toBe(false);
  const preventDefault = vi.fn();
  sheet.onCloseAutoFocus({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
});

test("switching from desktop settings to phone index retains the already opened form", () => {
  h.mobile = false;
  render(SettingsDialog);
  h.mobile = true;
  const tree = render(SettingsDialog);
  const detail = tree.find((n) => n.props?.className === "em-settings-detail-host");
  expect(detail).toBeDefined();
  expect(detail!.props.hidden).toBe(true);
});

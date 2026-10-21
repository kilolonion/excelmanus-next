import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  mobile: true,
  full: false,
  open: vi.fn().mockResolvedValue(true),
  sidebar: vi.fn(),
  image: vi.fn(),
  text: vi.fn(),
  download: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/hooks/use-mobile", () => ({ getIsMobile: () => h.mobile }));
vi.mock("@/stores/ui-store", () => ({
  useUIStore: { getState: () => ({ setSidebarOpen: h.sidebar }) },
}));
vi.mock("@/stores/workbook-store", () => ({
  openWorkbook: h.open,
  useWorkbookStore: { getState: () => ({ fullView: h.full }) },
}));
vi.mock("@/stores/files-store", () => ({ downloadWorkspaceFile: h.download }));
vi.mock("@/stores/preview-store", () => ({ openImagePreview: h.image, openTextPreview: h.text }));

import { openWorkspaceFile } from "../src/lib/open-file";

beforeEach(() => {
  h.mobile = true;
  h.full = false;
  vi.clearAllMocks();
});
test("phone file selection enters full workbook in one step and dismisses the file drawer", () => {
  openWorkspaceFile("Budget.xlsx");
  expect(h.open).toHaveBeenCalledExactlyOnceWith("Budget.xlsx", { full: true });
  expect(h.sidebar).toHaveBeenCalledExactlyOnceWith(false);
});
test("phone file selection dismisses the drawer even when already in a full workbook", () => {
  h.full = true;
  openWorkspaceFile("Second.xlsx", { range: "Sheet1!B2" });
  expect(h.open).toHaveBeenCalledWith("Second.xlsx", { full: true, focus: "Sheet1!B2" });
  expect(h.sidebar).toHaveBeenCalledWith(false);
});
test("desktop file selection keeps its current presentation and drawer", () => {
  h.mobile = false;
  openWorkspaceFile("Budget.xlsx");
  expect(h.open).toHaveBeenCalledWith("Budget.xlsx", { full: false });
  expect(h.sidebar).not.toHaveBeenCalled();
});
test("preview files replace the drawer, downloading a binary leaves navigation intact", () => {
  openWorkspaceFile("photo.jpg");
  expect(h.image).toHaveBeenCalledWith("photo.jpg");
  expect(h.sidebar).toHaveBeenCalledWith(false);
  h.sidebar.mockClear();
  openWorkspaceFile("data.zip");
  expect(h.download).toHaveBeenCalledWith("data.zip");
  expect(h.sidebar).not.toHaveBeenCalled();
});

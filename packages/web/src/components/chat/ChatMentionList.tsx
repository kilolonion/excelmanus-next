import { FileSpreadsheet, FileText, Sparkles } from "lucide-react";
import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from "react";
import { api } from "@/lib/backend/api";
import { isSpreadsheetFile } from "@/lib/file-kind";
import { useChatStore } from "@/stores/chat-store";
import { listAllFiles, useFilesStore } from "@/stores/files-store";
import { CommandPopover, type PopoverItem } from "./CommandPopover";
import type { MentionData, PopoverMode } from "./chat-input-constants";
import {
  detectAtMentionTrigger,
  formatFileMention,
  toDisplayMentionTokens,
} from "./chat-input-insert";

const MAX_FILE_ITEMS = 200;

/** @ 提及与 /技能 的候选：当前工作区文件（有限深度遍历）+ 可由用户调用的技能。 */
export function useChatMentions() {
  const [mentionData, setMentionData] = useState<MentionData | null>(null);
  const [atCategory, setAtCategory] = useState<string | null>(null);
  const cache = useRef<{ key: string; at: number; data: MentionData } | null>(null);
  const request = useRef(0);

  const fetchMentionData = useCallback(() => {
    const workspaceId = useChatStore.getState().workspaceId;
    const version = useFilesStore.getState().version;
    const key = JSON.stringify([workspaceId, version]);
    const hit = cache.current;
    if (hit && hit.key === key && Date.now() - hit.at < 30_000) {
      setMentionData(hit.data);
      return Promise.resolve();
    }
    const id = ++request.current;
    return (async () => {
      const [files, skills] = await Promise.all([
        workspaceId ? listAllFiles(2000).catch(() => []) : Promise.resolve([]),
        api()
          .listSkills()
          .then((res) => res.items)
          .catch(() => []),
      ]);
      if (id !== request.current) return;
      const data: MentionData = {
        files: files.map((f) => f.path),
        skills: skills
          .filter((s) => s.enabled && s.available && s.userInvocable)
          .map((s) => ({ name: s.name, description: s.description })),
      };
      cache.current = { key, at: Date.now(), data };
      setMentionData(data);
    })();
  }, []);

  return { mentionData, fetchMentionData, atCategory, setAtCategory };
}

export function buildMentionPopoverItems(
  popover: PopoverMode,
  popoverFilter: string,
  mentionData: MentionData | null,
): PopoverItem[] {
  if (popover !== "at" && popover !== "at-sub") return [];
  if (!mentionData)
    return [
      {
        command: "",
        description: "正在读取工作区文件…",
        icon: <FileText className="h-3.5 w-3.5 opacity-30" />,
      },
    ];
  const filter = popoverFilter.toLowerCase();
  const items: PopoverItem[] = [];
  for (const path of mentionData.files) {
    if (filter && !path.toLowerCase().includes(filter)) continue;
    const Icon = isSpreadsheetFile(path) ? FileSpreadsheet : FileText;
    items.push({
      command: formatFileMention({ path }),
      label: path,
      description: "文件",
      icon: <Icon className="h-3.5 w-3.5" />,
    });
    if (items.length >= MAX_FILE_ITEMS) break;
  }
  if (items.length === 0) {
    items.push({
      command: "",
      description: "工作区无匹配文件",
      icon: <FileSpreadsheet className="h-3.5 w-3.5 opacity-30" />,
    });
  }
  return items;
}

export function buildSkillPopoverItems(
  popoverFilter: string,
  mentionData: MentionData | null,
): PopoverItem[] {
  const filter = popoverFilter.toLowerCase();
  const items: PopoverItem[] = [];
  for (const s of mentionData?.skills ?? []) {
    if (
      !filter ||
      s.name.toLowerCase().includes(filter) ||
      s.description.toLowerCase().includes(filter)
    ) {
      items.push({
        command: `/${s.name}`,
        description: s.description || "技能",
        icon: <Sparkles className="h-3.5 w-3.5" />,
      });
    }
  }
  if (items.length === 0) {
    items.push({
      command: "",
      description: mentionData ? "暂无可用技能" : "正在读取技能…",
      icon: <Sparkles className="h-3.5 w-3.5 opacity-30" />,
    });
  }
  return items;
}

interface MentionSelectContext {
  item: { command: string };
  popover: PopoverMode;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  tokenMapRef: MutableRefObject<Map<string, string>>;
  setConfirmedTokens: Dispatch<SetStateAction<Set<string>>>;
  closePopover: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

/** 选中一个 @ 候选：替换输入中的 `@过滤词`，插入可见标签（发送时还原为 `@路径`）。 */
export function applyMentionSelection(ctx: MentionSelectContext): boolean {
  const {
    item,
    popover,
    text,
    setText,
    tokenMapRef,
    setConfirmedTokens,
    closePopover,
    textareaRef,
  } = ctx;
  if (popover !== "at" && popover !== "at-sub") return false;
  if (!item.command) return true;
  const [display] = toDisplayMentionTokens([item.command], tokenMapRef.current);
  const token = display ?? item.command;
  setConfirmedTokens((prev) => new Set(prev).add(token));
  const lastAtIdx = text.lastIndexOf("@");
  const before = lastAtIdx >= 0 ? text.slice(0, lastAtIdx) : text;
  setText(`${before}${token} `);
  closePopover();
  textareaRef.current?.focus();
  return true;
}

export function maybeOpenMentionPopover(
  value: string,
  fetchMentionData: () => void,
  setPopover: (mode: PopoverMode) => void,
  setPopoverFilter: (filter: string) => void,
): boolean {
  const afterAt = detectAtMentionTrigger(value);
  if (afterAt === null) return false;
  fetchMentionData();
  setPopover("at");
  setPopoverFilter(afterAt);
  return true;
}

interface ChatMentionListProps {
  popover: PopoverMode;
  popoverItems: PopoverItem[];
  selectedIndex: number;
  setSelectedIndex: (i: number) => void;
  selectPopoverItem: (item: PopoverItem) => void;
  popoverRef: RefObject<HTMLDivElement | null>;
}

export function ChatMentionList({
  popover,
  popoverItems,
  selectedIndex,
  setSelectedIndex,
  selectPopoverItem,
  popoverRef,
}: ChatMentionListProps) {
  if (popover !== "at" && popover !== "at-sub") return null;
  return (
    <CommandPopover
      popover={popover}
      popoverItems={popoverItems}
      selectedIndex={selectedIndex}
      setSelectedIndex={setSelectedIndex}
      selectPopoverItem={selectPopoverItem}
      popoverRef={popoverRef}
      activeSlashCmd={null}
      atCategory={null}
      onBackToSlash={() => {}}
      onBackToAt={() => {}}
    />
  );
}

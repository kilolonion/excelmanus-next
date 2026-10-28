import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { changesForDoc, lastUserSeq } from "@/lib/session/reducer";
import type { ChangeEntry } from "@/lib/session/types";
import { changeDeadline } from "@/lib/workbook/change-highlights";
import { pendingWriteTargets } from "@/lib/workbook/pending-writes";
import { useChatStore } from "@/stores/chat-store";
import { useWorkbookStore } from "@/stores/workbook-store";

/** Pending ranges and values share the same parsed tool arguments. */
export function usePendingOverlay(): { ranges: string; values: string } {
  const approvals = useChatStore((s) => s.session.approvals);
  const docId = useWorkbookStore((s) => s.doc?.docId);
  const path = useWorkbookStore((s) => s.doc?.path);
  return useMemo(() => {
    if (!docId) return { ranges: "", values: "" };
    const ranges: string[] = [];
    const values: Record<string, unknown> = {};
    for (const approval of Object.values(approvals)) {
      if (approval.status !== "pending") continue;
      const plan = pendingWriteTargets(approval);
      if (!plan || (plan.docId ? plan.docId !== docId : plan.path !== path)) continue;
      ranges.push(...plan.ranges);
      for (const [range, cells] of Object.entries(plan.values)) values[range] = cells[0]?.[0] ?? "";
    }
    return { ranges: [...new Set(ranges)].join("\n"), values: JSON.stringify(values) };
  }, [approvals, docId, path]);
}

export interface DocActivity {
  kind: "read" | "write";
  ranges: string[];
  label: string;
}

/** 当前文档上各代理正在进行的活动（含代理名标签）。 */
export function useDocActivity(): DocActivity[] {
  const docId = useWorkbookStore((s) => s.doc?.docId);
  const path = useWorkbookStore((s) => s.doc?.path);
  const activities = useChatStore(
    useShallow((s) =>
      Object.fromEntries(Object.entries(s.session.live).map(([id, live]) => [id, live.activity])),
    ),
  );
  const roster = useChatStore((s) => s.session.roster);
  const raw = useMemo(() => {
    if (!docId) return "";
    const out: { kind: string; ranges: string[]; agent: string }[] = [];
    for (const [agentId, activity] of Object.entries(activities)) {
      for (const a of activity) {
        if (a.docId ? a.docId !== docId : a.path !== path) continue;
        out.push({ kind: a.kind, ranges: a.ranges, agent: agentId });
      }
    }
    return out.length === 0 ? "" : JSON.stringify(out);
  }, [docId, path, activities]);
  return useMemo(() => {
    if (raw === "") return [];
    return (JSON.parse(raw) as { kind: "read" | "write"; ranges: string[]; agent: string }[]).map(
      (a) => {
        const who = a.agent === "main" ? null : (roster[a.agent]?.name ?? a.agent);
        const verb = a.kind === "read" ? "正在读取" : "正在写入";
        return { kind: a.kind, ranges: a.ranges, label: who ? `${who} · ${verb}` : verb };
      },
    );
  }, [raw, roster]);
}

const noChanges: ChangeEntry[] = [];
function useDocumentChanges(): ChangeEntry[] {
  const docId = useWorkbookStore((s) => s.doc?.docId);
  return useChatStore(useShallow((s) => (docId ? changesForDoc(s.session, docId) : noChanges)));
}

/** 近期已提交、仍在闪烁期内的改动（清除只影响视觉反馈，不删改变更记录）。 */
export function useRecentChanges(): ChangeEntry[] {
  const seenSeq = useWorkbookStore((s) => s.changesSeenSeq);
  const lastUser = useChatStore((s) => lastUserSeq(s.session));
  const documentChanges = useDocumentChanges();
  const changes = useMemo(() => {
    const since = Math.max(lastUser, seenSeq);
    return documentChanges.filter((c) => c.seq > since && c.ranges.length > 0);
  }, [seenSeq, lastUser, documentChanges]);
  const [clock, setClock] = useState(Date.now);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clock 在到期时触发重新计算
  const recent = useMemo(
    () => changes.filter((c) => changeDeadline(c) > Date.now()),
    [changes, clock],
  );
  useEffect(() => {
    if (recent.length === 0) return;
    const next = Math.min(...recent.map(changeDeadline));
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [recent]);
  return recent;
}

export function useDocChangeCount(): number {
  const changes = useDocumentChanges();
  const since = useChatStore((s) => lastUserSeq(s.session));
  return useMemo(() => changes.filter((c) => c.seq > since).length, [changes, since]);
}

export function useChangeNavigation(scope: "turn" | "all") {
  const changes = useDocumentChanges();
  const lastUser = useChatStore((s) => lastUserSeq(s.session));
  const since = scope === "turn" ? lastUser : 0;
  const allItems = useMemo(
    () =>
      changes.flatMap((entry) =>
        entry.seq > 0 ? entry.ranges.map((range) => ({ range, entry })) : [],
      ),
    [changes],
  );
  const items = useMemo(() => allItems.filter((item) => item.entry.seq > since), [allItems, since]);
  return { items, total: allItems.length };
}

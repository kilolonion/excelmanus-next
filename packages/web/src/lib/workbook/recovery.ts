import { z } from "zod";
import { type DocSyncState, markDisconnected } from "./doc-sync";

const CellDraft = z.object({
  sheetId: z.string(),
  row: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
  text: z.string(),
  baseRev: z.number().int().nonnegative().optional(),
});
export type CellDraft = z.infer<typeof CellDraft>;
const Mutation = z.object({ id: z.string(), params: z.unknown() });
const Recovery = z.object({
  version: z.literal(1),
  drafts: z.array(CellDraft),
  pending: z.record(
    z.string(),
    z.object({
      status: z.enum(["pending", "rejected"]),
      conflict: z.unknown().optional(),
      submitted: z.object({
        mutation: Mutation,
        mutations: z.array(Mutation).optional(),
        baseRev: z.number().int().nonnegative(),
      }),
    }),
  ),
});

export function recoveryKey(workspaceId: string, docId: string): string {
  return `excelmanus.recovery.${encodeURIComponent(workspaceId)}.${encodeURIComponent(docId)}`;
}

export function encodeRecovery(sync: DocSyncState, drafts: CellDraft[]): string | null {
  const pending = Object.fromEntries(
    Object.entries(sync.pending).filter(([, p]) => p.status !== "acked" && p.submitted),
  );
  // A newer draft in the same cell supersedes an older recovered input.
  const unique = new Map(
    drafts.map((d) => [JSON.stringify([d.sheetId, d.row, d.col]), CellDraft.parse(d)]),
  );
  if (!Object.keys(pending).length && !unique.size) return null;
  return JSON.stringify({ version: 1, pending, drafts: [...unique.values()] });
}

export function decodeRecovery(
  raw: string | null,
  rev: number,
): { docSync: DocSyncState; drafts: CellDraft[] } | null {
  if (!raw) return null;
  try {
    const parsed = Recovery.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return {
      docSync: markDisconnected({ rev, pending: parsed.data.pending }),
      drafts: parsed.data.drafts,
    };
  } catch {
    return null;
  }
}

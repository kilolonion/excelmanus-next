import type { ThreadComment } from "@excelmanus/protocol";

/** Group descendants once, keeping their original display order. */
export function indexCommentReplies(comments: ThreadComment[]): Map<string, ThreadComment[]> {
  const byId = new Map<string, ThreadComment>();
  const roots = new Set<string>();
  for (const comment of comments) {
    if (!byId.has(comment.id)) byId.set(comment.id, comment);
    if (!comment.parentId) roots.add(comment.id);
  }
  const resolved = new Map<string, string | null>();
  const rootOf = (id: string): string | null => {
    const path = new Set<string>();
    let current: string | undefined = id;
    let root: string | null = null;
    while (current && !path.has(current)) {
      if (roots.has(current)) {
        root = current;
        break;
      }
      if (resolved.has(current)) {
        root = resolved.get(current) ?? null;
        break;
      }
      path.add(current);
      current = byId.get(current)?.parentId;
    }
    for (const parent of path) resolved.set(parent, root);
    return root;
  };
  const groups = new Map<string, ThreadComment[]>();
  for (const comment of comments) {
    if (!comment.parentId) continue;
    const root = rootOf(comment.parentId);
    if (!root) continue;
    let replies = groups.get(root);
    if (!replies) {
      replies = [];
      groups.set(root, replies);
    }
    replies.push(comment);
  }
  return groups;
}

interface CommentSheet {
  id: string;
  name: string;
  comments: ThreadComment[];
}

function sameComment(left: ThreadComment, right: ThreadComment): boolean {
  // Validated ThreadComment fields are scalar; compare all fields, including optional ones.
  for (const field in left) {
    const key = field as keyof ThreadComment;
    if (left[key] !== right[key]) return false;
  }
  for (const field in right) if (!(field in left)) return false;
  return true;
}

/** Preserve derived thread rows when a fresh, validated read contains no comment changes. */
export function createStableCommentSheets() {
  let previous: CommentSheet[] = [];
  return (next: CommentSheet[]): CommentSheet[] => {
    const byId = new Map(previous.map((sheet) => [sheet.id, sheet]));
    const shared = next.map((sheet) => {
      const prior = byId.get(sheet.id);
      return prior &&
        prior.name === sheet.name &&
        prior.comments.length === sheet.comments.length &&
        prior.comments.every((comment, i) => sameComment(comment, sheet.comments[i]))
        ? prior
        : sheet;
    });
    if (shared.length !== previous.length || shared.some((sheet, i) => sheet !== previous[i]))
      previous = shared;
    return previous;
  };
}

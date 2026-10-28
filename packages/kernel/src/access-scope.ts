import { posix } from "node:path";
import type { DeliveryScopeDecision, DirectoryScopeDecision } from "@excelmanus/protocol";

const unresolved = (reason: string): DirectoryScopeDecision => ({ kind: "unresolved", reason });
const directoryLimit =
  /(?:不得|不要|禁止|不能|不可|不允许)[^。；;\n]{0,50}(?:其他目录|别的目录|目录外)|(?:仅限|只允许|只能|仅允许|仅访问|只访问)[^。；;\n]{0,100}(?:目录|文件夹)|(?:only\s+(?:access|read|search)\s+(?:within|in)|do\s+not\s+access\s+outside)\b/i;

/** Pure string normalization: no filesystem lookup and no basename discovery. */
export function normalizeAccessPath(input: string): string | undefined {
  const path = input.trim().replaceAll("\\", "/");
  if (!path || path.includes("\0") || /^(?:\/|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(path))
    return undefined;
  try {
    if (decodeURIComponent(path) !== path) return undefined;
  } catch {
    return undefined;
  }
  const normalized = posix.normalize(path);
  if (normalized === ".." || normalized.startsWith("../") || /[*?${}]/.test(normalized))
    return undefined;
  return normalized.replace(/\/$/, "") || ".";
}

/** Only supported explicit directory clauses, never a file-list permission inference. */
export function deriveUserDirectoryScope(rawText: string): DirectoryScopeDecision {
  const text = rawText
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/“[^”]*”|「[^」]*」/g, (quote) => (directoryLimit.test(quote) ? " " : quote));
  if (!directoryLimit.test(text))
    return directoryLimit.test(rawText)
      ? unresolved("目录限制只出现在引用或代码中，不能确定本任务授权，请在新消息中明确允许目录")
      : { kind: "unbounded" };
  const explicit = [
    ...text.matchAll(
      /(?:仅访问|只访问|仅限|只允许访问|仅允许访问)(?:目录|文件夹)\s*[“"'`]?([^\s，。；;“”"'`]+)[”"'`]?/g,
    ),
    ...text.matchAll(
      /(?:仅限|只允许|只能|仅允许)(?:访问|读取|查找|操作|在)?\s*[“"'`]?([^\s，。；;“”"'`]+?)[”"'`]?\s*(?:目录|文件夹)(?:内|中)?/g,
    ),
    ...text.matchAll(/(?:仅访问|只访问)\s*[“"'`]?([^\s，。；;“”"'`]+?)[”"'`]?\s*(?:目录|文件夹)/g),
    ...text.matchAll(
      /(?:only\s+(?:access|read|search)\s+(?:within|in)|do\s+not\s+access\s+outside)\s+["'`]?([^\s,;"'`]+)/gi,
    ),
  ].map((match) =>
    /^(?:only|do\s+not)/i.test(match[0]) ? (match[1] ?? "").replace(/\.$/, "") : (match[1] ?? ""),
  );
  let roots: string[];
  if (explicit.length) {
    roots = explicit;
  } else if (/同(?:一)?(?:测试)?目录/.test(text) && /(?:其他目录|别的目录|目录外)/.test(text)) {
    const files = [
      ...text.matchAll(
        /(?:^|[\s“”"'`，。；;：:])([^\s“”"'`，。；;：:]+\.(?:xlsx|xlsm|xls|csv|tsv|txt|pdf))(?=$|[\s“”"'`，。；;、])/gi,
      ),
    ].map((match) => match[1]!);
    if (!files.length) return unresolved("目录限制缺少可唯一确定的同目录路径");
    roots = files.map((file) => posix.dirname(file.replaceAll("\\", "/")));
    if (roots.some((root) => root === ".")) return unresolved("仅文件名不能确定允许目录");
  } else {
    return unresolved("目录限制不在支持的明确句式中，请给出唯一工作区相对目录");
  }
  const normalized = roots.map(normalizeAccessPath);
  if (normalized.some((root) => root === undefined || root === "."))
    return unresolved("允许目录必须是明确的工作区相对目录");
  const unique = [...new Set(normalized as string[])];
  if (unique.length !== 1) return unresolved("目录限制包含多个不同根，不能扩大为公共父目录");
  return { kind: "restricted", root: unique[0]! };
}

// Explicit two-file save-as/copy or read-source/create-output, not general NL permissions.
const fileLimit =
  /只处理这(?:两个|2个)文件|(?:不|不得|不要|禁止)[^。；;\n]{0,40}(?:访问|修改)[^。；;\n]{0,30}其他文件/;
function deriveReadFileScope(rawText: string): DirectoryScopeDecision {
  const directory = deriveUserDirectoryScope(rawText);
  if (!fileLimit.test(rawText)) return directory;
  const text = rawText
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/“[^”]*”|「[^」]*」|"[^"\n]*"/g, (quote) => (fileLimit.test(quote) ? " " : quote));
  if (!fileLimit.test(text))
    return unresolved("文件限制仅出现在引用或代码中，请在新任务中明确两个文件");
  const saveAs =
    /^(?:请)?(?:把|将)\s*(?:当前\s*)?([^\s，。；;“”"'`]+)\s+(?:另存为|复制为)\s+([^\s，。；;“”"'`]+)[，,。；;\s]/.exec(
      text.trim(),
    );
  const readCreate =
    /^(?:请)?只读取(?:本题)?\s+([^\s，、。；;“”"'`]+)\s*[，,、]\s*(?:并)?新建\s+([^\s，、。；;“”"'`]+)\s*[，,、]\s*不(?:修改|改)源文件\s*[，,、]\s*不访问其他文件[。；;\s]/.exec(
      text.trim(),
    );
  const relation = readCreate ?? saveAs;
  if (!relation || (!readCreate && !/只处理这(?:两个|2个)文件/.test(text)))
    return unresolved("文件限制需要明确命名源文件和另存目标，只处理这两个文件");
  const source = normalizeAccessPath(relation[1]!),
    output = normalizeAccessPath(relation[2]!);
  if (
    !source ||
    !output ||
    source === "." ||
    output === "." ||
    source === output ||
    !/\.(?:xlsx|xlsm|xls|csv|tsv|txt|pdf)$/i.test(source) ||
    !/\.(?:xlsx|xlsm|xls|csv|tsv|txt|pdf)$/i.test(output)
  )
    return unresolved("两个文件必须是不同、明确且合法的工作区相对文件路径");
  if (readCreate) {
    if (
      [source, output].some((path) =>
        /\.(?:xlsx|xlsm|xls|csv|tsv|txt|pdf)(?:或|和|以及|、)/i.test(path),
      )
    )
      return unresolved("文件名包含多个候选，不能确定唯一的源文件和输出文件");
    const trailing = text.slice(text.indexOf(readCreate[0]) + readCreate[0].length);
    // This finite clause has already assigned permissions. Do not interpret a second
    // file-access restriction as business instructions or guess how to combine it.
    if (
      trailing
        .split(/[。；;\n]/)
        .some(
          (clause) =>
            /(?:不允许|不得|不要|禁止|不能|不可|不|只读|仅允许读取)/.test(clause) &&
            (/(?:访问|读取|读写|写入|写操作)/.test(clause) ||
              (/(?:写|修改|创建|新建|保存|只读)/.test(clause) &&
                /(?:文件|源|输出|目标|结果|\.(?:xlsx|xlsm|xls|csv|tsv|txt|pdf))/i.test(clause))),
        )
    )
      return unresolved("两文件授权后出现额外文件访问限制，请用单一明确范围句说明权限");
  }
  const mentions = [
    ...text.matchAll(
      /(?:^|[\s，。；;：:“”"'`])([^\s，。；;：:“”"'`]+\.(?:xlsx|xlsm|xls|csv|tsv|txt|pdf))(?=$|[\s，。；;、:“”"'`])/gi,
    ),
  ].map((m) => normalizeAccessPath(m[1]!));
  if (
    mentions.some((path) => path !== source && path !== output) ||
    [
      ...text.matchAll(
        /(?:另存为|复制为|并新建)|新建\s+[^\s，,、。；;“”"'`]+\.(?:xlsx|xlsm|xls|csv|tsv|txt|pdf)(?=$|[\s，,、。；;“”"'`])|新建\s*(?:一个|另一个|另外一个|新的|其他|其它)?\s*(?:文件|工作簿)/gi,
      ),
    ].length !== 1
  )
    return unresolved("两文件限制包含其他文件或多个另存关系，不能扩大授权");
  const scope: DirectoryScopeDecision = {
    kind: "files",
    readPaths: [source, output],
    writePaths: [output],
  };
  if (directory.kind === "unbounded") return scope;
  if (
    directory.kind === "restricted" &&
    scope.readPaths.every((path) => accessScopeAllows(directory, path))
  )
    return scope;
  return unresolved("文件集合与目录限制冲突或不明确");
}

const deliveryLimit =
  /(?:仅|只|只能|仅允许|只允许|不得|不要|禁止|不能)[^。；;\n]{0,100}(?:交付|发卡|下载链接)|only\s+deliver\b/i;
const deliveryClause =
  /(?:仅|只|只能|仅允许|只允许)在\s*[`"\x27“]?([^\s，。；;`"\x27“”]+)[`"\x27”]?\s*(?:目录(?:内|中)?\s*)?(?:交付|发卡)|(?:仅|只|仅允许|只允许)交付到\s+[`"\x27“]?([^\s，。；;`"\x27“”]+)[`"\x27”]?|only\s+deliver\s+(?:within|in|to)\s+[`"\x27]?([^\s,;`"\x27]+)/gi;
export function deriveUserDeliveryScope(rawText: string): DeliveryScopeDecision {
  // A host outcome label is not a filesystem location restriction.
  const scopeText = rawText.replace(
    /(?:仅|只)(?:能|允许)?交付\s*(?:partial|blocked|completed)(?=$|[\s。；;，,])/gi,
    " ",
  );
  if (!deliveryLimit.test(scopeText)) return { kind: "unbounded" };
  const unresolvedDelivery = (reason: string): DeliveryScopeDecision => ({
    kind: "unresolved",
    reason,
    clause: rawText,
  });
  const text = scopeText
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/“[^”]*”|「[^」]*」|"[^"\n]*"/g, (quote) => (deliveryLimit.test(quote) ? " " : quote));
  if (!deliveryLimit.test(text)) return unresolvedDelivery("交付限制只出现在引用或代码中");
  const matches = [...text.matchAll(deliveryClause)];
  if (!matches.length || deliveryLimit.test(text.replace(deliveryClause, " ")))
    return unresolvedDelivery("请用明确句式：只在 <工作区相对目录>/ 交付");
  const tokens = matches.map((match) =>
    (match[1] ?? match[2] ?? match[3] ?? "").replace(/\.$/, ""),
  );
  const roots = tokens.map(normalizeAccessPath);
  if (
    roots.some((root) => !root || root === ".") ||
    new Set(roots).size !== 1 ||
    tokens.some(
      (token, index) =>
        !/[\\/]/.test(token) &&
        !/^[a-zA-Z0-9_.-]+$/.test(token) &&
        !/目录/.test(matches[index]?.[0] ?? ""),
    )
  )
    return unresolvedDelivery("交付目录必须是唯一、明确的工作区相对目录");
  return { kind: "roots", roots: roots as string[] };
}
export function deliveryScopeAllows(
  scope: DeliveryScopeDecision | undefined,
  path: string,
): boolean {
  if (!scope || scope.kind === "unbounded") return true;
  const normalized = normalizeAccessPath(path);
  return (
    !!normalized && scope.kind === "roots" && scope.roots.some((root) => within(normalized, root))
  );
}
export function narrowDeliveryScope(
  previous: DeliveryScopeDecision | undefined,
  next: DeliveryScopeDecision | undefined,
): DeliveryScopeDecision | undefined {
  if (!next || next.kind === "unbounded") return previous;
  if (!previous || previous.kind === "unbounded") return next;
  if (previous.kind === "unresolved") return previous;
  if (next.kind === "unresolved") return next;
  return {
    kind: "roots",
    roots: [
      ...new Set([
        ...previous.roots.filter((root) => next.roots.some((other) => within(root, other))),
        ...next.roots.filter((root) => previous.roots.some((other) => within(root, other))),
      ]),
    ],
  };
}

const outputLimit =
  /(?:仅|只|只能|仅允许|只允许)在[^。；;\n]{0,100}(?:输出|写入|修改|保存|生成|创建|新建)|(?:仅|只|仅允许|只允许)(?:输出|写入|保存)到|(?:输出|写入|修改|保存)(?:文件)?(?:仅限|只限)|(?:仅|只|只能|仅允许|只允许)(?:写到|写入到)|(?:不得|不要|禁止|不能|不可|不允许)(?:在)?(?:其他|其它|别的)目录(?:内|中)?(?:输出|写入|修改|保存|生成|创建|新建)/;
const outputClause =
  /(?:仅|只|只能|仅允许|只允许)在\s*[`"'“]?([^\s，。；;`"'“”]+)[`"'”]?\s*(?:目录(?:内|中)?\s*)?(?:输出|写入|修改|保存|生成|创建)|(?:仅|只|仅允许|只允许)(?:输出|写入|保存)到\s+[`"'“]?([^\s，。；;`"'“”]+)[`"'”]?/g;
function unresolvedWriteScope(rawText: string, reason: string): DirectoryScopeDecision {
  const reads = deriveReadFileScope(
    rawText
      .split(/[。；;\n]/)
      .filter((clause) => !outputLimit.test(clause))
      .join("。"),
  );
  return narrowDirectoryScope(reads, {
    kind: "split",
    writeRoots: [],
    writeUnresolved: { reason, clause: rawText },
  });
}
/** A finite user-authored output clause is a write limit, never a read grant. */
export function deriveUserAccessScope(rawText: string): DirectoryScopeDecision {
  // Delivery clauses do not grant or restrict ordinary filesystem I/O.
  rawText = rawText
    .split(/([。；;\n])/)
    .map((clause) =>
      deliveryLimit.test(clause) &&
      !/(?:写入|修改|生成|创建|新建|读取|访问|write|read|access)/i.test(clause)
        ? " "
        : clause,
    )
    .join("");
  if (!outputLimit.test(rawText)) return deriveReadFileScope(rawText);
  const text = rawText
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/“[^”]*”|「[^」]*」|"[^"\n]*"/g, (quote) => (outputLimit.test(quote) ? " " : quote));
  if (!outputLimit.test(text))
    return unresolvedWriteScope(rawText, "输出范围限制只出现在引用或代码中，请明确本任务输出目录");
  const clauses = [...text.matchAll(outputClause)];
  if (!clauses.length)
    return unresolvedWriteScope(rawText, "输出限制需要明确句式：仅在 <工作区相对目录>/ 输出");
  const remainder = text
    .replace(outputClause, " ")
    .replace(
      /(?:不得|不要|禁止|不能|不可|不允许)(?:在)?(?:其他|其它|别的)目录(?:内|中)?(?:输出|写入|修改|保存|生成|创建|新建)/g,
      " ",
    );
  if (outputLimit.test(remainder))
    return unresolvedWriteScope(rawText, "存在不能确定的额外输出范围限制");
  const roots = clauses.map((match) => normalizeAccessPath(match[1] ?? match[2] ?? ""));
  if (roots.some((root) => !root || root === ".") || new Set(roots).size !== 1)
    return unresolvedWriteScope(rawText, "输出目录必须是唯一、明确的工作区相对目录");
  const root = roots[0]!;
  // Require a directory-shaped token, not natural-language placeholders.
  if (
    !clauses.every(
      (match) =>
        /[\\/]/.test(match[1] ?? match[2] ?? "") ||
        /^[a-zA-Z0-9_.-]+$/.test(match[1] ?? match[2] ?? "") ||
        /目录/.test(match[0]),
    )
  )
    return unresolvedWriteScope(rawText, "输出范围需要明确目录路径，不能使用位置或副本等代称");
  return narrowDirectoryScope(deriveReadFileScope(remainder), {
    kind: "split",
    writeRoots: [root],
  });
}

/** Pure membership check shared by ingress and actual host access; never resolves a path. */
export function accessScopeAllows(
  scope: DirectoryScopeDecision,
  path: string,
  operation: "read" | "write" | "enumerate" = "read",
): boolean {
  if (scope.kind === "unbounded") return true;
  const normalized = normalizeAccessPath(path);
  if (!normalized || scope.kind === "unresolved") return false;
  if (scope.kind === "restricted")
    return normalized === scope.root || normalized.startsWith(`${scope.root}/`);
  if (scope.kind === "split") {
    if (operation === "write")
      return (
        !scope.writeUnresolved &&
        (scope.writePaths?.includes(normalized) === true ||
          scope.writeRoots.some((root) => within(normalized, root)))
      );
    if (scope.readPaths === undefined && scope.readRoots === undefined) return true;
    return (
      (operation !== "enumerate" && scope.readPaths?.includes(normalized) === true) ||
      (scope.readRoots ?? []).some((root) => within(normalized, root))
    );
  }
  if (operation === "enumerate") return false;
  return (operation === "write" ? scope.writePaths : scope.readPaths).includes(normalized);
}

export function isAccessContinuation(text: string): boolean {
  return /^(?:继续|重试|接着|接着上次|继续上次任务|换方法|换个方法|换一种方法|continue|retry|resume)$/i.test(
    text
      .trim()
      .replace(/[。.!！?？]+$/, "")
      .trim(),
  );
}
/** Ambiguous continuation is not a new unrestricted task. This is deliberately a finite prefix rule. */
export function ambiguousAccessContinuation(text: string): boolean {
  return (
    !isAccessContinuation(text) &&
    /^(?:继续|重试|接着|换方法|换个方法|换一种方法|continue\b|retry\b|resume\b)/i.test(text.trim())
  );
}
export function newUserDirectoryScope(
  text: string,
  previous?: DirectoryScopeDecision,
): DirectoryScopeDecision {
  const next = deriveUserAccessScope(text);
  if (
    previous &&
    previous.kind !== "unbounded" &&
    next.kind === "unbounded" &&
    ambiguousAccessContinuation(text)
  )
    return unresolved("续接指令的允许目录不明确，请另发包含明确目录限制的新任务");
  return next;
}
export function narrowDirectoryScope(
  previous: DirectoryScopeDecision,
  next: DirectoryScopeDecision,
): DirectoryScopeDecision {
  if (next.kind === "unbounded") return previous;
  if (previous.kind === "unbounded") return next;
  if (previous.kind === "unresolved" || next.kind === "unresolved")
    return unresolved("当前目录限制仍需新的明确用户任务确认");
  if (previous.kind === "split" || next.kind === "split") {
    if (previous.kind === "files" || next.kind === "files") {
      const files =
        previous.kind === "files"
          ? previous
          : (next as Extract<DirectoryScopeDecision, { kind: "files" }>);
      const other = previous.kind === "files" ? next : previous;
      const readPaths = files.readPaths.filter((path) => accessScopeAllows(other, path));
      if (!readPaths.length) return unresolved("补充范围没有可访问的文件交集");
      return {
        kind: "files",
        readPaths,
        writePaths: files.writePaths.filter(
          (path) => readPaths.includes(path) && accessScopeAllows(other, path, "write"),
        ),
      };
    }
    const a = splitScope(previous),
      b = splitScope(next);
    const reads = intersectGrants(a.reads, b.reads);
    const writes = intersectGrants(a.writes, b.writes)!;
    return {
      kind: "split",
      ...(reads ? { readPaths: reads.paths, readRoots: reads.roots } : {}),
      writePaths: writes.paths,
      writeRoots: writes.roots,
      ...((previous.kind === "split" && previous.writeUnresolved) ||
      (next.kind === "split" && next.writeUnresolved)
        ? {
            writeUnresolved:
              previous.kind === "split" && previous.writeUnresolved
                ? previous.writeUnresolved
                : next.kind === "split"
                  ? next.writeUnresolved
                  : undefined,
          }
        : {}),
    };
  }
  if (next.kind === "files") {
    if (
      next.readPaths.every((path) => accessScopeAllows(previous, path)) &&
      next.writePaths.every((path) => accessScopeAllows(previous, path, "write"))
    )
      return next;
  } else if (
    previous.kind === "restricted" &&
    (next.root === previous.root || next.root.startsWith(`${previous.root}/`))
  )
    return next;
  return unresolved("当前任务的补充指令不能扩大目录范围，请另发明确的新任务");
}

const within = (path: string, root: string) => path === root || path.startsWith(root + "/");
type Grants = { paths: string[]; roots: string[] };
function intersectGrants(a: Grants | undefined, b: Grants | undefined): Grants | undefined {
  if (!a) return b;
  if (!b) return a;
  const allows = (grant: Grants, path: string) =>
    grant.paths.includes(path) || grant.roots.some((root) => within(path, root));
  return {
    paths: [
      ...new Set([
        ...a.paths.filter((path) => allows(b, path)),
        ...b.paths.filter((path) => allows(a, path)),
      ]),
    ],
    roots: [
      ...new Set([
        ...a.roots.filter((root) => b.roots.some((other) => within(root, other))),
        ...b.roots.filter((root) => a.roots.some((other) => within(root, other))),
      ]),
    ],
  };
}
function splitScope(scope: Extract<DirectoryScopeDecision, { kind: "restricted" | "split" }>): {
  reads: Grants | undefined;
  writes: Grants;
} {
  if (scope.kind === "restricted")
    return {
      reads: { paths: [], roots: [scope.root] },
      writes: { paths: [], roots: [scope.root] },
    };
  return {
    reads:
      scope.readPaths === undefined && scope.readRoots === undefined
        ? undefined
        : { paths: scope.readPaths ?? [], roots: scope.readRoots ?? [] },
    writes: { paths: scope.writePaths ?? [], roots: scope.writeRoots },
  };
}

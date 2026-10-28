import { z } from "zod";

const attributes = z.record(z.string(), z.string());
const breaks = z.object({ attributes, breaks: z.array(attributes) });

/** Raw OOXML values: omitted attributes remain omitted, not filled with defaults. */
export const PrintSettings = z.object({
  pageSetup: attributes.optional(),
  pageSetUpPr: attributes.optional(),
  pageMargins: attributes.optional(),
  printOptions: attributes.optional(),
  headerFooter: z
    .object({
      attributes,
      oddHeader: z.string().optional(),
      oddFooter: z.string().optional(),
      evenHeader: z.string().optional(),
      evenFooter: z.string().optional(),
      firstHeader: z.string().optional(),
      firstFooter: z.string().optional(),
    })
    .optional(),
  rowBreaks: breaks.optional(),
  colBreaks: breaks.optional(),
  unsupported: z.array(z.string()).optional(),
});
export type PrintSettings = z.infer<typeof PrintSettings>;

export function printSettingsOf(sheet: { custom?: unknown } | undefined): PrintSettings {
  const custom = sheet?.custom as Record<string, unknown> | undefined;
  const parsed = PrintSettings.safeParse(custom?.excelmanusPrintSettings ?? {});
  return parsed.success ? parsed.data : { unsupported: ["invalidPrintMetadata"] };
}

export const PRINT_STATE_MUTATION = "excelmanus.mutation.set-sheet-print";
export const SheetPrintMutation = z.object({
  unitId: z.string(),
  subUnitId: z.string(),
  settings: PrintSettings.nullable(),
});

export function sheetPrintMutation(
  type: number,
  sheetOf: (
    unitId: string,
    sheetId: string,
  ) =>
    | {
        getCustomMetadata(): unknown;
        setCustomMetadata(value: Record<string, unknown>): void;
      }
    | undefined
    | null
    | void,
) {
  return {
    id: PRINT_STATE_MUTATION,
    type,
    handler: (_accessor: unknown, input: unknown): boolean => {
      const parsed = SheetPrintMutation.safeParse(input);
      if (!parsed.success) return false;
      const { unitId, subUnitId, settings } = parsed.data;
      const sheet = sheetOf(unitId, subUnitId);
      if (!sheet) return false;
      const previous = sheet.getCustomMetadata();
      const custom: Record<string, unknown> = {
        ...(previous && typeof previous === "object" ? previous : {}),
      };
      if (settings === null) delete custom.excelmanusPrintSettings;
      else custom.excelmanusPrintSettings = settings;
      sheet.setCustomMetadata(custom);
      return true;
    },
  };
}

type PrintDefinedName = {
  id: string;
  name: string;
  formulaOrRefString: string;
  localSheetId?: string;
};

/** Shared with browser preview. Complex references stay raw and are not guessed. */
export function printNamesOf(
  snapshot: {
    resources?: { name: string; data: string }[];
    sheets: Record<string, { name?: string }>;
  },
  sheetId: string,
) {
  const source = snapshot.resources?.find(
    (resource) => resource.name === "SHEET_DEFINED_NAME_PLUGIN",
  );
  // Univer's DefinedNameDataController serializes an absent name map as exactly "".
  // Nonempty malformed resources remain errors rather than losing existing names.
  const parsed: unknown = source && source.data !== "" ? JSON.parse(source.data) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid defined-name resource");
  const all = Object.values(parsed) as PrintDefinedName[];
  if (all.some((name) => !name || typeof name !== "object" ||
    typeof name.name !== "string" || typeof name.formulaOrRefString !== "string" ||
    (name.localSheetId !== undefined && typeof name.localSheetId !== "string")))
    throw new Error("Invalid defined-name entry");
  const definedNames = all.filter(
    (name) => name.localSheetId === sheetId && /^_xlnm\.Print_(Area|Titles)$/i.test(name.name),
  );
  let printArea: string | null = null;
  let repeatRows: string | null = null;
  let repeatColumns: string | null = null;
  const unsupported: string[] = [];
  for (const builtin of ["Area", "Titles"] as const) {
    const matches = definedNames.filter(
      (name) => name.name.toLowerCase() === `_xlnm.print_${builtin.toLowerCase()}`,
    );
    if (matches.length > 1) {
      unsupported.push(`Print_${builtin}`);
      continue;
    }
    const name = matches[0];
    if (!name) continue;
    const refs =
      name.formulaOrRefString.replace(/^=/, "").match(/(?:'[^']*(?:''[^']*)*'|[^',])+/g) ?? [];
    let valid = refs.length > 0;
    if (builtin === "Area" && refs.length !== 1) valid = false;
    for (const ref of refs) {
      const match = ref.trim().match(/^(?:'((?:[^']|'')+)'|([^'!]+))!([^!]+)$/);
      if (
        !match ||
        (match[1]?.replaceAll("''", "'") ?? match[2]) !== snapshot.sheets[sheetId]?.name
      ) {
        valid = false;
        continue;
      }
      const address = match[3]!.replaceAll("$", "").toUpperCase();
      if (builtin === "Area" && /^[A-Z]{1,3}[1-9]\d*(?::[A-Z]{1,3}[1-9]\d*)?$/.test(address))
        printArea = address;
      else if (builtin === "Titles" && /^[1-9]\d*:[1-9]\d*$/.test(address) && repeatRows === null)
        repeatRows = address;
      else if (
        builtin === "Titles" &&
        /^[A-Z]{1,3}:[A-Z]{1,3}$/.test(address) &&
        repeatColumns === null
      )
        repeatColumns = address;
      else valid = false;
    }
    if (!valid) {
      unsupported.push(`Print_${builtin}`);
      if (builtin === "Area") printArea = null;
      else {
        repeatRows = null;
        repeatColumns = null;
      }
    }
  }
  return { printArea, repeatRows, repeatColumns, definedNames, unsupported };
}

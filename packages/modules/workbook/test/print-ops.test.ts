import { PRINT_STATE_MUTATION, printSettingsOf } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { importCsv } from "../src/csv.ts";
import { namesOf, setNames } from "../src/defined-names.ts";
import { bootUniver, createBook, MutationCapture } from "../src/engine.ts";
import { makeInverse } from "../src/inverse.ts";
import { ChangeOp, compileOps } from "../src/ops.ts";

function initial() {
  const { snapshot } = importCsv(new TextEncoder().encode("项目,值\n甲,1"), "print.csv");
  const sheet = snapshot.sheets[snapshot.sheetOrder[0]!]!;
  sheet.custom = {
    excelmanusObjects: { charts: [], images: [] },
    excelmanusPrintSettings: {
      pageSetup: { paperSize: "9", orientation: "landscape", fitToHeight: "0", vendor: "keep" },
      pageMargins: { left: "0.4" },
      headerFooter: { attributes: { differentOddEven: "1" }, evenHeader: "&F" },
    },
  };
  setNames(snapshot, {
    titles: {
      id: "titles",
      name: "_xlnm.Print_Titles",
      localSheetId: sheet.id,
      formulaOrRefString: `'${sheet.name}'!$1:$2,'${sheet.name}'!$A:$C`,
    },
  });
  return { snapshot, sheet };
}

test("print.set schema accepts bounded dedicated fields and rejects unsupported/invalid settings", () => {
  expect(ChangeOp.safeParse({ op: "print.set", sheet: "打印", repeatRows: "1:3" }).success).toBe(
    true,
  );
  expect(ChangeOp.safeParse({ op: "print.set", sheet: "打印", afterRows: [0] }).success).toBe(
    false,
  );
  expect(ChangeOp.safeParse({ op: "print.set", sheet: "打印", scale: 50 }).success).toBe(false);
});

test("print compilation preserves title columns, unknown settings and ordered partial patches", () => {
  const { snapshot, sheet } = initial();
  const result = compileOps({ snapshot, unitId: snapshot.id }, [
    {
      op: "print.set",
      sheet: sheet.id,
      repeatRows: "1:3",
      orientation: "portrait",
      oddHeader: "&F &P",
    },
    { op: "print.set", sheet: sheet.id, oddFooter: "&N", fitToHeight: null },
  ] as unknown as ChangeOp[]);
  const name = result.commands.find(
    (command) => command.id === "formula.mutation.set-defined-name",
  );
  expect(name?.params.formulaOrRefString).toBe(`'${sheet.name}'!$1:$3,'${sheet.name}'!$A:$C`);
  const settings = result.commands
    .filter((command) => command.id === "excelmanus.mutation.set-sheet-print")
    .at(-1)?.params.settings;
  expect(settings).toEqual({
    pageSetup: { paperSize: "9", orientation: "portrait", vendor: "keep" },
    pageMargins: { left: "0.4" },
    headerFooter: {
      attributes: { differentOddEven: "1" },
      evenHeader: "&F",
      oddHeader: "&F &P",
      oddFooter: "&N",
    },
  });
  expect(namesOf(snapshot).titles?.formulaOrRefString).toContain("$1:$2");
  expect(sheet.custom?.excelmanusObjects).toEqual({ charts: [], images: [] });
});

test("generic name.set cannot silently rectangularize reserved print titles", () => {
  const { snapshot, sheet } = initial();
  expect(() =>
    compileOps({ snapshot, unitId: snapshot.id }, [
      ChangeOp.parse({
        op: "name.set",
        name: "_xlnm.Print_Titles",
        scope: sheet.id,
        range: `'${sheet.name}'!1:3`,
      }),
    ]),
  ).toThrow(/print.set/);
});

test("qualified print areas retain literal sheet-name dollars and null removes only requested settings", () => {
  const { snapshot, sheet } = initial();
  sheet.name = "Cost$25";
  setNames(snapshot, {});
  const result = compileOps({ snapshot, unitId: snapshot.id }, [
    ChangeOp.parse({
      op: "print.set",
      sheet: sheet.id,
      printArea: "'Cost$25'!$A$1:$E$22",
      repeatRows: "1:3",
      afterRows: [10],
      fitToWidth: 1,
    }),
    ChangeOp.parse({
      op: "print.set",
      sheet: sheet.id,
      printArea: null,
      repeatRows: null,
      afterRows: null,
    }),
  ]);
  expect(
    result.commands.filter((command) => command.id === "formula.mutation.remove-defined-name"),
  ).toHaveLength(2);
  const settings = result.commands.at(-1)?.params.settings;
  expect(settings).toMatchObject({
    pageSetUpPr: { fitToPage: "1" },
    pageSetup: { fitToWidth: "1", orientation: "landscape", vendor: "keep" },
    rowBreaks: { attributes: { count: "0", manualBreakCount: "0" }, breaks: [] },
  });
});

test("print mutation is captured, replayable and undone without replacing drawing custom", async () => {
  const { snapshot, sheet } = initial();
  const boot = bootUniver();
  try {
    const book = createBook(boot, snapshot);
    const sid = sheet.id!;
    const before = book.workbook.save();
    const capture = new MutationCapture(boot);
    capture.begin();
    const changed = {
      pageSetup: { orientation: "portrait" },
      headerFooter: { attributes: {}, oddHeader: "&F &P" },
    };
    expect(
      await boot.executeCommand(PRINT_STATE_MUTATION, {
        unitId: book.unitId,
        subUnitId: sheet.id,
        settings: changed,
      }),
    ).toBe(true);
    const mutations = capture.end();
    expect(mutations.map((mutation) => mutation.id)).toContain(PRINT_STATE_MUTATION);
    const after = book.workbook.save();
    expect(printSettingsOf(after.sheets[sid])).toEqual(changed);
    expect(after.sheets[sid]?.custom?.excelmanusObjects).toEqual(sheet.custom?.excelmanusObjects);
    const { inverse } = makeInverse(before, after, mutations, book.unitId);
    expect(inverse.some((mutation) => mutation.id === PRINT_STATE_MUTATION)).toBe(true);
    for (const mutation of inverse) await boot.executeCommand(mutation.id, mutation.params);
    expect(printSettingsOf(book.workbook.save().sheets[sid])).toEqual(printSettingsOf(sheet));
    for (const mutation of mutations) await boot.executeCommand(mutation.id, mutation.params);
    expect(printSettingsOf(book.workbook.save().sheets[sid])).toEqual(changed);
  } finally {
    await boot.dispose();
  }
}, 60000);

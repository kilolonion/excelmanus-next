import { WorkbookObjects } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { importCsv } from "../src/csv.ts";
import { objectsOf } from "../src/objects.ts";
import { ChangeOp, compileOps, transformChangeOp } from "../src/ops.ts";

const initial = () => {
  const { snapshot } = importCsv(new TextEncoder().encode("项目,值\n甲,1"), "drawing.csv");
  const sheet = snapshot.sheets[snapshot.sheetOrder[0]!]!;
  sheet.custom = {
    excelmanusObjects: {
      charts: [],
      images: [
        {
          id: "picture",
          title: "原图",
          anchor: "C5",
          width: 96,
          height: 48,
          offsetX: 3,
          offsetY: 2,
          mediaPart: "xl/media/image1.png",
          mediaType: "image/png",
        },
      ],
      shapes: [
        {
          id: "box",
          title: "原矩形",
          text: "保留",
          type: "rect",
          anchor: "C10",
          width: 128,
          height: 60,
          offsetX: 4,
          offsetY: 5,
          fill: "#77AA77",
        },
      ],
    },
  };
  const apply = (op: unknown) => {
    const compiled = compileOps({ snapshot, unitId: snapshot.id }, [ChangeOp.parse(op)]);
    for (const command of compiled.commands)
      if (command.params.objects) sheet.custom!.excelmanusObjects = command.params.objects;
    return compiled;
  };
  return { snapshot, sheet, apply };
};

test("image update retains original binary identity and offsets unless a new anchor resets them", () => {
  const { sheet, apply } = initial();
  apply({ op: "image.update", sheet: sheet.id, id: "picture", width: 144 });
  expect(objectsOf(sheet).images[0]).toMatchObject({
    width: 144,
    height: 48,
    offsetX: 3,
    offsetY: 2,
    mediaPart: "xl/media/image1.png",
  });
  apply({ op: "image.update", sheet: sheet.id, id: "picture", anchor: "J3", height: 72 });
  expect(objectsOf(sheet).images[0]).toMatchObject({ anchor: "J3", offsetX: 0, offsetY: 0 });
  expect(objectsOf(sheet).shapes).toHaveLength(1);
});

test("three flat shapes share validated add/update/delete with conservative partial updates", () => {
  const { sheet, apply } = initial();
  apply({ op: "shape.update", sheet: sheet.id, id: "box", width: 160 });
  expect(objectsOf(sheet).shapes?.[0]).toMatchObject({
    text: "保留",
    anchor: "C10",
    width: 160,
    offsetX: 4,
    offsetY: 5,
    fill: "#77AA77",
  });
  apply({ op: "shape.update", sheet: sheet.id, id: "box", anchor: "J9" });
  expect(objectsOf(sheet).shapes?.[0]).toMatchObject({ offsetX: 0, offsetY: 0 });
  apply({ op: "shape.delete", sheet: sheet.id, id: "box" });
  for (const type of ["rect", "ellipse", "rightArrow"]) {
    apply({
      op: "shape.add",
      sheet: sheet.id,
      id: type,
      title: type,
      type,
      text: "新增",
      anchor: "C18",
      width: 120,
      height: 40,
    });
  }
  expect(objectsOf(sheet).shapes).toHaveLength(3);
  expect(objectsOf(sheet).shapes?.[2]).toMatchObject({
    id: "rightArrow",
    fill: "#4472C4",
    stroke: "#2F528F",
    textColor: "#FFFFFF",
  });
  expect(objectsOf(sheet).images[0]?.title).toBe("原图");
});

test("unsupported shape types and binary replacement fields cannot enter the public operation schema", () => {
  const { sheet, apply } = initial();
  expect(
    ChangeOp.safeParse({
      op: "shape.add",
      sheet: sheet.id,
      type: "group",
      title: "组",
      text: "",
    }).success,
  ).toBe(false);
  expect(
    ChangeOp.safeParse({
      op: "image.update",
      sheet: sheet.id,
      id: "picture",
      data: "replacement",
    }).success,
  ).toBe(false);
  expect(
    ChangeOp.safeParse({
      op: "shape.update",
      sheet: sheet.id,
      id: "box",
      fill: "#FF0000",
      text: "不应覆盖原富格式",
    }).success,
  ).toBe(false);
  expect(() => apply({ op: "shape.delete", sheet: sheet.id, id: "unknown_group" })).toThrow(
    /不支持|不可编辑|仅保留/,
  );
});

test("object protocol retains fractional pixel offsets and rejects negative offsets", () => {
  const { sheet } = initial();
  const objects = objectsOf(sheet);
  expect(WorkbookObjects.parse(objects).shapes).toHaveLength(1);
  const image = { ...objects.images[0], offsetX: 0.5 };
  expect(WorkbookObjects.parse({ ...objects, images: [image] }).images[0]?.offsetX).toBe(0.5);
  expect(
    WorkbookObjects.safeParse({ ...objects, images: [{ ...image, offsetX: -1 }] }).success,
  ).toBe(false);
});

test("shape-only sheet copy is guarded and new operations rebase sheet names to stable ids", () => {
  const { sheet, apply } = initial();
  const objects = objectsOf(sheet);
  sheet.custom!.excelmanusObjects = { ...objects, images: [] };
  expect(() => apply({ op: "sheet.copy", sheet: sheet.id, name: "副本" })).toThrow(/不能安全复制/);
  const op = ChangeOp.parse({
    op: "shape.update",
    sheet: "旧表名",
    id: "box",
    width: 200,
  });
  expect(transformChangeOp(op, [], () => sheet.id)).toMatchObject({ sheet: sheet.id });
});

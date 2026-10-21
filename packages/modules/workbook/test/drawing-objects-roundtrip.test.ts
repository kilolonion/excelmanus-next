import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { exportXlsx, minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { objectsOf, preservedMetadata } from "../src/objects.ts";
import { importXlsx } from "../src/xlsx.ts";
import { assertXmlDocument, elements } from "../src/xml.ts";

const original = Buffer.from(
  readFileSync(new URL("./fixtures/drawing-objects.xlsx.base64", import.meta.url), "utf8"),
  "base64",
);
const drawingPart = "xl/drawings/drawing1.xml";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
});
const fixture = (transform?: (body: string) => string) => {
  const parts = unzipSync(original);
  if (transform) parts[drawingPart] = strToU8(transform(strFromU8(parts[drawingPart]!)));
  return importXlsx(zipSync(parts), "drawing-objects.xlsx");
};
const drawingXml = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)[drawingPart]!);
const anchors = (body: string) => {
  const root = parser.parse(body).wsDr;
  return [...[root.oneCellAnchor ?? []].flat(), ...[root.twoCellAnchor ?? []].flat()];
};
const anchorFor = (body: string, name: string) =>
  anchors(body).find(
    (anchor) => (anchor.pic?.nvPicPr?.cNvPr ?? anchor.sp?.nvSpPr?.cNvPr)?.["@_name"] === name,
  );
const changedSheet = (input: ReturnType<typeof fixture>) => {
  const snapshot = structuredClone(input.snapshot);
  const sheet = snapshot.sheets[snapshot.sheetOrder[0]!]!;
  return { snapshot, sheet };
};

test.each(["xdr", "draw", "default"])(
  "adding an image to a %s drawing with locally bound relationship namespace preserves foreign anchors",
  (prefix) => {
    const input = fixture((body) =>
      prefix === "default"
        ? body.replaceAll("xdr:", "").replace("xmlns:xdr=", "xmlns=")
        : body.replaceAll("xdr:", `${prefix}:`).replace("xmlns:xdr=", `xmlns:${prefix}=`),
    );
    const { snapshot, sheet } = changedSheet(input);
    const objects = objectsOf(sheet);
    sheet.custom = {
      ...sheet.custom,
      excelmanusObjects: {
        ...objects,
        images: [
          ...objects.images,
          {
            id: "added_image",
            title: "新增",
            anchor: "L3",
            width: 48,
            height: 24,
            mediaType: "image/png",
            data: Buffer.from(input.preservation!.parts["xl/media/image1.png"]!).toString("base64"),
          },
        ],
      },
    };
    const output = exportXlsx(input, snapshot);
    const parts = unzipSync(output);
    const body = drawingXml(output);
    expect(() => assertXmlDocument(body)).not.toThrow();
    const rootPrefix = prefix === "default" ? "" : `${prefix}:`;
    for (const node of elements(
      strFromU8(input.preservation!.parts[drawingPart]!),
      `${rootPrefix}twoCellAnchor`,
    ))
      expect(body).toContain(node.raw);
    expect(parts["xl/media/image1.png"]).toEqual(input.preservation!.parts["xl/media/image1.png"]);
    expect(parts["xl/media/image2.png"]).toEqual(input.preservation!.parts["xl/media/image2.png"]);
    const reloaded = importXlsx(output, "drawing-objects.xlsx").snapshot;
    expect(objectsOf(reloaded.sheets[reloaded.sheetOrder[0]!]).images).toHaveLength(3);
  },
);

test("a new worksheet drawing binds its own relationship namespace when r is only local elsewhere", () => {
  const parts = unzipSync(original);
  const relation = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  parts["xl/worksheets/sheet1.xml"] = strToU8(
    strFromU8(parts["xl/worksheets/sheet1.xml"]!)
      .replace(` xmlns:r="${relation}"`, "")
      .replace(
        '<drawing r:id="rId1"/>',
        `<hyperlinks><hyperlink xmlns:r="${relation}" ref="A1" r:id="rId99"/></hyperlinks>`,
      ),
  );
  const input = importXlsx(zipSync(parts), "local-r.xlsx");
  const { snapshot, sheet } = changedSheet(input);
  sheet.custom = {
    ...sheet.custom,
    excelmanusObjects: {
      charts: [],
      images: [
        {
          id: "new_image",
          title: "新增",
          anchor: "C5",
          width: 96,
          height: 48,
          mediaType: "image/png",
          data: Buffer.from(parts["xl/media/image1.png"]!).toString("base64"),
        },
      ],
    },
  };
  const bytes = exportXlsx(input, snapshot);
  expect(() =>
    assertXmlDocument(strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]!)),
  ).not.toThrow();
  const reloaded = importXlsx(bytes, "local-r.xlsx").snapshot;
  expect(objectsOf(reloaded.sheets[reloaded.sheetOrder[0]!]).images).toHaveLength(1);
});

test("imported image offsets survive a size-only update and its original media bytes stay intact", () => {
  const input = fixture();
  const { snapshot, sheet } = changedSheet(input);
  const objects = objectsOf(sheet);
  expect(objects.images[0]).toMatchObject({ anchor: "C5", offsetX: 3, offsetY: 2 });
  sheet.custom!.excelmanusObjects = {
    ...objects,
    images: objects.images.map((image) =>
      image.id === "keep_image" ? { ...image, width: 130, height: 61 } : image,
    ),
  };
  const output = exportXlsx(input, snapshot);
  const anchor = anchorFor(drawingXml(output), "keep_image");
  expect(anchor.from).toMatchObject({ col: "2", row: "4", colOff: "28575", rowOff: "19050" });
  expect(anchor.to).toMatchObject({ col: "4", row: "7", colOff: "47625", rowOff: "28575" });
  expect(anchor.pic.spPr.xfrm.ext).toMatchObject({ "@_cx": "1238250", "@_cy": "581025" });
  expect(unzipSync(output)["xl/media/image1.png"]).toEqual(
    input.preservation!.parts["xl/media/image1.png"],
  );
});

test("moving a two-cell image updates both markers against actual column widths and row heights", () => {
  const input = fixture();
  const { snapshot, sheet } = changedSheet(input);
  const objects = objectsOf(sheet);
  sheet.columnData = { ...sheet.columnData, 4: { w: 80 }, 5: { w: 50 } };
  sheet.rowData = { ...sheet.rowData, 5: { h: 30 }, 6: { h: 25 } };
  sheet.custom!.excelmanusObjects = {
    ...objects,
    images: objects.images.map((image) =>
      image.id === "keep_image"
        ? { ...image, anchor: "E6", offsetX: 0, offsetY: 0, width: 100, height: 60 }
        : image,
    ),
  };
  const anchor = anchorFor(drawingXml(exportXlsx(input, snapshot)), "keep_image");
  expect(anchor.from).toMatchObject({ col: "4", row: "5", colOff: "0", rowOff: "0" });
  expect(anchor.to).toMatchObject({ col: "5", row: "7", colOff: "190500", rowOff: "47625" });
  expect(anchor.pic.spPr.xfrm.off).toMatchObject({ "@_x": "2438400", "@_y": "952500" });
});

test("flat shapes import and move without rebuilding their original shape body", () => {
  const input = fixture();
  const { snapshot, sheet } = changedSheet(input);
  const objects = objectsOf(sheet) as ReturnType<typeof objectsOf> & {
    shapes?: Array<Record<string, unknown>>;
  };
  expect(objects.shapes).toHaveLength(2);
  expect(objects.shapes![0]).toMatchObject({
    id: "keep_shape",
    type: "rect",
    text: "保留矩形",
    anchor: "C10",
    width: 128,
    height: 60,
    fill: "#D9EAD3",
    stroke: "#808080",
    textColor: "#000000",
  });
  sheet.custom!.excelmanusObjects = {
    ...objects,
    shapes: objects.shapes!.map((shape) =>
      shape.id === "keep_shape" ? { ...shape, anchor: "D11", width: 150, height: 70 } : shape,
    ),
  };
  const before = anchorFor(strFromU8(input.preservation!.parts[drawingPart]!), "keep_shape");
  const output = drawingXml(exportXlsx(input, snapshot));
  const after = anchorFor(output, "keep_shape");
  expect(after.from).toMatchObject({ col: "3", row: "10" });
  expect(after.to).toMatchObject({ col: "5", row: "13", colOff: "209550", rowOff: "95250" });
  expect(after.sp.spPr.xfrm.ext).toMatchObject({ "@_cx": "1428750", "@_cy": "666750" });
  delete before.sp.spPr.xfrm;
  delete after.sp.spPr.xfrm;
  expect(after.sp).toEqual(before.sp);
});

test("existing shape style changes are rejected rather than losing original theme metadata", () => {
  const input = fixture();
  const { snapshot, sheet } = changedSheet(input);
  const objects = objectsOf(sheet);
  sheet.custom!.excelmanusObjects = {
    ...objects,
    shapes: objects.shapes!.map((shape) =>
      shape.id === "keep_shape" ? { ...shape, stroke: "#123456" } : shape,
    ),
  };
  expect(() => exportXlsx(input, snapshot)).toThrow("已有形状仅支持移动和缩放");
});

test("shape delete and undo preserve exact original anchors while a new right arrow roundtrips", () => {
  const input = fixture();
  const { snapshot, sheet } = changedSheet(input);
  const objects = objectsOf(sheet) as ReturnType<typeof objectsOf> & {
    shapes?: Array<Record<string, unknown>>;
  };
  expect(objects.shapes).toHaveLength(2);
  sheet.custom!.excelmanusObjects = {
    ...objects,
    shapes: [
      objects.shapes![0],
      {
        id: "arrow",
        type: "rightArrow",
        title: "流程箭头",
        text: "下一步",
        anchor: "B16",
        width: 180,
        height: 70,
        fill: "#FFD966",
        stroke: "#111111",
        textColor: "#222222",
      },
    ],
  };
  const bytes = exportXlsx(input, snapshot);
  const body = drawingXml(bytes);
  expect(anchorFor(body, "delete_shape")).toBeUndefined();
  expect(anchorFor(body, "arrow").sp.spPr.prstGeom["@_prst"]).toBe("rightArrow");
  const checkpoint = importXlsx(bytes, "drawing-objects.xlsx");
  const restored = drawingXml(exportXlsx(checkpoint, input.snapshot, snapshot));
  for (const node of elements(
    strFromU8(input.preservation!.parts[drawingPart]!),
    "xdr:twoCellAnchor",
  ))
    expect(restored).toContain(node.raw);
});

test("unknown and rotated shapes remain visible in the read-only drawing catalogue and unchanged on export", () => {
  const input = fixture((body) =>
    body
      .replace('<a:xfrm><a:off x="1219200"', '<a:xfrm rot="600000"><a:off x="1219200"')
      .replace(/(<xdr:cNvPr id="5"[\s\S]*?prst=")rect"/, '$1star5"'),
  );
  const catalog = preservedMetadata(input.preservation!.parts) as ReturnType<
    typeof preservedMetadata
  > & { drawings?: Array<{ objects: Array<Record<string, unknown>> }> };
  expect(catalog.drawings?.flatMap((drawing) => drawing.objects)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "keep_shape", kind: "shape", editable: false }),
      expect.objectContaining({ id: "delete_shape", kind: "shape", editable: false }),
    ]),
  );
  const { snapshot, sheet } = changedSheet(input);
  sheet.cellData![0]![0]!.v = "只改单元格";
  expect(unzipSync(exportXlsx(input, snapshot))[drawingPart]).toEqual(
    input.preservation!.parts[drawingPart],
  );
});

test.each(["<a:gradFill/>", '<a:effectLst><a:outerShdw blurRad="1000"/></a:effectLst>'])(
  "a shape with unsupported appearance %s is preserved and catalogued as read-only",
  (appearance) => {
    const input = fixture((body) =>
      body.replace('<a:solidFill><a:srgbClr val="D9EAD3"/></a:solidFill>', appearance),
    );
    const sheet = input.snapshot.sheets[input.snapshot.sheetOrder[0]!]!;
    expect(objectsOf(sheet).shapes?.some((shape) => shape.id === "keep_shape")).toBe(false);
    expect(preservedMetadata(input.preservation!.parts).drawings[0]?.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "keep_shape",
          editable: false,
          reason: expect.any(String),
        }),
      ]),
    );
    const { snapshot, sheet: next } = changedSheet(input);
    next.cellData![0]![0]!.v = "保留复杂外观";
    expect(unzipSync(exportXlsx(input, snapshot))[drawingPart]).toEqual(
      input.preservation!.parts[drawingPart],
    );
  },
);

test("a foreign-namespace sp is preserved instead of being imported as an editable shape", () => {
  const input = fixture((body) =>
    body
      .replace("<xdr:sp macro=", '<f:sp xmlns:f="urn:foreign" macro=')
      .replace("</xdr:sp>", "</f:sp>"),
  );
  const sheet = input.snapshot.sheets[input.snapshot.sheetOrder[0]!]!;
  expect(objectsOf(sheet).shapes?.some((shape) => shape.id === "keep_shape")).toBe(false);
  expect(preservedMetadata(input.preservation!.parts).drawings[0]?.objects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "keep_shape",
        editable: false,
        reason: expect.any(String),
      }),
    ]),
  );
  const { snapshot, sheet: next } = changedSheet(input);
  next.cellData![0]![0]!.v = "只改单元格";
  expect(unzipSync(exportXlsx(input, snapshot))[drawingPart]).toEqual(
    input.preservation!.parts[drawingPart],
  );
});

test("uninterpreted image extension metadata stays visible and byte-identical during a move", () => {
  const extension =
    '<a:extLst><a:ext uri="{28A0092B-C50C-407E-A947-70E740481C1C}"><a14:useLocalDpi xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" val="0"/></a:ext></a:extLst>';
  const input = fixture((body) =>
    body.replace(/(<a:blip\b[^>]+r:embed="rId1")\/>/, `$1>${extension}</a:blip>`),
  );
  const { snapshot, sheet } = changedSheet(input);
  const objects = objectsOf(sheet);
  expect(objects.images).toHaveLength(2);
  sheet.custom!.excelmanusObjects = {
    ...objects,
    images: objects.images.map((image) =>
      image.id === "keep_image" ? { ...image, anchor: "D5" } : image,
    ),
  };
  const body = drawingXml(exportXlsx(input, snapshot));
  expect(body).toContain(extension);
  expect(anchorFor(body, "keep_image").from.col).toBe("3");
});

test("drawing import keeps the existing DTD rejection boundary even without entity references", () => {
  expect(() =>
    fixture((body) => body.replace("<xdr:wsDr ", "<!DOCTYPE xdr:wsDr><xdr:wsDr ")),
  ).toThrow(/DTD|实体/);
});

test("new drawings precede existing legacy drawings, tables and extensions without reordering their bytes", () => {
  const base = importCsv(new TextEncoder().encode("Item,Amount\nA,2"), "ordered.csv").snapshot;
  const sid = base.sheetOrder[0]!;
  base.sheets[sid]!.custom = {
    excelmanusObjects: {
      charts: [],
      images: [],
      notes: [{ ref: "A1", text: "原批注", author: "原作者" }],
    },
  };
  const parts = unzipSync(minimalXlsx(base));
  const sheetPart = "xl/worksheets/sheet1.xml";
  const relPart = "xl/worksheets/_rels/sheet1.xml.rels";
  parts["xl/tables/ordered-table.xml"] = strToU8(
    '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="OrderedTable" displayName="OrderedTable" ref="A1:B2" totalsRowShown="0"><autoFilter ref="A1:B2"/><tableColumns count="2"><tableColumn id="1" name="Item"/><tableColumn id="2" name="Amount"/></tableColumns></table>',
  );
  parts[relPart] = strToU8(
    strFromU8(parts[relPart]!).replace(
      "</Relationships>",
      '<Relationship Id="rIdTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/ordered-table.xml"/></Relationships>',
    ),
  );
  parts["[Content_Types].xml"] = strToU8(
    strFromU8(parts["[Content_Types].xml"]!).replace(
      "</Types>",
      '<Override PartName="/xl/tables/ordered-table.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>',
    ),
  );
  const source = strFromU8(parts[sheetPart]!).replace(
    "</worksheet>",
    '<tableParts count="1"><tablePart r:id="rIdTable"/></tableParts><extLst><ext uri="urn:keep"><u:metadata xmlns:u="urn:keep" value="untouched"/></ext></extLst></worksheet>',
  );
  parts[sheetPart] = strToU8(source);
  const input = importXlsx(zipSync(parts), "ordered.xlsx");
  const { snapshot, sheet } = changedSheet(input);
  sheet.custom!.excelmanusObjects = {
    ...objectsOf(sheet),
    shapes: [
      {
        id: "new_shape",
        title: "新增",
        text: "流程",
        type: "rect",
        anchor: "D4",
        width: 120,
        height: 60,
      },
    ],
  };
  const output = unzipSync(exportXlsx(input, snapshot));
  const body = strFromU8(output[sheetPart]!);
  const drawing = elements(body, "drawing")[0]!;
  expect(drawing.start).toBeLessThan(elements(body, "legacyDrawing")[0]!.start);
  expect(drawing.start).toBeLessThan(elements(body, "tableParts")[0]!.start);
  expect(drawing.start).toBeLessThan(elements(body, "extLst")[0]!.start);
  expect(body.replace(drawing.raw, "")).toBe(source);
  expect(output["xl/tables/ordered-table.xml"]).toEqual(parts["xl/tables/ordered-table.xml"]);
});

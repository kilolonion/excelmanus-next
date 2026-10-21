// 技能导入解压上限（P1-45，12 §1.5）：高压缩比压缩包在解压前被拒绝；子路径外的条目不解压。
import { zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { importSkills, SkillImportError, unzipCapped } from "../src/import.ts";

const MB = 1024 * 1024;
const skillMd = new TextEncoder().encode("---\nname: demo\ndescription: 示例\n---\n正文\n");

describe("GitHub 技能导入解压上限", () => {
  test("zip 炸弹：压缩后很小、解压总量超过上限 → 拒绝", () => {
    const zero = new Uint8Array(15 * MB);
    const files: Record<string, Uint8Array> = { "repo-main/SKILL.md": skillMd };
    for (let i = 0; i < 5; i++) files[`repo-main/pad${i}.bin`] = zero;
    const zip = zipSync(files, { level: 9 });
    expect(zip.length).toBeLessThan(1 * MB);
    expect(() => unzipCapped(zip)).toThrow(SkillImportError);
    expect(() => unzipCapped(zip)).toThrow(/解压后总大小超过/);
  });

  test("单条目超过 20MB → 拒绝；子路径之外的大条目不计入", () => {
    const big = new Uint8Array(21 * MB);
    const zip = zipSync({ "repo-main/a/SKILL.md": skillMd, "repo-main/b/huge.bin": big });
    expect(() => unzipCapped(zip)).toThrow(/文件过大/);
    const out = unzipCapped(zip, "a");
    expect(Object.keys(out)).toEqual(["repo-main/a/SKILL.md"]);
  });

  test("分块下载（无 content-length）超过 20MB 时边读边中止", async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent > 40 * MB) return c.close();
        sent += MB;
        c.enqueue(new Uint8Array(MB));
      },
    });
    const fetchImpl = (async () => new Response(body)) as unknown as typeof fetch;
    await expect(
      importSkills({
        source: "https://github.com/o/r",
        userDir: "/tmp/excelmanus-fix-models-ext-desktop-unused",
        preview: true,
        fetchImpl,
      }),
    ).rejects.toThrow(/压缩包超过 20MB/);
    expect(sent).toBeLessThanOrEqual(22 * MB);
  });

  test("正常仓库可预览", async () => {
    const zip = zipSync({ "repo-main/SKILL.md": skillMd, "repo-main/ref.md": skillMd });
    const fetchImpl = (async () => new Response(zip)) as unknown as typeof fetch;
    const skills = await importSkills({
      source: "https://github.com/o/r",
      userDir: "/tmp/excelmanus-fix-models-ext-desktop-unused",
      preview: true,
      fetchImpl,
    });
    expect(skills.map((s) => s.name)).toEqual(["demo"]);
  });
});

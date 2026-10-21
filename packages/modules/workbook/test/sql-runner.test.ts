import { expect, test } from "vitest";
import { runSql } from "../src/sql-runner.ts";

test("SQL 独立进程跨表连接、只读与硬超时", async () => {
  const tables = [
    {
      name: "data",
      columns: ["id", "amount"],
      rows: [
        [1, 10],
        [2, 20],
      ],
    },
    {
      name: "other",
      columns: ["id", "label"],
      rows: [
        [1, "A"],
        [2, "B"],
      ],
    },
  ];
  const result = await runSql(
    tables,
    "SELECT label,amount FROM data JOIN other USING(id) ORDER BY amount",
  );
  expect(result.rows).toEqual([
    { label: "A", amount: 10 },
    { label: "B", amount: 20 },
  ]);
  expect((await runSql(tables, "SELECT amount FROM data WHERE 0")).columns).toEqual(["amount"]);
  await expect(runSql(tables, "DELETE FROM data RETURNING *")).rejects.toThrow();
  await expect(
    runSql(
      [],
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n",
      undefined,
      500,
    ),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
  expect((await runSql(tables, "SELECT SUM(amount) AS total FROM data")).rows).toEqual([
    { total: 30 },
  ]);
}, 10000);

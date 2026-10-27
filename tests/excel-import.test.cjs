const test = require("node:test");
const assert = require("node:assert/strict");
const BoardExcel = require("../excel-import.js");

test("imports CSV courses with quoted commas and configured period times", () => {
  const times = { "1-2": { start: "08:20", end: "10:00" } };
  const result = BoardExcel.readText(
    '课程,星期,节次,教室,周次,单双周\n"高等数学,上",周一,1-2,A101,1-16,每周',
    times
  );
  assert.equal(result.schedule[0].course, "高等数学,上");
  assert.equal(result.schedule[0].weekday, 1);
  assert.equal(result.schedule[0].start, "08:20");
  assert.equal(result.schedule[0].end, "10:00");
});

test("imports TSV materials and deduplicates repeated books", () => {
  const result = BoardExcel.readText(
    "课程\t教材\n每天\t水杯\n人工智能\t\"书,册\"\n人工智能\t\"书,册\"",
    {},
    "items"
  );
  assert.deepEqual(result.items.daily, ["水杯"]);
  assert.deepEqual(result.items.byCourse["人工智能"], ["书,册"]);
});

test("imports dated plan suggestions", () => {
  const result = BoardExcel.readText("日期,待办\n2026-10-24,整理书包", {}, "plan");
  assert.deepEqual(result.plan.days["2026-10-24"], ["整理书包"]);
});

test("rejects malformed quoted CSV instead of silently truncating it", () => {
  assert.throws(
    () => BoardExcel.parseDelimitedRows('课程,教材\n"未闭合,内容'),
    /未闭合/
  );
});

test("normalizes common period wrappers", () => {
  assert.equal(BoardExcel.periods("一[3-4节]"), "3-4");
  assert.equal(BoardExcel.periods("第3-4节"), "3-4");
  assert.equal(BoardExcel.periods("[3-4]"), "3-4");
  assert.equal(BoardExcel.periods("周二【3—4节】"), "3-4");
});

test("keeps a valid concrete course date", () => {
  const result = BoardExcel.readText("课程,日期,节次,教室\n人工智能,2026-10-27,3-4,A316");
  assert.equal(result.schedule[0].date, "2026-10-27");
});

test("rejects invalid course and plan dates", () => {
  for (const day of ["2026-02-30", "2026-13-01", "2026/10/27"]) {
    assert.equal(BoardExcel.validDate(day), false);
    assert.throws(() => BoardExcel.readText(`课程,日期,节次,教室\n人工智能,${day},3-4,A316`), /有效的 YYYY-MM-DD/);
    assert.throws(() => BoardExcel.readText(`日期,待办\n${day},整理书包`, {}, "plan"), /有效的 YYYY-MM-DD/);
  }
});

test("rejects multiple period ranges and reversed times", () => {
  for (const ranges of ["1-2;3-4", "1-2,3-4"]) {
    assert.throws(
      () => BoardExcel.readText(`课程,星期,节次,开始时间,结束时间,教室,周次\n人工智能,周一,"${ranges}",08:20,10:00,A316,1-16`),
      /节次应为/
    );
  }
  assert.throws(
    () => BoardExcel.readText("课程,星期,节次,开始时间,结束时间,教室,周次\n人工智能,周一,1-2,10:00,08:20,A316,1-16"),
    /结束时间应晚于开始时间/
  );
});

test("parses ranges with odd and even week markers", () => {
  assert.deepEqual(BoardExcel.parseWeeks("5-9 单"), { weeks: "5-9", weekType: "odd" });
  assert.deepEqual(BoardExcel.parseWeeks("14-16 双"), { weeks: "14-16", weekType: "even" });
  assert.deepEqual(BoardExcel.parseWeeks("1-8,10-16"), { weeks: "1-8,10-16", weekType: "all" });
});

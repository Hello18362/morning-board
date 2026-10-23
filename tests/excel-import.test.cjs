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

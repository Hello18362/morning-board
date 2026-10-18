// Excel 只在本机解析，不上传。先返回数据，确认保存由 app.js 负责。
(function (root) {
  "use strict";
  const text = value => String(value ?? "").trim();
  const clean = value => text(value).replace(/\s+/g, "");
  function periods(value) {
    return clean(value).replace(/[–—~～至]/g, "-").replace(/^[第\[]|[节\]]$/g, "");
  }
  function clock(value) {
    const s = text(value).replace("：", ":");
    const m = s.match(/^(\d{1,2}):(\d{2})(?::00)?$/);
    if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`时间“${s}”应为 HH:MM。`);
    return m[1].padStart(2, "0") + ":" + m[2];
  }
  // parseWeeks("5-9 单") → { weeks: "5-9", weekType: "odd" }
  function parseWeeks(value, type = "") {
    let s = clean(value).replace(/[，、]/g, ",").replace(/[–—~～至]/g, "-");
    const marker = clean(type) || (s.includes("单") ? "odd" : s.includes("双") ? "even" : "all");
    const weekType = ({ "单": "odd", "单周": "odd", "双": "even", "双周": "even", "每周": "all", "全部": "all" })[marker] || marker;
    if (!["all", "odd", "even"].includes(weekType)) throw new Error("单双周应为 单周、双周 或 每周。");
    if ((s.includes("单") && weekType !== "odd") || (s.includes("双") && weekType !== "even")) throw new Error("周次与单双周标记矛盾。");
    s = s.replace(/[第周单双()（）]/g, "");
    if (!s || !s.split(",").every(part => {
      const m = part.match(/^(\d+)(?:-(\d+))?$/);
      return m && +m[1] >= 1 && +(m[2] || m[1]) >= +m[1];
    })) throw new Error(`周次“${value}”无法识别，请用 1-8,10-16。`);
    return { weeks: s, weekType };
  }
  function weekday(value) {
    const s = clean(value).replace(/星期|周|礼拜/g, "");
    const day = ({ "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7 })[s] || Number(s);
    if (!Number.isInteger(day) || day < 1 || day > 7) throw new Error("星期应为周一到周日或 1 到 7。");
    return day;
  }
  function withTimes(course, start, end, times) {
    if (text(start) || text(end)) return { ...course, start: clock(start), end: clock(end) };
    const known = times[course.periods];
    if (known) return { ...course, start: clock(known.start), end: clock(known.end) };
    if (!/^\d+(?:-\d+)?$/.test(course.periods || "")) throw new Error("请提供起止时间，或有效节次。");
    return { ...course, start: "", end: "" }; // 不猜晚课钟点。
  }
  const aliases = {
    course: ["课程", "课程名", "课程名称", "course"], date: ["日期", "上课日期", "date"],
    weekday: ["星期", "周几", "weekday"], periods: ["节次", "periods"],
    start: ["开始时间", "开始", "start"], end: ["结束时间", "结束", "end"],
    room: ["教室", "上课地点", "地点", "room"], weeks: ["周次", "周次范围", "weeks"],
    weekType: ["单双周", "weekType"], book: ["教材", "教材名", "物品", "book"],
    task: ["待办", "待办事项", "task"]
  };
  function columns(row) {
    const result = {};
    for (const [key, names] of Object.entries(aliases)) {
      const index = row.findIndex(value => names.includes(clean(value)));
      if (index >= 0) result[key] = index;
    }
    return result;
  }
  function kindOf(c) {
    if (c.course !== undefined && (c.weekday !== undefined || c.date !== undefined) && c.room !== undefined) return "schedule";
    if (c.book !== undefined && c.course !== undefined) return "items";
    if (c.task !== undefined && c.date !== undefined) return "plan";
    return "";
  }
  // 每行一条数据；有内容但无效的行报错，绝不悄悄丢掉。
  function parseRows(rows, times = {}, type = "auto") {
    const header = rows.findIndex(row => kindOf(columns(row)));
    if (header < 0) return null;
    const c = columns(rows[header]), kind = kindOf(c);
    if (type !== "auto" && type !== kind) return null;
    const data = kind === "schedule" ? [] : kind === "items" ? { daily: [], byCourse: Object.create(null) } : { days: Object.create(null) };
    for (let i = header + 1; i < rows.length; i++) {
      if (!rows[i].some(value => text(value))) continue;
      const get = key => text(rows[i][c[key]]);
      try {
        if (kind === "schedule") {
          if (!get("course") || !get("room")) throw new Error("缺少课程名或教室。");
          const course = { course: get("course"), room: get("room"), periods: periods(get("periods")) };
          if (get("date")) course.date = get("date");
          else Object.assign(course, { weekday: weekday(get("weekday")) }, parseWeeks(get("weeks"), get("weekType")));
          data.push(withTimes(course, get("start"), get("end"), times));
        } else if (kind === "items") {
          const name = get("book"), course = get("course");
          if (!name || !course) throw new Error("请填写课程和教材；日常物品的课程填“每天”。");
          const target = ["每天", "日常"].includes(course) ? data.daily : (data.byCourse[course] ||= []);
          if (!target.includes(name)) target.push(name);
        } else {
          if (!get("date") || !get("task")) throw new Error("请填写日期和待办。");
          (data.days[get("date")] ||= []).push(get("task"));
        }
      } catch (error) { throw new Error(`第 ${i + 1} 行：${error.message}`); }
    }
    if (kind === "schedule" && !data.length) throw new Error("课程表没有数据行；如要清空请用 JSON 明确导入空数组。");
    return { [kind]: data };
  }
  function nodeText(node) {
    if (node.nodeType === 3) return node.textContent;
    if (["SCRIPT", "STYLE", "IFRAME"].includes(node.nodeName)) return "";
    if (node.nodeName === "BR") return "\n";
    return [...node.childNodes].map(nodeText).join("");
  }
  // 识别教务导出的 HTML 型 .xls；惰性 template 不挂到页面，不执行其中的代码。
  function parseHtml(html, times = {}) {
    const template = document.createElement("template");
    template.innerHTML = html;
    const cells = [...template.content.querySelectorAll("div[id]")].filter(cell => /^k[1-7]\d+$/.test(cell.id));
    if (!cells.length) return null;
    const schedule = [];
    for (const cell of cells) {
      const day = Number(cell.id[1]);
      const blocks = [...cell.querySelectorAll(".xkinfo > div")];
      if (!blocks.length && nodeText(cell).trim()) throw new Error(`${cell.id} 单元格的课程格式不受支持，未导入。`);
      for (const block of blocks) {
        const lines = nodeText(block).split(/\n/).map(text).filter(Boolean);
        if (!lines.length) continue;
        const course = text(block.querySelector("font")?.textContent);
        const index = lines.findIndex(line => /\[\s*\d+(?:\s*-\s*\d+)?\s*\]/.test(line));
        const m = lines[index]?.match(/^(.*?)\[\s*(\d+(?:\s*-\s*\d+)?)\s*\]$/);
        if (!course || !m || index !== lines.length - 2) throw new Error(`“${course || cell.id}”的周次、节次或教室无法识别。`);
        schedule.push(withTimes({ course, weekday: day, periods: periods(m[2]), room: lines[index + 1], ...parseWeeks(m[1]) }, "", "", times));
      }
    }
    if (!schedule.length) throw new Error("没有找到课程内容。");
    return { schedule };
  }
  function readFile(buffer, XLSX, times = {}, type = "auto") {
    const bytes = new Uint8Array(buffer);
    const prefix = new TextDecoder().decode(bytes.slice(0, 512)).replace(/^\uFEFF/, "");
    if (/^\s*</.test(prefix)) {
      if (!["auto", "schedule"].includes(type)) throw new Error("这是课表文件，请选择“自动识别”或“课程”。");
      const charset = prefix.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || "utf-8";
      const result = parseHtml(new TextDecoder(charset).decode(bytes), times);
      if (result) return result;
    }
    if (!XLSX) throw new Error("Excel 解析组件未加载，请刷新或重新安装完整更新包。");
    let book;
    try { book = XLSX.read(buffer, { type: "array", cellHTML: false, cellFormula: false, cellNF: true, sheetRows: 5002 }); }
    catch { throw new Error("无法读取此表格。请检查是否损坏或加密；也可使用填写模板。"); }
    if (book.SheetNames.length > 12) throw new Error("工作表超过 12 张，请只保留要导入的表。");
    const result = {};
    for (const name of book.SheetNames) {
      const sheet = book.Sheets[name];
      const range = sheet["!fullref"] || sheet["!ref"];
      const end = range ? XLSX.utils.decode_range(range).e : { r: 0, c: 0 };
      if (end.r > 5000 || end.c > 99) throw new Error(`“${name}”超过 5000 行或 100 列，请拆分后导入。`);
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "", blankrows: true, range: { s: { r: 0, c: 0 }, e: end } });
      // Excel 日期按日历值转换，不将当地午夜转成 UTC 后错一天。
      const header = rows.findIndex(row => kindOf(columns(row)));
      const dateColumn = header < 0 ? undefined : columns(rows[header]).date;
      if (dateColumn !== undefined) {
        for (let r = header + 1; r < rows.length; r++) {
          const cell = sheet[XLSX.utils.encode_cell({ r, c: dateColumn })];
          if (cell?.t !== "n" || !XLSX.SSF.is_date(cell.z || "")) continue;
          const d = XLSX.SSF.parse_date_code(cell.v, { date1904: Boolean(book.Workbook?.WBProps?.date1904) });
          if (d) rows[r][dateColumn] = `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
        }
      }
      const parsed = parseRows(rows, times, type);
      if (!parsed) {
        if (type !== "auto" && rows.some(row => kindOf(columns(row)))) continue;
        if (rows.some(row => row.some(value => text(value)))) throw new Error(`“${name}”格式无法识别。请使用行式 Excel 模板，或删除不需要的工作表。`);
        continue;
      }
      for (const key of Object.keys(parsed)) {
        if (key in result) throw new Error(`多个工作表都是“${key}”类型，请合到一张表后重试。`);
        result[key] = parsed[key];
      }
    }
    if (!Object.keys(result).length) throw new Error("未识别到数据，请使用行式 Excel 模板。");
    return result;
  }
  root.BoardExcel = { parseWeeks, parseRows, parseHtml, readFile };
  if (typeof module !== "undefined") module.exports = root.BoardExcel;
})(typeof window === "undefined" ? globalThis : window);
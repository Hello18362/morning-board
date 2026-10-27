// JSON 是个人资料来源；课程日期和物品汇总都由下面的小函数处理。
const $ = (selector) => document.querySelector(selector);

async function readJSON(name) {
  // 本机导入优先；即使默认 JSON 请求失败，也不丢掉已导入的数据。
  if (["schedule", "items", "plan"].includes(name)) {
    const imported = readStored("morning-board:imported-data", null);
    if (imported && imported[name] !== undefined) return imported[name];
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`data/${name}.json`, { signal: controller.signal, cache: "no-cache" });
    if (!response.ok) throw new Error(`${name}.json 读取失败（${response.status}）`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// 用 UTC 日序相减，避免时区和夏令时导致跨日误差；非法日期返回 NaN。
function dayNumber(key) {
  if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return NaN;
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN;
  return date.getTime() / 86400000;
}

// 兼容原来的循环课表：开学前返回 0，每连续7天算一周。
// 示例：semesterWeek("2026-09-08", "2026-09-01") → 2。
function semesterWeek(day, semesterStart) {
  const difference = dayNumber(day) - dayNumber(semesterStart);
  return !Number.isFinite(difference) || difference < 0 ? 0 : Math.floor(difference / 7) + 1;
}

// 学期开始日未确认时，使用文件明确给出的“某日为第几周”校准。
// 示例：参考 2026-10-12 为第6周，则 2026-10-19 为第7周；不代表第7周课表已录入。
function weekForDay(day, config) {
  if (config.semesterStart) return semesterWeek(day, config.semesterStart);
  const reference = config.weekReference;
  const difference = dayNumber(day) - dayNumber(reference?.date);
  if (!Number.isFinite(difference) || !Number.isInteger(reference?.week) || reference.week < 1) return 0;
  return Math.max(0, reference.week + Math.floor(difference / 7));
}

// 日期独立计算：shiftDay("2026-10-31", 1) → "2026-11-01"，不受夏令时影响。
function shiftDay(day, offset) {
  const number = dayNumber(day);
  if (!Number.isFinite(number) || !Number.isInteger(offset)) return "";
  return new Date((number + offset) * 86400000).toISOString().slice(0, 10);
}

function weekdayNumber(dateKeyValue) {
  const [year, month, day] = dateKeyValue.split("-").map(Number);
  return new Date(year, month - 1, day, 12).getDay() || 7;
}

function isInWeekRange(week, ranges) {
  if (!Number.isInteger(week) || week < 1 || typeof ranges !== "string") return false;
  return ranges.split(",").some((part) => {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) return false;
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    return first <= last && week >= first && week <= last;
  });
}

function isCourseOnDay(course, day, week) {
  // 带具体日期的导入课表按日期匹配，不重复到下一周。
  if (course.date) return course.date === day;
  if (Number(course.weekday) !== weekdayNumber(day) || !isInWeekRange(week, course.weeks)) return false;
  return course.weekType === "all" ||
    (course.weekType === "odd" && week % 2 === 1) ||
    (course.weekType === "even" && week % 2 === 0);
}

function applyPeriodTimes(schedule, periodTimes = {}) {
  return schedule.map((course) => {
    if (course.start && course.end) return course;
    const known = periodTimes[course.periods];
    return known ? { ...course, start: known.start, end: known.end } : course;
  });
}

function coursesForDay(schedule, day, week) {
  const courses = schedule.filter((course) => isCourseOnDay(course, day, week));
  const byPeriods = courses.some(c => !c.start) && courses.every(c => /^\d+(?:-\d+)?$/.test(c.periods || ""));
  return courses.sort((a, b) => byPeriods ? Number(a.periods.split("-")[0]) - Number(b.periods.split("-")[0]) :
    (a.start || "99:99").localeCompare(b.start || "99:99"));
}

function itemsForCourses(items, courses) {
  const names = [...items.daily];
  for (const course of courses) names.push(...(items.byCourse[course.course] || []));
  return [...new Set(names)];
}

// scheduleDates 记录已核对的日期；缺失日期不能解释为“没有课”。
function hasScheduleForDay(schedule, day, config) {
  if (schedule.some((course) => course.date === day)) return true;
  if (schedule.some((course) => !course.date)) return true;
  if (Array.isArray(config.scheduleDates)) return config.scheduleDates.includes(day);
  // 没有日期元数据时仍兼容最初的每周循环课表格式。
  return !schedule.some((course) => course.date);
}

function itemNotesForCourses(items, courses) {
  return [...new Set(courses.map((course) => {
    const note = items.notesByCourse?.[course.course];
    return note ? `${course.course}：${note}` : "";
  }).filter(Boolean))];
}

function renderItemNotes(notes, known) {
  if (!known) notes = ["尚未录入当天课表，无法确定课程所需物品。"];
  $("#item-notes").replaceChildren(...notes.map((note) => element("li", "item-note", note)));
}

function isCourseEnded(course, now, day) {
  return dateKey(now) > day || (dateKey(now) === day && Boolean(course.end) && now.toTimeString().slice(0, 5) >= course.end);
}

function formatDate(dateKeyValue) {
  const [year, month, day] = dateKeyValue.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  return `${year}年${month}月${day}日 · 星期${"日一二三四五六"[date.getDay()]}`;
}

function renderCourses(courses, now, day, known = true, items = {}) {
  const rows = courses.map((course) => {
    const row = element("li", "course");
    if (isCourseEnded(course, now, day)) row.classList.add("is-ended");
    const time = element("div", "course-time", course.start || `${course.periods}节`);
    time.dataset.start = course.start || "";
    time.dataset.end = course.end || "";
    time.append(element("span", "", course.end || `第 ${course.periods} 节`));
    const details = element("div");
    details.append(element("p", "course-name", course.course));
    details.append(element("p", "course-room", `${course.periods ? `第 ${course.periods} 节 · ` : ""}${course.room}`));
    const books = items.byCourse?.[course.course] || [];
    if (books.length) details.append(element("p", "course-materials", `\u5E26\uFF1A${books.join("\u3001")}`));
    row.append(time, details);
    return row;
  });
  $("#courses").replaceChildren(...rows);
  if (!rows.length) $("#courses").append(element("li", "empty", known ? (day === dateKey(now) ? "今天没有课" : "当天没有课") : "尚未录入当天课表"));
}

function storageKey(day, section) {
  return `morning-board:${day}:${section}`;
}

function readStored(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved === null ? fallback : JSON.parse(saved);
  } catch (error) {
    console.warn("读取本地进度失败：", error);
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn("保存本地进度失败：", error);
    $("#status").textContent = "浏览器暂不允许本地保存，当前勾选在刷新后不会保留。";
    return false;
  }
}

function renderItems(names, day, known = true) {
  const key = storageKey(day, "items");
  const saved = readStored(key, {});
  const checked = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const rows = names.map((name) => {
    const row = element("li");
    const label = element("label", `check-label${checked[name] ? " is-done" : ""}`);
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(checked[name]);
    checkbox.addEventListener("change", () => {
      checked[name] = checkbox.checked;
      label.classList.toggle("is-done", checkbox.checked);
      writeStored(key, checked);
    });
    label.append(checkbox, element("span", "", name));
    row.append(label);
    return row;
  });
  $("#items").replaceChildren(...rows);
  if (!rows.length) $("#items").append(element("li", "empty", known ? "暂无已确认的物品" : "暂无当天课程物品清单"));
}

function renderTodos(suggestions, temporary, day) {
  const list = $("#todos");
  const suggestionKey = storageKey(day, "suggestions");
  const savedSuggestions = readStored(suggestionKey, {});
  const doneSuggestions = savedSuggestions && typeof savedSuggestions === "object" && !Array.isArray(savedSuggestions)
    ? savedSuggestions : {};
  const rows = [];

  if (boardData?.failures?.plan) {
    rows.push(element("li", "empty", "建议读取失败；仍可添加本机待办。"));
  } else if (!suggestions.length && !temporary.length) {
    rows.push(element("li", "empty", day === dateKey(new Date()) ? "今天还没有建议，可以自己添加" : "当天还没有建议，可以自己添加"));
  }
  suggestions.forEach((text, index) => {
    const id = `${index}:${text}`;
    const row = element("li", "todo-row");
    const label = element("label", `check-label${doneSuggestions[id] ? " is-done" : ""}`);
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(doneSuggestions[id]);
    checkbox.addEventListener("change", () => {
      doneSuggestions[id] = checkbox.checked;
      label.classList.toggle("is-done", checkbox.checked);
      writeStored(suggestionKey, doneSuggestions);
    });
    label.append(checkbox, element("span", "", text));
    row.append(label);
    rows.push(row);
  });

  temporary.forEach((task) => {
    const row = element("li", "todo-row temporary-task");
    const label = element("label", `check-label${task.done ? " is-done" : ""}`);
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(task.done);
    checkbox.addEventListener("change", () => {
      task.done = checkbox.checked;
      label.classList.toggle("is-done", checkbox.checked);
      writeStored(storageKey(day, "temporary-todos"), temporary);
    });
    label.append(checkbox, element("span", "", task.text));
    const remove = element("button", "delete-todo", "删除");
    remove.type = "button";
    remove.setAttribute("aria-label", `删除临时待办：${task.text}`);
    remove.addEventListener("click", () => {
      temporary.splice(temporary.indexOf(task), 1);
      writeStored(storageKey(day, "temporary-todos"), temporary);
      renderTodos(suggestions, temporary, day);
    });
    row.append(label, remove);
    rows.push(row);
  });

  list.replaceChildren(...rows);
}

function initTemporaryTodos(day, suggestions) {
  const key = storageKey(day, "temporary-todos");
  const saved = readStored(key, []);
  const temporary = Array.isArray(saved) ? saved.filter((task) =>
    task && typeof task.text === "string" && task.text.trim()
  ).map((task) => ({ id: String(task.id || ""), text: task.text, done: Boolean(task.done) })) : [];
  let nextId = 0;
  const input = $("#todo-input");
  input.disabled = false;
  $("#todo-add-button").disabled = false;
  input.value = todoDrafts.get(day) || "";
  input.oninput = () => todoDrafts.set(day, input.value);
  input.onkeydown = (event) => {
    // 输入法回车只确认选词，不提前提交待办。
    if (event.key === "Enter" && event.isComposing) event.preventDefault();
  };
  // 覆盖同一个入口，切日期或重新导入不会累积监听器。
  $("#todo-form").onsubmit = (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    temporary.push({ id: `${Date.now()}-${nextId++}`, text, done: false });
    writeStored(key, temporary);
    input.value = "";
    todoDrafts.delete(day);
    renderTodos(suggestions, temporary, day);
    input.focus();
  };
  renderTodos(suggestions, temporary, day);
}

const WEATHER_CACHE_KEY = "morning-board:weather-cache-v2";
const WEATHER_CACHE_MS = 60 * 60 * 1000;

function weatherText(code) {
  if (code === 0) return "晴";
  if ([1, 2].includes(code)) return "晴间多云";
  if (code === 3) return "阴";
  if ([45, 48].includes(code)) return "有雾";
  if ([51, 53, 55, 56, 57].includes(code)) return "毛毛雨";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "有雨";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "有雪";
  if ([95, 96, 99].includes(code)) return "雷雨";
  return "天气状况未知";
}

function validCoordinates(value) {
  return value && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 &&
    Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180;
}

function validWeather(value) {
  return value && typeof value.description === 'string' && Number.isFinite(value.high) &&
    Number.isFinite(value.low) && value.high >= value.low &&
    (value.precipitation === null || (Number.isFinite(value.precipitation) && value.precipitation >= 0 && value.precipitation <= 100));
}

function readWeatherCache(coordinates = null, now = Date.now()) {
  const cache = readStored(WEATHER_CACHE_KEY, null);
  if (!cache || !Number.isFinite(cache.savedAt) || cache.savedAt > now || now - cache.savedAt >= WEATHER_CACHE_MS ||
      cache.day !== dateKey(new Date(now)) || !validCoordinates(cache.coordinates) || !validWeather(cache.weather)) return null;
  if (coordinates && (cache.coordinates.latitude !== coordinates.latitude || cache.coordinates.longitude !== coordinates.longitude)) return null;
  return cache;
}

function showWeather(data, locationName, status) {
  $("#weather-description").textContent = data.description;
  $("#temperature-high").textContent = Number.isFinite(data.high) ? `${Math.round(data.high)}` : "--";
  $("#temperature-low").textContent = Number.isFinite(data.low) ? `${Math.round(data.low)}°` : "--°";
  $("#precipitation-probability").textContent = Number.isFinite(data.precipitation) ? `${Math.round(data.precipitation)}%` : "--%";
  $("#weather-location").textContent = locationName;
  $("#weather-help").textContent = status;
}

function explainWeatherError(error) {
  if (error?.name === "GeolocationPositionError" || [1, 2, 3].includes(error?.code)) {
    if (error.code === 1) return "定位权限被拒绝。请在浏览器网站设置中允许此网页使用位置信息，再点“重试”。";
    if (error.code === 2) return "暂时无法确定位置。请检查手机定位服务和网络后重试。";
    if (error.code === 3) return "定位超时。请稍后重试，或检查手机定位服务是否开启。";
  }
  if (error?.message === "INSECURE_ORIGIN") return "浏览器不允许此网址定位。手机请使用 HTTPS 网页地址；localhost 仅适用于本机调试。";
  if (error?.message === "WEATHER_TIMEOUT") return "天气服务响应超时。请检查网络后重试。";
  if (error?.message?.startsWith("WEATHER_HTTP_")) return `天气服务暂不可用（HTTP ${error.message.split("_").at(-1)}）。请稍后重试。`;
  if (error?.message === "WEATHER_INVALID_DATA") return "天气服务返回的数据不完整，请稍后重试。";
  if (error instanceof TypeError) return "无法连接天气服务。请检查网络，或确认当前网络可以访问 Open-Meteo 后重试。";
  return "天气暂不可用。请检查网络和定位权限后重试。";
}

function getDevicePosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("此浏览器不支持定位"));
    if (!window.isSecureContext) return reject(new Error("INSECURE_ORIGIN"));
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude }),
      reject,
      { enableHighAccuracy: false, timeout: 20000, maximumAge: 10 * 60 * 1000 }
    );
  });
}

async function requestWeather(latitude, longitude) {
  const params = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    forecast_days: "1", timezone: "auto"
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`WEATHER_HTTP_${response.status}`);
    const result = await response.json();
    const daily = result.daily;
    if (!daily?.time?.length || !Number.isFinite(daily.temperature_2m_max?.[0]) || !Number.isFinite(daily.temperature_2m_min?.[0])) {
      throw new Error("WEATHER_INVALID_DATA");
    }
    const weather = {
      description: weatherText(daily.weather_code?.[0]),
      high: daily.temperature_2m_max[0],
      low: daily.temperature_2m_min[0],
      precipitation: daily.precipitation_probability_max?.[0] ?? null
    };
    if (!validWeather(weather)) throw new Error("WEATHER_INVALID_DATA");
    return weather;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("WEATHER_TIMEOUT");
    throw error;
  } finally { clearTimeout(timer); }
}

const WEATHER_LOCATION_KEY = "morning-board:weather-location";
let stopWeather = () => {};

async function initWeather(config) {
  stopWeather();
  const button = $("#weather-button");
  const savedLocation = readStored(WEATHER_LOCATION_KEY, null);
  const previous = readStored(WEATHER_CACHE_KEY, null);
  const configured = validCoordinates(config);
  let coordinates = configured ? { latitude: config.latitude, longitude: config.longitude } :
    validCoordinates(savedLocation) ? savedLocation : validCoordinates(previous?.coordinates) ? previous.coordinates : null;
  let cache = readWeatherCache(coordinates);
  let disposed = false, busy = false;
  function buttons() {
    button.disabled = busy;
    button.textContent = busy ? "正在查询…" : coordinates ? "刷新天气" : "定位并查询";
  }
  buttons();
  if (cache) showWeather(cache.weather, cache.location, "显示1小时内缓存；点刷新可重新定位查询");

  async function refresh(locate = false) {
    if (busy || disposed) return;
    busy = true;
    buttons();
    $("#weather-help").textContent = !coordinates || locate ? "正在请求设备定位…" : "正在连接天气服务…";
    try {
      if (!coordinates || (locate && !configured)) {
        const position = await getDevicePosition();
        if (disposed) return;
        coordinates = position;
        try { localStorage.setItem(WEATHER_LOCATION_KEY, JSON.stringify(position)); } catch { /* 本次查询仍可继续 */ }
      }
      const weather = await requestWeather(coordinates.latitude, coordinates.longitude);
      if (disposed) return;
      const location = configured ? config.city || "配置的位置" : locate ? "当前位置" : "上次定位的位置";
      cache = { savedAt: Date.now(), day: dateKey(new Date()), location, coordinates, weather };
      try { localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify(cache)); } catch { /* 存储不可用仍显示本次结果 */ }
      showWeather(weather, location, "天气已更新 · 缓存1小时 · 点刷新可重新定位");
    } catch (error) {
      if (disposed) return;
      if (cache && cache.day === dateKey(new Date()) && validWeather(cache.weather)) {
        const time = new Date(cache.savedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
        showWeather(cache.weather, cache.location, `${explainWeatherError(error)} 显示 ${time} 获取的天气，尚未更新。`);
      } else {
        showWeather({ description: "天气暂不可用", high: null, low: null, precipitation: null }, coordinates ? "天气查询失败" : "尚未获取位置", explainWeatherError(error));
      }
    } finally {
      busy = false;
      if (!disposed) buttons();
    }
  }
  button.onclick = () => refresh(true);
  const updateIfNeeded = () => {
    if (coordinates && !document.hidden && !readWeatherCache(coordinates)) refresh();
  };
  const timer = setInterval(updateIfNeeded, 60000);
  window.addEventListener("online", updateIfNeeded);
  document.addEventListener("visibilitychange", updateIfNeeded);
  stopWeather = () => {
    disposed = true;
    clearInterval(timer);
    window.removeEventListener("online", updateIfNeeded);
    document.removeEventListener("visibilitychange", updateIfNeeded);
  };
  if (!cache) {
    if (coordinates) refresh();
    else {
      $("#weather-help").textContent = "请点“定位并查询”授权。网页使用设备位置查询天气，不读取设备天气应用。";
      try {
        const permission = await navigator.permissions.query({ name: "geolocation" });
        if (!disposed && permission.state === "granted") refresh(true);
      } catch { /* 部分浏览器没有权限查询接口，仍可点击定位 */ }
    }
  }
}
let boardData = null;
let selectedDay = "";
const todoDrafts = new Map();

// 切日期只重绘本地数据，不重新定位、不重查天气。
function renderSelectedDay(day) {
  if (!boardData || !Number.isFinite(dayNumber(day))) return;
  selectedDay = day;
  const { config, schedule, items, plan, imported } = boardData;
  const now = new Date();
  const today = dateKey(now);
  const label = day === today ? "今日" : day === shiftDay(today, 1) ? "明日" : "当日";
  const week = weekForDay(day, config);
  const coverage = imported?.schedule !== undefined ? { ...config, scheduleDates: undefined } : config;
  const known = !boardData.failures?.schedule && hasScheduleForDay(schedule, day, coverage);
  const courses = coursesForDay(applyPeriodTimes(schedule, config.periodTimes), day, week);
  $("#date-label").textContent = formatDate(day);
  $("#board-day").value = day;
  $("#today-button").disabled = day === today;
  $(".week-badge").textContent = week ? `第 ${week} 周 · ${week % 2 ? "单" : "双"}周` : "周次待确认";
  $("#status").textContent = imported?.schedule !== undefined ? "正在使用本机导入的课表" : config.scheduleLabel || "按所选日期显示课表";
  if (boardData.notices?.length) $("#status").textContent += ` · ${boardData.notices.join("；")}。请检查数据或重新导入，原本机记录未被清除。`;
  $("#schedule-status").textContent = known ? `${label} ${courses.length} 个上课时段` : "当天课表未录入";
  for (const [id, title] of [["courses-day-title", "课程"], ["items-day-title", "物品"], ["todos-day-title", "待办"]]) {
    $(`#${id}`).textContent = label + title;
  }
  $("#items-date-hint").textContent = "按所选日期课程汇总";
  $("#todo-input").placeholder = day === today ? "写件待办，回车或点添加" : `添加到 ${day.slice(5)} 的待办`;
  renderCourses(courses, now, day, known, items);
  renderItems(itemsForCourses(items, courses), day, known);
  renderItemNotes(itemNotesForCourses(items, courses), known);
  initTemporaryTodos(day, (plan.days[day] || []).slice(0, 3));
  if (boardData.failures?.schedule) {
    $("#schedule-status").textContent = "课表读取失败";
    $("#courses").replaceChildren(element("li", "empty", "课表暂不可用，请检查课程文件或重新导入。"));
  }
  if (boardData.failures?.items) $("#items").replaceChildren(element("li", "empty", "物品读取失败，请检查文件或重新导入。"));
}

function initDayNavigation() {
  $("#previous-day").onclick = () => renderSelectedDay(shiftDay(selectedDay, -1));
  $("#next-day").onclick = () => renderSelectedDay(shiftDay(selectedDay, 1));
  $("#today-button").onclick = () => renderSelectedDay(dateKey(new Date()));
  $("#board-day").onchange = (event) => {
    if (Number.isFinite(dayNumber(event.target.value))) renderSelectedDay(event.target.value);
    else event.target.value = selectedDay;
  };
  for (const control of document.querySelectorAll(".day-navigation button, .day-navigation input")) control.disabled = false;
}

// 各份数据独立加载；失败时保留本次会话最后的有效数据，不改写本机导入。
function validateData(name, data) {
  if (name !== "config") return validateImport({ [name]: data })[name];
  if (!isRecord(data)) throw new Error("config.json 应为对象");
  if (data.semesterStart && !Number.isFinite(dayNumber(data.semesterStart))) throw new Error("学期开始日期无效");
  if (data.periodTimes !== undefined && (!isRecord(data.periodTimes) || !Object.values(data.periodTimes).every(time =>
    isRecord(time) && [time.start, time.end].every(value => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) && time.start < time.end))) throw new Error("节次时间格式无效");
  return data;
}

async function showPreview() {
  $("#date-label").textContent = formatDate(selectedDay || dateKey(new Date()));
  const names = ["config", "schedule", "items", "plan"];
  const results = await Promise.allSettled(names.map(async name => validateData(name, await readJSON(name))));
  const defaults = { config: {}, schedule: [], items: { daily: [], byCourse: {} }, plan: { days: {} } };
  const next = { imported: readStored("morning-board:imported-data", null), failures: {}, notices: [] };
  results.forEach((result, index) => {
    const name = names[index];
    if (result.status === "fulfilled") next[name] = result.value;
    else {
      next[name] = boardData?.[name] || defaults[name];
      next.failures[name] = !boardData || Boolean(boardData.failures?.[name]);
      next.notices.push(`${name}.json 读取失败${next.failures[name] ? "" : "，保留上次数据"}`);
      console.error(`看板 ${name} 数据读取失败：`, result.reason);
    }
  });
  boardData = next;
  initDayNavigation();
  renderSelectedDay(selectedDay || dateKey(new Date()));
  initWeather(next.config).catch(error => console.error("天气初始化失败：", error));
}

// 导入先校验、预览，再由用户确认；失败或取消不会改动原数据。
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTextList(value) {
  return Array.isArray(value) && value.every((text) => typeof text === "string" && text.trim());
}

function validateImport(data) {
  if (!isRecord(data)) throw new Error("数据包必须是 JSON 对象。");
  const result = {};
  if ("schedule" in data) {
    if (!Array.isArray(data.schedule)) throw new Error("课程应是数组。");
    for (const [index, course] of data.schedule.entries()) {
      const fail = (message) => { throw new Error(`第 ${index + 1} 条课程：${message}`); };
      if (!isRecord(course) || !["course", "room"].every((key) => typeof course[key] === "string" && course[key].trim())) fail("需要课程名和教室。");
      const periodOnly = course.start === "" && course.end === "" && /^\d+(?:-\d+)?$/.test(course.periods || "");
      if (!periodOnly && (![course.start, course.end].every((time) => typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) || course.start >= course.end)) fail("时间用 HH:MM，结束应晚于开始；未知钟点时填写节次，start、end 均留空。");
      if (course.date !== undefined) {
        if (!Number.isFinite(dayNumber(course.date))) fail("日期用有效的 YYYY-MM-DD。");
      } else {
        if (!Number.isInteger(course.weekday) || course.weekday < 1 || course.weekday > 7) fail("星期应为 1 到 7。");
        if (!["all", "odd", "even"].includes(course.weekType)) fail("单双周用 all、odd 或 even。");
        if (typeof course.weeks !== "string" || !course.weeks.split(",").every((part) => {
          const range = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
          return range && Number(range[1]) >= 1 && Number(range[2] || range[1]) >= Number(range[1]);
        })) fail("周次范围例如 1-8,10-16。");
      }
      if (course.periods !== undefined && typeof course.periods !== "string") fail("节次应为文字，例如 1-2。");
    }
    result.schedule = data.schedule;
  }
  if ("items" in data) {
    const items = data.items;
    if (!isRecord(items) || !isTextList(items.daily) || !isRecord(items.byCourse) || !Object.values(items.byCourse).every(isTextList)) throw new Error("教材格式：daily 为物品数组，byCourse 为课程名对应的物品数组。");
    if (items.notesByCourse !== undefined && (!isRecord(items.notesByCourse) || !Object.values(items.notesByCourse).every((text) => typeof text === "string"))) throw new Error("教材备注 notesByCourse 的内容应为文字。");
    result.items = items;
  }
  if ("plan" in data) {
    const plan = data.plan;
    if (!isRecord(plan) || !isRecord(plan.days) || !Object.entries(plan.days).every(([day, tasks]) => Number.isFinite(dayNumber(day)) && isTextList(tasks))) throw new Error("待办格式：days 为有效日期对应的文字数组。");
    if (plan.weekOf !== undefined && !Number.isFinite(dayNumber(plan.weekOf))) throw new Error("weekOf 应为有效日期。");
    if (plan.weeklyGoals !== undefined && !isTextList(plan.weeklyGoals)) throw new Error("weeklyGoals 应为文字数组。");
    result.plan = plan;
  }
  if (!Object.keys(result).length) throw new Error("没有找到课程、教材或待办数据。请选择相应数据类型。");
  return result;
}

// 支持整包，也支持原来的 schedule.json / items.json / plan.json 单文件。
function normalizeImport(data, type) {
  if (isRecord(data) && ["schedule", "items", "plan"].some((key) => key in data)) return validateImport(data);
  if (type === "auto") type = Array.isArray(data) ? "schedule" : isRecord(data) && "daily" in data ? "items" : isRecord(data) && "days" in data ? "plan" : "auto";
  return validateImport(type === "auto" ? data : { [type]: data });
}

function downloadJSON(data, filename) {
  const link = element("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function initDataTools() {
  const file = $("#import-file"), status = $("#import-status"), preview = $("#import-preview");
  let pending = null, readId = 0;
  function setStatus(message, state = "info") {
    status.textContent = message;
    status.dataset.state = state;
  }
  function clearPreview(message) {
    readId++;
    pending = null;
    preview.hidden = true;
    $("#import-preview-list").replaceChildren();
    if (message) setStatus(message);
  }
  function prepareData(data) {
    clearPreview();
    try {
      pending = normalizeImport(data, $("#import-type").value);
      $("#import-confirm-button").disabled = false;
      const lines = [];
      if (pending.schedule) {
        lines.push(`替换课程：共 ${pending.schedule.length} 条（包括未来日期）。`);
        for (const c of pending.schedule) lines.push(`${c.date || `星期${c.weekday} / ${c.weeks}周 / ${c.weekType === "odd" ? "单周" : c.weekType === "even" ? "双周" : "每周"}`}：${c.start ? `${c.start}–${c.end}` : `第${c.periods}节`} ${c.course} · ${c.room}`);
      }
      if (pending.items) {
        lines.push(`替换教材与物品。每天：${pending.items.daily.join("、") || "无"}`);
        for (const [course, names] of Object.entries(pending.items.byCourse)) lines.push(`${course}：${names.join("、") || "无"}`);
        for (const [course, note] of Object.entries(pending.items.notesByCourse || {})) lines.push(`${course} 备注：${note}`);
      }
      if (pending.plan) {
        lines.push(`替换待办计划，共 ${Object.keys(pending.plan.days).length} 天；每天只显示前 3 条建议。`);
        if (pending.plan.weeklyGoals?.length) lines.push(`每周目标：${pending.plan.weeklyGoals.join("、")}`);
        for (const [day, tasks] of Object.entries(pending.plan.days)) lines.push(`${day}：${tasks.join("、") || "无"}`);
      }
      $("#import-preview-list").replaceChildren(...lines.slice(0, 60).map((line) => element("li", "", line)));
      if (lines.length > 60) $("#import-preview-list").append(element("li", "", "仅预览前 60 行，确认后导入全部已校验内容。"));
      preview.hidden = false;
      const unknown = pending.schedule?.filter(c => !c.start).length || 0;
      setStatus(`检查通过。${unknown ? `有 ${unknown} 条课程仅有节次，钟点待确认。` : ""}请查看下方内容；此时还没有覆盖数据。`, "success");
    } catch (error) {
      clearPreview(`导入失败：${error instanceof SyntaxError ? "JSON 格式不正确，请检查逗号和引号。" : error.message}`);
      status.dataset.state = "error";
    }
  }
  function prepare(text) {
    try {
      if (text.length > 1000000) throw new Error("文件或粘贴内容请控制在 1 MB 以内。");
      const cleanText = text.replace(/^\uFEFF/, "").trim();
      if (/^[\[{]/.test(cleanText)) prepareData(JSON.parse(cleanText));
      else {
        const parsed = BoardExcel.readText(cleanText, boardData?.config.periodTimes || {}, $("#import-type").value);
        if (!parsed) throw new Error("没有识别到课程、教材或待办表头。请保留模板第一行的列名。 ");
        prepareData(parsed);
      }
    } catch (error) {
      clearPreview(`导入失败：${error instanceof SyntaxError ? "JSON 格式不正确，请检查逗号和引号。" : error.message}`);
      status.dataset.state = "error";
    }
  }
  async function processFile(selected) {
    clearPreview("正在读取文件；原数据不会改变…");
    const id = readId, type = $("#import-type").value;
    try {
      const excel = /\.xlsx?$/i.test(selected.name);
      const delimited = /\.(csv|tsv|txt)$/i.test(selected.name);
      const json = /\.json$/i.test(selected.name);
      if (!excel && !delimited && !json) throw new Error("请选择 Excel、CSV、TSV 或 JSON 文件。");
      const limit = excel ? 5000000 : 1000000;
      if (selected.size > limit) throw new Error(excel ? "Excel 请控制在 5 MB 以内。" : "文件请控制在 1 MB 以内。");
      const content = excel ? await selected.arrayBuffer() : await selected.text();
      if (id !== readId) return;
      if (excel) prepareData(BoardExcel.readFile(content, window.XLSX, boardData?.config.periodTimes || {}, type));
      else prepare(content);
    } catch (error) {
      if (id === readId) {
        clearPreview(`文件读取失败：${error.message}`);
        status.dataset.state = "error";
      }
    } finally { file.value = ""; }
  }
  $("#import-button").addEventListener("click", () =>
    setStatus("请选择 Excel、CSV、TSV 或 JSON 文件；原数据不会改变。"));
  file.addEventListener("cancel", () => setStatus("已取消选择，原数据没有改变。"));
  file.addEventListener("change", async () => {
    const selected = file.files?.[0];
    if (!selected) return;
    await processFile(selected);
  });
  const dropZone = $("#import-drop-zone");
  ["dragenter", "dragover"].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (eventName === "drop") {
      dropZone.classList.remove("is-dragging");
      const selected = event.dataTransfer?.files?.[0];
      if (selected) processFile(selected);
    } else if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("is-dragging");
  }));
  $("#import-preview-button").addEventListener("click", () => prepare($("#import-text").value));
  $("#import-text").addEventListener("input", () => clearPreview("文本已修改，请重新检查并预览。"));
  $("#import-type").addEventListener("change", () => clearPreview("类型已修改，请重新选择文件或检查文本。"));
  $("#import-cancel-button").addEventListener("click", () => clearPreview("已取消导入，原数据没有改变。"));
  $("#import-confirm-button").addEventListener("click", () => {
    if (!pending) return;
    const saved = readStored("morning-board:imported-data", {});
    const current = isRecord(saved) ? saved : {};
    const imported = { ...current, ...pending };
    if (writeStored("morning-board:imported-data", imported)) {
      const applied = pending;
      $("#import-confirm-button").disabled = true;
      boardData.imported = imported;
      for (const [key, value] of Object.entries(applied)) {
        boardData[key] = value;
        delete boardData.failures[key];
        boardData.notices = boardData.notices.filter(notice => !notice.startsWith(`${key}.json 读取失败`));
      }
      renderSelectedDay(selectedDay);
      clearPreview("导入成功，看板已更新。");
      status.dataset.state = "success";
    } else setStatus("本机存储失败，未完成导入。请检查此网站的存储权限，不要清除原数据。", "error");
  });
  $("#excel-template-button").addEventListener("click", () => {
    if (!window.XLSX) { setStatus("Excel 组件未加载，请刷新后重试。", "error"); return; }
    const book = XLSX.utils.book_new();
    const day = dateKey(new Date());
    const sheets = {
      "课程": [["课程", "星期", "节次", "开始时间", "结束时间", "教室", "周次", "单双周", "日期"], ["课程名称", "周一", "1-2", "08:20", "10:00", "教室名称", "1-16", "每周", ""]],
      "教材": [["课程", "教材"], ["课程名称", "教材名称"], ["每天", "水杯"]],
      "待办": [["日期", "待办"], [day, "一条待办建议"]]
    };
    for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
    XLSX.writeFile(book, "晨间看板填写模板.xlsx");
    setStatus("已生成 Excel 模板，包含课程、教材和待办三张表。", "success");
  });
  $("#csv-template-button").addEventListener("click", () => {
    const day = dateKey(new Date());
    const type = $("#import-type").value === "auto" ? "schedule" : $("#import-type").value;
    const templates = {
      schedule: [["课程", "星期", "节次", "开始时间", "结束时间", "教室", "周次", "单双周", "日期"], ["课程名称", "周一", "1-2", "08:00", "09:40", "教室名称", "1-16", "每周", ""]],
      items: [["课程", "教材"], ["课程名称", "教材名称"], ["每天", "水杯"]],
      plan: [["日期", "待办"], [day, "一条待办建议"]]
    };
    const csv = templates[type].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = element("a");
    link.href = url;
    link.download = `晨间看板-${type === "schedule" ? "课程" : type === "items" ? "教材物品" : "待办"}-模板.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("已生成当前类型的 CSV 模板，填写后可直接导入。", "success");
  });
  $("#template-button").addEventListener("click", () => downloadJSON({
    schedule: [{ date: dateKey(new Date()), course: "课程名称", periods: "1-2", start: "08:00", end: "09:40", room: "教室名称" }],
    items: { daily: ["水杯"], byCourse: { "课程名称": ["教材名称"] } },
    plan: { weekOf: dateKey(new Date()), weeklyGoals: [], days: { [dateKey(new Date())]: ["一条待办建议"] } }
  }, "晨间看板填写模板.json"));
  $("#export-button").addEventListener("click", async () => {
    try {
      const data = {};
      for (const name of ["schedule", "items", "plan"]) data[name] = await readJSON(name);
      downloadJSON(data, "晨间看板课程物品计划.json");
      setStatus("已导出课程、物品与计划。临时待办、勾选状态和定位不包含在内。", "success");
    } catch { setStatus("导出失败，请检查数据是否已加载。", "error"); }
  });
}

// 只生成中文文字，不依赖语音 API，方便单独测试。
function buildSpeechText(data, sections) {
  const lines = [];
  if (sections.date) lines.push(data.date);
  if (sections.weather) lines.push(Number.isFinite(data.weather.high) && Number.isFinite(data.weather.low)
    ? `今日天气，${data.weather.description}，最高${data.weather.high}度，最低${data.weather.low}度${data.weather.rain ? `，降水概率${data.weather.rain}` : ""}`
    : "天气暂未获得，稍后可以定位并查询");
  if (sections.courses) {
    lines.push(data.courses.length ? `${data.dayLabel || "今日"}有${data.courses.length}个上课时段` : data.courseStatus);
    for (const c of data.courses) lines.push(`${c.start && c.end ? `${c.start.replace(":", "点")}分到${c.end.replace(":", "点")}分` : `按第${c.periods}节上课`}，${c.name}，${c.room}`);
  }
  if (sections.items) {
    lines.push(data.items.length ? `还需要带，${data.items.join("、")}` : data.itemStatus || "物品已全部勾选");
    if (data.courseStatus.includes("未录入")) lines.push("当天课表未录入，课程物品尚不能确定");
  }
  if (sections.todos) lines.push(data.todos.length ? `未完成待办，${data.todos.join("、")}` : ["数据暂不可用", "正在读取…"].includes(data.todoStatus) ? "待办数据暂不可用" : `${data.dayLabel || "今日"}没有未完成待办`);
  return lines.filter(Boolean).join("。") + (lines.length ? "。" : "");
}

function speechSnapshot() {
  const unchecked = (selector) => [...document.querySelectorAll(`${selector} .check-label`)]
    .filter((label) => !label.querySelector("input").checked).map((label) => label.querySelector("span").textContent);
  const rain = $("#precipitation-probability").textContent;
  return {
    date: `${$("#date-label").textContent}，${$(".week-badge").textContent}`.replaceAll("·", "，"),
    weather: { description: $("#weather-description").textContent, high: parseFloat($("#temperature-high").textContent), low: parseFloat($("#temperature-low").textContent), rain: rain.includes("--") ? "" : `百分之${parseFloat(rain)}` },
    courses: [...document.querySelectorAll("#courses .course")].map((row) => ({ start: row.querySelector(".course-time").dataset.start, end: row.querySelector(".course-time").dataset.end, name: row.querySelector(".course-name").textContent, room: row.querySelector(".course-room").textContent })),
    dayLabel: selectedDay === dateKey(new Date()) ? "今日" : `${selectedDay}当天`,
    courseStatus: $("#courses .empty")?.textContent || "当天没有课",
    items: unchecked("#items"), itemStatus: $("#items .empty")?.textContent || "",
    todos: unchecked("#todos"), todoStatus: $("#todos .empty")?.textContent || ""
  };
}

function initSpeech() {
  const button = $("#speak-button"), status = $("#speech-status"), voiceSelect = $("#speech-voice");
  const rateSelect = $("#speech-rate"), panel = $("#speech-tools"), preview = $("#speech-preview");
  const checks = [...document.querySelectorAll("[data-speech-section]")];
  const saved = readStored("morning-board:speech-settings", {});
  const settings = isRecord(saved) ? saved : {};
  checks.forEach((input) => { input.checked = settings.sections?.[input.dataset.speechSection] !== false; });
  rateSelect.value = ["0.9", "1", "1.1"].includes(settings.rate) ? settings.rate : "1";
  let voiceId = typeof settings.voice === "string" ? settings.voice : "";
  let voices = [], job = 0, active = false, currentUtterance = null, timer = 0;
  const supported = Boolean(window.speechSynthesis && typeof window.speechSynthesis.speak === "function" && typeof window.speechSynthesis.cancel === "function" && typeof window.SpeechSynthesisUtterance === "function");
  const sections = () => Object.fromEntries(checks.map((input) => [input.dataset.speechSection, input.checked]));
  function updatePreview() { preview.value = buildSpeechText(speechSnapshot(), sections()); return preview.value; }
  function saveSettings() {
    writeStored("morning-board:speech-settings", { voice: voiceId, rate: rateSelect.value, sections: sections() });
    updatePreview();
  }
  function stop(message) {
    job++;
    active = false;
    clearTimeout(timer);
    currentUtterance = null;
    if (supported) { try { window.speechSynthesis.cancel(); } catch {} }
    button.textContent = "语音播报";
    if (message) status.textContent = message;
  }
  function loadVoices() {
    if (!supported) return;
    try {
      voices = window.speechSynthesis.getVoices().filter((voice) => /^zh(?:[-_]|$)/i.test(voice.lang));
      voices.sort((a, b) => Number(b.localService) - Number(a.localService) || Number(/^zh[-_]CN$/i.test(b.lang)) - Number(/^zh[-_]CN$/i.test(a.lang)));
      voiceSelect.replaceChildren(new Option("自动选择中文（优先本机）", ""), ...voices.map((voice) => new Option(`${voice.name}（${voice.lang}，${voice.localService ? "本机" : "可能需联网"}）`, voice.voiceURI)));
      voiceSelect.value = voices.some((voice) => voice.voiceURI === voiceId) ? voiceId : "";
      if (!active) status.textContent = voices.length ? `已找到 ${voices.length} 个中文音色，可以先试听。未标为本机的音色可能需要网络。` : "接口可用，但尚未列出中文音色；播报会尝试系统默认中文。无声时请检查系统文字转语音设置。";
    } catch { status.textContent = "读取音色列表失败，可以尝试系统默认中文，或复制播报稿。"; }
  }
  const errors = {
    "not-allowed": "语音播放未获当前运行环境允许，请手动点击重试；内置浏览器可尝试用系统 Chrome 打开。",
    "language-unavailable": "系统没有可用的中文语音，请检查设备文字转语音的中文语言包。",
    "voice-unavailable": "所选音色不可用，请切回自动选择或更换音色。",
    "synthesis-unavailable": "设备语音服务不可用，请检查系统文字转语音设置。",
    "synthesis-failed": "设备语音合成失败，请换一个中文音色后试听。",
    "audio-busy": "音频通道被占用，请停止其他播放后重试。",
    "audio-hardware": "当前音频输出不可用，请检查扬声器或耳机。",
    "network": "此音色的网络服务无法连接，请优先选择标为本机的中文音色。",
    "text-too-long": "设备拒绝了过长的播报内容，请减少勾选内容。"
  };
  function speak(text) {
    $("#settings").open = true;
    panel.open = true;
    stop();
    if (!supported) {
      status.textContent = "当前页面运行环境没有提供语音合成接口，网页无法自行补齐。可用系统 Chrome 打开后再试，或直接查看、复制播报稿。";
      return;
    }
    if (!text.trim()) { status.textContent = "请先选择至少一项播报内容。"; return; }
    loadVoices();
    const voice = voices.find((item) => item.voiceURI === voiceSelect.value) || voices[0];
    // 分句播放，避免一次交给安卓语音引擎过长文本。
    const chunks = text.split(/[。；]/).filter((line) => line.trim()).flatMap((line) => line.match(/.{1,100}/gu) || []);
    const id = ++job;
    active = true;
    button.textContent = "停止播报";
    function next(index) {
      if (id !== job) return;
      if (index === chunks.length) { stop("播报完成。"); return; }
      try {
        const utterance = new SpeechSynthesisUtterance(chunks[index]);
        currentUtterance = utterance; // 保持引用，直到本句完成。
        utterance.lang = voice?.lang || "zh-CN";
        if (voice) utterance.voice = voice;
        utterance.rate = Number(rateSelect.value);
        utterance.onstart = () => { if (id === job) { clearTimeout(timer); status.textContent = `正在播报（${index + 1}/${chunks.length}）…`; } };
        utterance.onend = () => { if (id === job) { clearTimeout(timer); next(index + 1); } };
        utterance.onerror = (event) => { if (id === job) stop(errors[event.error] || `语音未完成（${event.error || "未知原因"}），可以更换音色试听或复制文字。`); };
        status.textContent = "等待设备语音服务启动…";
        timer = setTimeout(() => { if (id === job) stop("8 秒内未收到语音启动信号。请检查系统中文语音引擎、媒体音量，或用系统 Chrome 打开；播报稿仍可查看。 "); }, 8000);
        if (typeof window.speechSynthesis.resume === "function") window.speechSynthesis.resume();
        window.speechSynthesis.speak(utterance);
      } catch { stop("调用设备语音服务失败，请换一个中文音色试听，或查看播报稿。"); }
    }
    next(0);
  }
  checks.forEach((input) => input.addEventListener("change", saveSettings));
  rateSelect.addEventListener("change", saveSettings);
  voiceSelect.addEventListener("change", () => { voiceId = voiceSelect.value; saveSettings(); });
  button.addEventListener("click", () => active ? stop("已停止播报。") : speak(updatePreview()));
  $("#speech-test-button").addEventListener("click", () => speak("早上好，这是晨间看板的中文音色试听。"));
  $("#speech-preview-button").addEventListener("click", () => { updatePreview(); status.textContent = "播报稿已按当前勾选状态更新。"; });
  $("#speech-copy-button").addEventListener("click", async () => {
    const text = updatePreview();
    try { await navigator.clipboard.writeText(text); status.textContent = "播报稿已复制。"; }
    catch { preview.focus(); preview.select(); status.textContent = "未能自动复制，已选中播报稿，请长按复制或按 Ctrl+C。"; }
  });
  panel.addEventListener("toggle", () => { if (panel.open) updatePreview(); });
  window.addEventListener("pagehide", () => stop());
  if (supported) {
    loadVoices();
    if (typeof window.speechSynthesis.addEventListener === "function") window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    else window.speechSynthesis.onvoiceschanged = loadVoices;
  } else {
    status.textContent = "当前页面未提供语音合成接口；可用系统 Chrome 打开后再试，播报稿仍可预览和复制。";
    $("#speech-test-button").disabled = true;
  }
}

function initInstall() {
  const button = $("#install-button"), status = $("#install-status");
  let promptEvent;
  const installed = () => window.matchMedia("(display-mode: standalone)").matches;
  if (installed()) { button.hidden = true; status.textContent = "当前已在应用窗口内打开。此形式仍需点开图标，不是桌面小组件。"; }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); promptEvent = event;
    if (!installed()) button.hidden = false;
  });
  button.addEventListener("click", async () => {
    if (!promptEvent) {
      status.textContent = "当前未收到浏览器安装提示。请在系统 Chrome/Edge 的菜单中查找安装应用入口（以实际菜单为准）；安装后仍是点开查看的窗口，不是桌面数据小组件。";
      return;
    }
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      status.textContent = choice.outcome === "accepted" ? "已接受安装请求。安装完成后从应用图标打开看板。" : "已取消安装，可以继续使用网页。";
    } catch { status.textContent = "安装提示未能打开，请使用浏览器菜单中的安装入口。"; }
    finally { promptEvent = null; }
  });
  window.addEventListener("appinstalled", () => { button.hidden = true; status.textContent = "已安装为应用。它不会自动变成手机或电脑桌面小组件。"; });
}

// 独立弹簧函数：拉力将数值拉向目标，阻尼逐渐消耗速度。
function springStep(value, target, velocity, seconds) {
  velocity += ((target - value) * 210 - velocity * 20) * seconds;
  return { value: value + velocity * seconds, velocity };
}

function initCardMotion() {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  document.querySelectorAll(".card").forEach((card) => {
    const pose = { x: 0, y: 0, lift: 0 };
    const target = { ...pose };
    const velocity = { ...pose };
    let pointerId = null, bounds, frame = 0, lastTime = 0;

    function paint() {
      card.style.setProperty("--tilt-x", `${pose.x}deg`);
      card.style.setProperty("--tilt-y", `${pose.y}deg`);
      card.style.setProperty("--lift", pose.lift);
    }

    function animate(time) {
      const seconds = Math.min((time - lastTime) / 1000 || 1 / 60, 1 / 60);
      lastTime = time;
      let moving = false;
      for (const key of Object.keys(pose)) {
        const next = springStep(pose[key], target[key], velocity[key], seconds);
        pose[key] = next.value;
        velocity[key] = next.velocity;
        moving ||= Math.abs(target[key] - pose[key]) > .001 || Math.abs(velocity[key]) > .01;
      }
      if (!moving) {
        Object.assign(pose, target);
        Object.keys(velocity).forEach((key) => { velocity[key] = 0; });
      }
      paint();
      frame = moving ? requestAnimationFrame(animate) : 0;
      if (!moving && pointerId === null) card.classList.remove("is-lifted");
    }

    function start() {
      if (frame) return;
      lastTime = 0;
      frame = requestAnimationFrame(animate);
    }

    function release() {
      if (pointerId === null) return;
      const id = pointerId;
      pointerId = null;
      if (card.hasPointerCapture(id)) card.releasePointerCapture(id);
      Object.keys(target).forEach((key) => { target[key] = 0; });
      start();
    }

    function reset() {
      release();
      cancelAnimationFrame(frame);
      frame = 0;
      for (const key of Object.keys(pose)) pose[key] = target[key] = velocity[key] = 0;
      paint();
      card.classList.remove("is-lifted");
    }

    function follow(event) {
      const x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
      const y = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1));
      target.x = -y * 5;
      target.y = x * 6;
      target.lift = 1;
      start();
    }

    card.addEventListener("pointerdown", (event) => {
      // 不接管输入框、链接或勾选框，也不禁用浏览器的原生滚动。
      if (reducedMotion.matches || !event.isPrimary || event.button !== 0 || pointerId !== null) return;
      if (event.target.closest("input, button, a, select, textarea, label, [contenteditable]")) return;
      bounds = card.getBoundingClientRect();
      pointerId = event.pointerId;
      card.setPointerCapture(pointerId);
      card.classList.add("is-lifted");
      follow(event);
    }, { passive: true });
    card.addEventListener("pointermove", (event) => {
      if (event.pointerId === pointerId) follow(event);
    }, { passive: true });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      card.addEventListener(type, (event) => {
        if (event.pointerId === pointerId) release();
      }, { passive: true });
    }
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", () => { if (document.hidden) reset(); });
    reducedMotion.addEventListener("change", reset);
  });
}

// 核心读取先启动；动效、语音等可选能力失败不阻塞课表。
showPreview().catch(error => {
  $("#status").textContent = "看板加载异常，请刷新重试；原数据没有被清除。";
  console.error("看板启动失败：", error);
});
for (const init of [initDataTools, initSpeech, initInstall, initCardMotion]) {
  try { init(); } catch (error) { console.error(`${init.name} 初始化失败：`, error); }
}

// HTTPS 静态托管时启用离线应用壳；天气 API 不会被 Service Worker 缓存。
if ("serviceWorker" in navigator && window.isSecureContext && !window.morningDesktop) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}


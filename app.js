// JSON 是个人资料来源；课程日期和物品汇总都由下面的小函数处理。
const $ = (selector) => document.querySelector(selector);

async function readJSON(name) {
  const response = await fetch(`data/${name}.json`);
  if (!response.ok) throw new Error(`${name}.json 读取失败`);
  return response.json();
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

function coursesForDay(schedule, day, week) {
  return schedule.filter((course) => isCourseOnDay(course, day, week))
    .sort((a, b) => a.start.localeCompare(b.start));
}

function itemsForCourses(items, courses) {
  const names = [...items.daily];
  for (const course of courses) names.push(...(items.byCourse[course.course] || []));
  return [...new Set(names)];
}

// scheduleDates 记录已核对的日期；缺失日期不能解释为“没有课”。
function hasScheduleForDay(schedule, day, config) {
  if (schedule.some((course) => course.date === day)) return true;
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
  return dateKey(now) > day || (dateKey(now) === day && now.toTimeString().slice(0, 5) >= course.end);
}

function formatDate(dateKeyValue) {
  const [year, month, day] = dateKeyValue.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  return `${year}年${month}月${day}日 · 星期${"日一二三四五六"[date.getDay()]}`;
}

function renderCourses(courses, now, day, known = true) {
  const rows = courses.map((course) => {
    const row = element("li", "course");
    if (isCourseEnded(course, now, day)) row.classList.add("is-ended");
    const time = element("div", "course-time", course.start);
    time.append(element("span", "", course.end));
    const details = element("div");
    details.append(element("p", "course-name", course.course));
    details.append(element("p", "course-room", `第 ${course.periods} 节 · ${course.room}`));
    row.append(time, details);
    return row;
  });
  $("#courses").replaceChildren(...rows);
  if (!rows.length) $("#courses").append(element("li", "empty", known ? "今天没有课" : "尚未录入当天课表"));
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

  if (!suggestions.length) rows.push(element("li", "empty", "今天还没有建议，可以自己添加"));
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
  input.placeholder = "写下一件临时待办，按回车添加";
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const text = input.value.trim();
    if (!text) return;
    event.preventDefault();
    temporary.push({ id: `${Date.now()}-${nextId++}`, text, done: false });
    writeStored(key, temporary);
    input.value = "";
    renderTodos(suggestions, temporary, day);
  });
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

function readWeatherCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(WEATHER_CACHE_KEY) || "null");
    return cache && Date.now() - cache.savedAt < WEATHER_CACHE_MS && cache.day === dateKey(new Date()) ? cache : null;
  } catch { return null; }
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
  if (error?.name === "GeolocationPositionError") {
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
    return {
      description: weatherText(daily.weather_code?.[0]),
      high: daily.temperature_2m_max[0],
      low: daily.temperature_2m_min[0],
      precipitation: daily.precipitation_probability_max?.[0] ?? null
    };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("WEATHER_TIMEOUT");
    throw error;
  } finally { clearTimeout(timer); }
}

async function initWeather(config) {
  const button = $("#weather-button");
  const cache = readWeatherCache();
  let coordinates = Number.isFinite(config.latitude) && Number.isFinite(config.longitude)
    ? { latitude: config.latitude, longitude: config.longitude }
    : null;
  const fixedLocation = Boolean(coordinates);
  button.textContent = fixedLocation ? "刷新天气" : "定位并查询";

  if (cache) showWeather(cache.weather, cache.location, "显示1小时内缓存 · 点按钮重新查询");

  async function refresh() {
    button.disabled = true;
    button.textContent = fixedLocation ? "正在查询…" : "正在定位…";
    $("#weather-help").textContent = fixedLocation ? "正在连接天气服务…" : "正在请求浏览器定位。网页不会读取设备天气应用的数据。";
    try {
      if (!coordinates) coordinates = await getDevicePosition();
      const weather = await requestWeather(coordinates.latitude, coordinates.longitude);
      const location = config.city || "当前位置";
      try {
        localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({
          savedAt: Date.now(), day: dateKey(new Date()), location, coordinates, weather
        }));
      } catch { /* 浏览器禁用存储时仍显示刚获取的天气 */ }
      showWeather(weather, location, "天气已更新 · 缓存1小时 · 点按钮可刷新");
    } catch (error) {
      if (error?.name === "GeolocationPositionError" && error.code !== 1 && !cache) {
        showWeather({ description: "天气暂不可用", high: null, low: null, precipitation: null }, "未获取位置", explainWeatherError(error));
      } else if (!coordinates || !cache) {
        showWeather({ description: "天气暂不可用", high: null, low: null, precipitation: null }, "未获取天气", explainWeatherError(error));
      } else {
        showWeather(cache.weather, cache.location, `${explainWeatherError(error)} 当前显示1小时内缓存。`);
      }
    } finally {
      button.disabled = false;
      button.textContent = fixedLocation ? "刷新天气" : (coordinates ? "重试天气" : "重新定位");
    }
  }

  button.addEventListener("click", refresh);
  if (!cache) refresh();
}
async function showPreview() {
  const now = new Date();
  const today = dateKey(now);
  $("#date-label").textContent = formatDate(today);
  try {
    const [config, schedule, items, plan] = await Promise.all(
      ["config", "schedule", "items", "plan"].map(readJSON)
    );
    initWeather(config);
    const week = weekForDay(today, config);
    const known = hasScheduleForDay(schedule, today, config);
    const courses = coursesForDay(schedule, today, week);
    $(".week-badge").textContent = week ? `第 ${week} 周 · ${week % 2 ? "单" : "双"}周` : "周次待确认";
    $("#status").textContent = config.scheduleLabel || "按当天日期显示课表";
    $("#schedule-status").textContent = known ? `今天 ${courses.length} 个上课时段` : "当天课表未录入";
    renderCourses(courses, now, today, known);
    renderItems(itemsForCourses(items, courses), today, known);
    renderItemNotes(itemNotesForCourses(items, courses), known);
    const suggestions = (plan.days[today] || []).slice(0, 3);
    initTemporaryTodos(today, suggestions);
  } catch (error) {
    $(".week-badge").textContent = "周次待确认";
    $("#status").textContent = "数据读取失败，请检查 JSON 格式，并通过本地静态服务打开。";
    for (const selector of ["#courses", "#items", "#todos"]) {
      $(selector).replaceChildren(element("li", "empty", "数据暂不可用"));
    }
    console.error("看板数据读取失败：", error);
  }
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

initCardMotion();
showPreview();

// HTTPS 静态托管时启用离线应用壳；天气 API 不会被 Service Worker 缓存。
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}


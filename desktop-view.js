// 只认宿主注入的标记；普通浏览器与手机页面不受影响。
if (window.morningDesktop) {
  document.documentElement.classList.add("desktop-board", "desktop-compact");
  window.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#install-tools").hidden = true;
    document.querySelector("#settings > summary").textContent = "设置（导入 · 播报）";
    document.querySelector(".app-footer").textContent = "桌面看板 · 顶部拖动 · 右下角缩放 · 设置可选大小";
    const toggle = document.querySelector("#desktop-expand");
    toggle?.addEventListener("click", () => {
      const expanded = document.documentElement.classList.toggle("desktop-expanded");
      document.documentElement.classList.toggle("desktop-compact", !expanded);
      toggle.textContent = expanded ? "\u6536\u8D77" : "\u5C55\u5F00";
      toggle.setAttribute("aria-expanded", String(expanded));
      window.chrome?.webview?.postMessage(expanded ? "expand" : "compact");
    });
    window.chrome?.webview?.addEventListener("message", event => {
      const message = event.data;
      if (message === "layout:compact" || message === "layout:expanded") {
        const expanded = message === "layout:expanded";
        document.documentElement.classList.toggle("desktop-expanded", expanded);
        document.documentElement.classList.toggle("desktop-compact", !expanded);
        toggle.textContent = expanded ? "\u6536\u8D77" : "\u5C55\u5F00";
        toggle.setAttribute("aria-expanded", String(expanded));
        return;
      }
      if (message !== "locked") return;
      const expanded = document.documentElement.classList.contains("desktop-expanded");
      document.documentElement.classList.toggle("desktop-expanded", !expanded);
      document.documentElement.classList.toggle("desktop-compact", expanded);
      toggle.textContent = expanded ? "\u5C55\u5F00" : "\u6536\u8D77";
      toggle.setAttribute("aria-expanded", String(!expanded));
      document.querySelector("#status").textContent = "\u9762\u677F\u5DF2\u9501\u5B9A\uFF0C\u8BF7\u5148\u89E3\u9501\u518D\u8C03\u6574\u5927\u5C0F\u3002";
    });
  });
  // 跨日或从睡眠恢复时重新读取日期；未提交的输入留待用户确认。
  let visibleDay = new Date().toDateString();
  setInterval(() => {
    const today = new Date().toDateString();
    if (today === visibleDay) {
      const now = new Date();
      const time = now.toTimeString().slice(0, 5);
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const selected = document.querySelector("#board-day")?.value;
      document.querySelectorAll(".course").forEach(row => {
        const end = row.querySelector(".course-time")?.dataset.end;
        if (end && selected) row.classList.toggle("is-ended", selected < todayKey || (selected === todayKey && time >= end));
      });
      return;
    }
    const editing = [...document.querySelectorAll('input[type="text"], textarea:not([readonly])')]
      .some(input => input.value.trim());
    if (!editing) location.reload();
  }, 30000);
}

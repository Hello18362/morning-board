# 晨间看板

纯静态中文页面：天气、当天课程、按课程汇总的物品、可编辑的临时待办。无需账号、服务器、密钥或构建工具。

## 文件说明

- `index.html`：页面结构和四个区块。
- `style.css`：手机优先布局、触控尺寸、深色模式和轻量动效。
- `app.js`：读取 JSON、按日期显示课程/物品、待办与本机存储、定位和天气请求。周次计算及日期函数独立可测。
- `data/config.json`：城市、坐标和周次参考。城市/坐标留空时，网页尝试请求设备定位。
- `data/schedule.json`：课程。当前导入的是 2026-10-12 至 2026-10-16 的具体日期记录；未录入日期不会被误显示成“没课”。
- `data/items.json`：每日物品、各课程教材和待核对提醒。
- `data/plan.json`：每周建议待办。临时添加项和勾选状态仅保存在当前浏览器的 localStorage。
- `manifest.webmanifest`、图标、`sw.js`：安装信息、图标和静态页面离线缓存。天气请求不缓存到离线应用壳；天气结果另在浏览器本机缓存 1 小时。

## 天气为什么需要定位/网络

网页**不能读取安卓系统天气应用内部的数据**。本页面使用浏览器定位取得经纬度，再向 Open-Meteo Forecast API 请求每日天气（`weather_code`、最高/最低温和降水概率）。API 不用密钥；如果定位被拒绝、网址不是安全来源，或网络无法连接 API，页面会说明对应原因并提供重试。它不会猜测或默认使用杭州等城市。

在 `data/config.json` 填入自己确认的城市及经纬度后，网页会跳过定位，直接按该坐标查询；不要填不确定的坐标。天气服务仅依据配置坐标或本次设备定位。

## 本地预览

不能双击 `index.html` 用 `file://` 作为完整运行方式，因为浏览器会限制 JSON、定位和离线应用功能。进入本目录后运行：

```sh
python -m http.server 8765
```

然后在这台电脑打开 `http://localhost:8765/`。localhost 是安全上下文，可用于本机定位测试。不要把电脑的 localhost 地址直接发给手机：手机上的 localhost 指手机本身；局域网 HTTP 地址也通常不能用于定位。

## 部署到 GitHub Pages，供安卓手机使用

1. 将本目录中的**全部文件**放进 GitHub 仓库。仓库可设为私有/公开视 Pages 方案而定；Pages 发布后会生成 HTTPS 地址。
2. 在仓库的 **Settings → Pages** 选择发布分支和目录（通常 `main` / `/(root)`），保存后等待发布完成。
3. 用安卓 Chrome 打开生成的 `https://…github.io/…/` 地址。允许该网站使用位置信息；如果之前拒绝过，在 Chrome 的网站设置中把“位置信息”改为允许，然后回到页面按“重新定位”/“重试天气”。
4. 首次打开需要网络以下载页面和 JSON。Chrome 菜单中选择“添加到主屏幕”或“安装应用”，之后可从桌面图标打开；课程、清单及本机待办可离线查看，天气需联网更新。

如果 HTTPS 页面仍不能出天气，先看天气卡片给出的具体提示：定位提示请检查 Chrome 网站定位权限及安卓系统定位开关；“无法连接天气服务”表示设备网络到 Open-Meteo 的连接失败，可切换 Wi-Fi/移动网络后重试。

## 修改个人数据

所有 JSON 用 UTF-8 保存，不需要改 JS：

- `config.json`：设置 `city`、`latitude`、`longitude`。如果继续用设备定位，城市留空、坐标写 `null`。`weekReference` 代表“某日是第几周”，修改后照此校准；已录入日期则优先按具体日期。
- `schedule.json`：每项包括日期或周几、课程名、起止时间、教室和教材映射所用的课程名。新学期可以录具体日期，也可使用循环周次字段。
- `items.json`：`daily` 是每天物品；`byCourse` 的键必须与课表 `course` 完全一致。勾选物品按日期存于本机。
- `plan.json`：`days` 中用 `YYYY-MM-DD` 作为键，最多显示 3 条建议。

## 日期与单双周函数示例

在 `app.js` 中 `semesterWeek(day, semesterStart)`、`weekForDay(day, config)`、`isInWeekRange(week, ranges)`、`isCourseOnDay(course, day, week)` 都是独立函数：

```js
semesterWeek("2026-09-08", "2026-09-01") // 2
weekForDay("2026-10-12", { weekReference: { date: "2026-10-12", week: 6 } }) // 6
isInWeekRange(3, "1-4,7-9") // true
isCourseOnDay({ weekday: 1, weeks: "1-16", weekType: "odd" }, "2026-10-12", 5) // true（周一，第5周）
```

调整日期时注意：系统日期决定首页显示哪一天。具体日期课表仅在 `config.json` 的 `scheduleDates` 已覆盖日期内才视为已录入。
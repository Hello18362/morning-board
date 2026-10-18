using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// 网页仍是静态文件。此宿主只负责桌面层窗口、托盘和本机启动设置。
static class Program
{
    internal static readonly string Home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MorningBoardDesktop");
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    internal static string TestOutput;
    [STAThread]
    static void Main(string[] args)
    {
        Directory.CreateDirectory(Home);
        if (args.Length == 1 && args[0] == "--install") { Install(); return; }
        if (args.Length == 2 && args[0] == "--self-test") TestOutput = Path.GetFullPath(args[1]);
        try
        {
            // 和 Explorer 桌面层使用相同 DPI 上下文；不修改 Explorer 的窗口或设置。
            IntPtr desktop = Native.FindDesktop();
            if (desktop != IntPtr.Zero) Native.SetThreadDpiAwarenessContext(Native.GetWindowDpiAwarenessContext(desktop));
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            bool first;
            using (var mutex = new Mutex(true, "Local\\MorningBoardDesktop", out first))
            {
                if (TestOutput != null) { Application.Run(new TestContext()); return; }
                if (!first)
                {
                    using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\MorningBoardDesktopShow")) show.Set();
                    return;
                }
                Application.Run(new DesktopContext());
                mutex.ReleaseMutex();
            }
        }
        catch (Exception ex)
        {
            Log(ex.ToString());
            if (TestOutput != null) { File.WriteAllText(TestOutput, Json.Serialize(new { ok = false, error = ex.ToString(), nativeError = ex is System.ComponentModel.Win32Exception ? ((System.ComponentModel.Win32Exception)ex).NativeErrorCode : 0 })); Environment.ExitCode = 1; }
            else MessageBox.Show("桌面看板未能启动：\n" + ex.Message + "\n\n日志：" + Path.Combine(Home, "desktop.log"), "晨间看板");
        }
    }
    static void Install()
    {
        try {
            var source = AppDomain.CurrentDomain.BaseDirectory;
            var target = Path.Combine(Home, "Program");
            if (!String.Equals(source.TrimEnd(Path.DirectorySeparatorChar), target, StringComparison.OrdinalIgnoreCase)) {
                Directory.CreateDirectory(target);
                foreach (var name in new[] { "MorningBoard.exe", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll", "WebView2-LICENSE.txt", "WebView2-NOTICE.txt", "使用说明.txt" })
                    File.Copy(Path.Combine(source, name), Path.Combine(target, name), true);
                CopyFolder(Path.Combine(source, "app"), Path.Combine(target, "app"));
            }
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Path.Combine(target, "MorningBoard.exe")) { UseShellExecute = true, WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden });
        } catch (Exception ex) { MessageBox.Show("安装未完成：" + ex.Message + "\n\n若旧版本仍在运行，请从托盘退出后重试。", "晨间看板"); }
    }
    static void CopyFolder(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (var file in Directory.GetFiles(source)) {
            var destination = Path.Combine(target, Path.GetFileName(file));
            // 升级时保留用户手改的 JSON；网页代码仍更新。
            if (Path.GetFileName(source) != "data" || !File.Exists(destination)) File.Copy(file, destination, true);
        }
        foreach (var dir in Directory.GetDirectories(source)) CopyFolder(dir, Path.Combine(target, Path.GetFileName(dir)));
    }
    internal static void Log(string text)
    {
        try { File.AppendAllText(Path.Combine(Home, "desktop.log"), DateTime.Now.ToString("s") + " " + text + Environment.NewLine); } catch { }
    }
}

class Preferences
{
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public int LayoutVersion { get; set; }
    public bool HasPosition { get; set; }
    public bool Locked { get; set; }
    static string PathName { get { return Path.Combine(Program.Home, "window.json"); } }
    public static Preferences Read()
    {
        try { return Program.Json.Deserialize<Preferences>(File.ReadAllText(PathName)) ?? new Preferences(); }
        catch { return new Preferences(); }
    }
    public void Save()
    {
        try { File.WriteAllText(PathName, Program.Json.Serialize(this)); } catch (Exception ex) { Program.Log("位置与大小未能保存：" + ex.Message); }
    }
}

// 当前用户启动项；只有用户主动勾选才写入，不需要管理员权限。
static class Startup
{
    const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string Name = "MorningBoardDesktop";
    internal static string Command { get { return "\"" + Application.ExecutablePath + "\""; } }
    internal static bool Enabled()
    {
        using (var key = Registry.CurrentUser.OpenSubKey(Key)) return key != null && (string)key.GetValue(Name) == Command;
    }
    internal static void Set(bool enabled)
    {
        using (var key = Registry.CurrentUser.CreateSubKey(Key))
        {
            if (enabled) key.SetValue(Name, Command, RegistryValueKind.String);
            else key.DeleteValue(Name, false);
        }
    }
}

class DesktopContext : ApplicationContext
{
    readonly Preferences prefs = Preferences.Read();
    readonly NotifyIcon tray;
    readonly ContextMenuStrip menu = new ContextMenuStrip();
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly EventWaitHandle show = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\MorningBoardDesktopShow");
    BoardForm board;
    bool hidden, quitting, reported;
    ToolStripMenuItem startup, locked;

    internal DesktopContext()
    {
        menu.Items.Add("显示看板", null, (s, e) => { hidden = false; TryShow(); });
        menu.Items.Add("暂时隐藏", null, (s, e) => { hidden = true; if (board != null && !board.IsDisposed) board.Hide(); });
        locked = new ToolStripMenuItem("锁定位置和大小");
        locked.Checked = prefs.Locked;
        locked.Click += (s, e) => { prefs.Locked = !prefs.Locked; locked.Checked = prefs.Locked; if (board != null && !board.IsDisposed) board.UpdateLockState(); prefs.Save(); };
        menu.Items.Add(locked);
        var sizes = new ToolStripMenuItem("面板大小");
        sizes.DropDownItems.Add("\u7D27\u51D1\uFF08\u7EA6 5 \u00D7 5 cm\uFF09", null, (s, e) => { if (board != null && !board.IsDisposed) board.ChooseSize(190, 190); });
        sizes.DropDownItems.Add("小（420 × 620）", null, (s, e) => { if (board != null && !board.IsDisposed) board.ChooseSize(420, 620); });
        sizes.DropDownItems.Add("中（560 × 780）", null, (s, e) => { if (board != null && !board.IsDisposed) board.ChooseSize(560, 780); });
        sizes.DropDownItems.Add("大（760 × 900）", null, (s, e) => { if (board != null && !board.IsDisposed) board.ChooseSize(760, 900); });
        menu.Items.Add(sizes);

        startup = new ToolStripMenuItem("登录后自动显示");
        startup.Click += (s, e) => {
            try { Startup.Set(!Startup.Enabled()); startup.Checked = Startup.Enabled(); }
            catch (Exception ex) { MessageBox.Show("未能修改启动设置：" + ex.Message, "晨间看板"); }
        };
        menu.Items.Add(startup);
        menu.Opening += (s, e) => { sizes.Enabled = !prefs.Locked; try { startup.Checked = Startup.Enabled(); } catch { startup.Checked = false; } };
        menu.Items.Add("重新加载数据", null, (s, e) => { if (board != null && !board.IsDisposed) board.Reload(); });
        menu.Items.Add("恢复到主屏右侧", null, (s, e) => { prefs.HasPosition = false; prefs.Save(); if (board != null && !board.IsDisposed) board.Place(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出（不再显示看板）", null, (s, e) => ExitThread());
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "晨间看板 · 桌面挂件", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += (s, e) => { hidden = false; TryShow(); };
        timer.Interval = 3000;
        timer.Tick += (s, e) => { if (show.WaitOne(0)) hidden = false; if (!hidden && !quitting) TryShow(); };
        timer.Start();
        TryShow();
    }
    void TryShow()
    {
        var desktop = Native.FindDesktop();
        if (desktop == IntPtr.Zero)
        {
            if (!reported) { tray.ShowBalloonTip(6000, "桌面层暂不可用", "请回到 Windows 桌面后再试。不会降级成普通应用窗口。", ToolTipIcon.Warning); reported = true; }
            return;
        }
        try
        {
            if (board == null || board.IsDisposed || !Native.IsWindow(board.Handle) || Native.GetParent(board.Handle) != desktop)
            {
                if (board != null && !board.IsDisposed) board.Dispose();
                board = new BoardForm(desktop, prefs, false);
                board.HeaderMenu = menu;
                board.InitializeHidden();
            }
            if (!board.Visible) board.ShowOnDesktop();
            reported = false;
        }
        catch (Exception ex)
        {
            Program.Log("挂接失败：" + ex);
            if (!reported) { tray.ShowBalloonTip(6000, "桌面看板未能显示", "请查看本机使用说明与 desktop.log。没有切换成应用窗口。", ToolTipIcon.Error); reported = true; }
        }
    }
    protected override void ExitThreadCore()
    {
        quitting = true;
        timer.Stop(); timer.Dispose(); show.Dispose();
        if (board != null) board.Dispose();
        tray.Visible = false; tray.Dispose(); menu.Dispose();
        base.ExitThreadCore();
    }
}

class BoardForm : Form
{
    readonly IntPtr desktop;
    readonly Preferences prefs;
    readonly bool testing;
    readonly WebView2 web = new WebView2();
    readonly Label header = new Label();
    readonly Button options = new Button();
    readonly Label error = new Label();
    readonly Label resizeGrip = new Label();
    readonly Label resizeHint = new Label();
    readonly Panel bar = new Panel();
    readonly Panel bottom = new Panel();
    readonly double scale;
    bool compact = true;
    Point dragStart, windowStart, resizeStart;
    Size sizeStart;
    bool dragging, resizing, loading, initialized;
    string testProfile;
    internal ContextMenuStrip HeaderMenu;
    internal CoreWebView2 Core { get { return web.CoreWebView2; } }
    internal Task Ready;

    internal BoardForm(IntPtr desktop, Preferences prefs, bool testing)
    {
        this.desktop = desktop; this.prefs = prefs; this.testing = testing;
        Text = "晨间看板 · 桌面挂件";
        TopLevel = false;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false; StartPosition = FormStartPosition.Manual; AutoScaleMode = AutoScaleMode.None;
        scale = desktop == IntPtr.Zero ? 1 : Native.GetDpiForWindow(desktop) / 96.0;
        // First launch of the compact layout preserves position, then respects manual resizing.
        if (prefs.LayoutVersion < 2) {
            prefs.Width = (int)(190 * scale); prefs.Height = (int)(190 * scale); prefs.LayoutVersion = 2;
            if (!testing) prefs.Save();
        }
        var area = prefs.HasPosition ? Screen.FromPoint(new Point(prefs.X, prefs.Y)).WorkingArea : Screen.PrimaryScreen.WorkingArea;
        MinimumSize = new Size(Math.Min((int)(190 * scale), area.Width - 32), Math.Min((int)(190 * scale), area.Height - 32));
        Size = new Size(Math.Max(MinimumSize.Width, Math.Min(prefs.Width > 0 ? prefs.Width : (int)(190 * scale), area.Width - 32)),
                        Math.Max(MinimumSize.Height, Math.Min(prefs.Height > 0 ? prefs.Height : (int)(190 * scale), area.Height - 32)));
        BackColor = Color.FromArgb(255, 244, 248);
        header.Text = "晨间看板 · 按住这里拖动"; header.Dock = DockStyle.Fill;
        header.ForeColor = Color.FromArgb(126, 42, 94); header.TextAlign = ContentAlignment.MiddleLeft;
        header.Padding = new Padding(12, 0, 0, 0); header.Font = new Font("Microsoft YaHei", 9);
        options.Text = "设置"; options.Dock = DockStyle.Right; options.Width = (int)(56 * scale);
        options.FlatStyle = FlatStyle.Flat; options.FlatAppearance.BorderSize = 0;
        options.AccessibleName = "桌面设置与开机显示";
        bar.Dock = DockStyle.Top; bar.Height = (int)(22 * scale); bar.BackColor = Color.FromArgb(255, 226, 239);
        bar.Controls.Add(header); bar.Controls.Add(options);
        options.Click += (s, e) => { if (HeaderMenu != null) HeaderMenu.Show(options, new Point(0, options.Height)); };
        header.MouseUp += (s, e) => { bool moved = dragging; dragging = false; header.Capture = false; if (moved) SavePosition(); if (e.Button == MouseButtons.Right && HeaderMenu != null) HeaderMenu.Show(header, e.Location); };
        header.MouseCaptureChanged += (s, e) => { if (dragging && !header.Capture) { dragging = false; SavePosition(); } };
        header.MouseDown += (s, e) => {
            if (e.Button != MouseButtons.Left || prefs.Locked) return;
            var bounds = Native.Bounds(Handle);
            dragging = true; dragStart = Cursor.Position; windowStart = bounds.Location; header.Capture = true;
        };
        header.MouseMove += (s, e) => {
            if (!dragging) return;
            var cursor = Cursor.Position;
            var next = new Point(windowStart.X + cursor.X - dragStart.X, windowStart.Y + cursor.Y - dragStart.Y);
            var clamped = Clamp(next, Size);
            Native.Place(Handle, desktop, clamped, Size);
        };
        web.Dock = DockStyle.Fill;
        error.Dock = DockStyle.Fill; error.Padding = new Padding(20); error.ForeColor = Color.DarkRed;
        error.Visible = false; error.Text = "正在启动桌面看板…";
        // 自绘把手：桌面子窗口没有系统边框，不能依赖普通窗口的缩放边缘。
        bottom.Dock = DockStyle.Bottom; bottom.Height = (int)(16 * scale); bottom.BackColor = bar.BackColor;
        resizeHint.Dock = DockStyle.Fill; resizeHint.TextAlign = ContentAlignment.MiddleLeft;
        resizeHint.Padding = new Padding(8, 0, 0, 0); resizeHint.Font = new Font("Microsoft YaHei", 7); resizeHint.ForeColor = header.ForeColor;
        resizeGrip.Text = "◢"; resizeGrip.Dock = DockStyle.Right; resizeGrip.Width = (int)(32 * scale);
        resizeGrip.TextAlign = ContentAlignment.MiddleCenter; resizeGrip.ForeColor = header.ForeColor;
        resizeGrip.AccessibleName = "拖动调整面板大小";
        resizeGrip.MouseDown += (s, e) => {
            if (e.Button != MouseButtons.Left || prefs.Locked) return;
            resizing = true; resizeStart = Cursor.Position; sizeStart = Size; resizeGrip.Capture = true;
        };
        resizeGrip.MouseMove += (s, e) => {
            if (!resizing) return;
            var cursor = Cursor.Position;
            ResizeBoard(new Size(sizeStart.Width + cursor.X - resizeStart.X, sizeStart.Height + cursor.Y - resizeStart.Y));
        };
        resizeGrip.MouseUp += (s, e) => {
            if (!resizing) return;
            resizing = false; resizeGrip.Capture = false; SavePosition();
        };
        resizeGrip.MouseCaptureChanged += (s, e) => { if (resizing && !resizeGrip.Capture) { resizing = false; SavePosition(); } };
        bottom.Controls.Add(resizeHint); bottom.Controls.Add(resizeGrip);
        Controls.Add(web); Controls.Add(error); Controls.Add(bottom); Controls.Add(bar);
        SetCompactChrome(Size.Width <= (int)(240 * scale) && Size.Height <= (int)(240 * scale));
        UpdateLockState();
    }
    void SetCompactChrome(bool value)
    {
        compact = value;
        bar.Height = (int)((compact ? 22 : 34) * scale);
        bottom.Height = (int)((compact ? 16 : 24) * scale);
        options.Width = (int)((compact ? 38 : 56) * scale);
        header.Font = new Font("Microsoft YaHei", compact ? 8 : 9);
        header.Padding = new Padding(compact ? 7 : 12, 0, 0, 0);
        resizeGrip.Width = (int)((compact ? 18 : 32) * scale);
        resizeHint.Visible = !compact;
        resizeHint.Padding = new Padding(compact ? 0 : 12, 0, 0, 0);
        UpdateLockState();
    }
    internal void UpdateLockState()
    {
        header.Text = compact ? "\u6668\u95f4\u770b\u677f" : (prefs.Locked ? "\u6668\u95f4\u770b\u677f \u00b7 \u4f4d\u7f6e\u548c\u5927\u5c0f\u5df2\u9501\u5b9a" : "\u6668\u95f4\u770b\u677f \u00b7 \u6309\u4f4f\u8fd9\u91cc\u62d6\u52a8");
        resizeHint.Text = prefs.Locked ? "\u5df2\u9501\u5b9a \u00b7 \u5728\u9876\u90e8\u8bbe\u7f6e\u4e2d\u89e3\u9501" : "\u62d6\u52a8\u53f3\u4e0b\u89d2\u8c03\u6574\u5927\u5c0f \u00b7 \u81ea\u52a8\u8bb0\u4f4f";
        resizeGrip.Cursor = prefs.Locked ? Cursors.Default : Cursors.SizeNWSE;
        resizeGrip.Enabled = !prefs.Locked;
    }
    internal void ChooseSize(int width, int height)
    {
        if (prefs.Locked) return;
        ResizeBoard(new Size((int)(width * scale), (int)(height * scale)));
        SavePosition();
    }
    internal void ResizeBoard(Size requested)
    {
        if (prefs.Locked) return;
        var point = Native.Bounds(Handle).Location;
        var area = Screen.FromPoint(point).WorkingArea;
        var minWidth = Math.Min((int)(190 * scale), area.Width - 32);
        var minHeight = Math.Min((int)(190 * scale), area.Height - 32);
        MinimumSize = new Size(minWidth, minHeight);
        Size = new Size(Math.Max(minWidth, Math.Min(requested.Width, area.Width - 32)),
                        Math.Max(minHeight, Math.Min(requested.Height, area.Height - 32)));
        Native.Place(Handle, desktop, Clamp(point, Size), Size);
    }
    // 只创建自己的桌面子窗口，不给 Explorer 发未公开的 WorkerW 消息。
    protected override CreateParams CreateParams
    {
        get {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x80; // WS_EX_TOOLWINDOW：不作为任务栏应用出现。
            return cp;
        }
    }
    internal void InitializeHidden()
    {
        if (initialized) return;
        initialized = true;
        var handle = Handle;
        Native.Attach(handle, desktop);
        Place();
        Ready = LoadWeb();
    }
    internal void ShowOnDesktop()
    {
        Show();
        Native.Attach(Handle, desktop);
        Place();
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        InitializeHidden();
    }
    internal void Place()
    {
        var area = Screen.PrimaryScreen.WorkingArea;
        var point = prefs.HasPosition ? new Point(prefs.X, prefs.Y) : new Point(area.Right - Width - 16, area.Top + 16);
        point = Clamp(point, Size);
        Native.Place(Handle, desktop, point, Size);
    }
    static Point Clamp(Point point, Size size)
    {
        var area = Screen.FromPoint(point).WorkingArea;
        // 显示器拔掉后也恢复到可见区域；确保顶部拖动条始终可见。
        return new Point(Math.Max(area.Left, Math.Min(point.X, area.Right - size.Width)), Math.Max(area.Top, Math.Min(point.Y, area.Bottom - Math.Min(size.Height, area.Height))));
    }
    void SavePosition()
    {
        if (testing) return;
        var bounds = Native.Bounds(Handle);
        prefs.X = bounds.X; prefs.Y = bounds.Y; prefs.Width = bounds.Width; prefs.Height = bounds.Height; prefs.HasPosition = true; prefs.Save();
    }
    async Task LoadWeb()
    {
        if (loading) return;
        loading = true;
        try
        {
            string folder = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app");
            if (!File.Exists(Path.Combine(folder, "index.html"))) throw new FileNotFoundException("未找到 app\\index.html，请先完整解压桌面包。");
            string profile = Path.Combine(Program.Home, "WebView2");
            if (testing) { testProfile = Path.Combine(Program.Home, "Test-" + Guid.NewGuid().ToString("N")); profile = testProfile; }
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            await web.EnsureCoreWebView2Async(environment);
            var core = web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = testing;
            core.Settings.IsStatusBarEnabled = false;
            core.SetVirtualHostNameToFolderMapping("morning-board.local", folder, CoreWebView2HostResourceAccessKind.DenyCors);
            await core.AddScriptToExecuteOnDocumentCreatedAsync("window.morningDesktop = true;");
            core.NavigationStarting += (s, e) => {
                Uri uri;
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out uri) || uri.Scheme != "https" || uri.Host != "morning-board.local") e.Cancel = true;
            };
            core.NewWindowRequested += (s, e) => { e.Handled = true; };
            core.WebMessageReceived += (s, e) => {
                var action = e.TryGetWebMessageAsString();
                if (action != "expand" && action != "compact") return;
                if (prefs.Locked) { core.PostWebMessageAsString("locked"); return; }
                bool expanded = action == "expand";
                SetCompactChrome(!expanded);
                if (expanded) ResizeBoard(new Size((int)(560 * scale), (int)(780 * scale)));
                else ResizeBoard(new Size((int)(190 * scale), (int)(190 * scale)));
                SavePosition();
            };
            core.PermissionRequested += (s, e) => {
                e.State = CoreWebView2PermissionState.Deny;
                e.SavesInProfile = false; // 拒绝不永久保存，之后可主动重试。
                if (!testing && e.PermissionKind == CoreWebView2PermissionKind.Geolocation && e.Uri.StartsWith("https://morning-board.local/", StringComparison.OrdinalIgnoreCase))
                {
                    if (MessageBox.Show(this, "允许看板获取设备位置来查询天气吗？\n\n坐标会发给天气服务，不读取系统天气应用。", "天气定位授权", MessageBoxButtons.YesNo) == DialogResult.Yes) {
                        e.State = CoreWebView2PermissionState.Allow;
                        e.SavesInProfile = true;
                    }
                }
            };
            core.ProcessFailed += (s, e) => ShowError("网页组件停止了：" + e.ProcessFailedKind + "。请退出后重新启动桌面看板。");
            var loaded = new TaskCompletionSource<bool>();
            core.NavigationCompleted += (s, e) => {
                if (e.IsSuccess) core.PostWebMessageAsString(compact ? "layout:compact" : "layout:expanded");
                loaded.TrySetResult(e.IsSuccess);
            };
            core.Navigate("https://morning-board.local/index.html");
            var timeout = Task.Delay(30000);
            if (await Task.WhenAny(loaded.Task, timeout) == timeout || !await loaded.Task) throw new InvalidOperationException("本地看板页面未能加载。");
            if (desktop != IntPtr.Zero) Native.Attach(Handle, desktop);
            if (!testing) await core.ExecuteScriptAsync("document.querySelector('#install-tools').hidden=true");
        }
        catch (Exception ex) { ShowError("桌面看板未能加载：\n" + ex.Message + "\n\n请确认 Microsoft Edge WebView2 Runtime 已安装。完整错误写入 desktop.log。"); if (testing) throw; }
        finally { loading = false; }
    }
    void ShowError(string text) { Program.Log(text); error.Text = text; error.Visible = true; error.BringToFront(); }
    internal void Reload() { if (Core != null) Core.Reload(); else { error.Visible = false; Ready = LoadWeb(); } }
    protected override void Dispose(bool disposing)
    {
        if (disposing) { web.Dispose(); }
        base.Dispose(disposing);
        if (testProfile != null)
        {
            // 只删自测试独立目录，不碰正常用户数据。WebView2退出较慢时保留临时目录。
            try { Directory.Delete(testProfile, true); } catch { }
        }
    }
}

// 自测试只使用自己的不可见窗口，不点按或截图用户桌面，不写启动项。
class TestContext : ApplicationContext
{
    BoardForm form;
    readonly Preferences testPrefs = new Preferences();
    System.Windows.Forms.Timer timeout = new System.Windows.Forms.Timer();
    internal TestContext()
    {
        var desktop = Native.FindDesktop();
        if (desktop == IntPtr.Zero) throw new InvalidOperationException("未找到 Explorer 桌面层。");
        form = new BoardForm(desktop, testPrefs, true);
        timeout.Interval = 60000;
        timeout.Tick += (s, e) => {
            File.WriteAllText(Program.TestOutput, "{\"ok\":false,\"error\":\"测试超时\"}");
            Environment.ExitCode = 1; ExitThread();
        };
        timeout.Start();
        Run();
    }
    async void Run()
    {
        try {
            form.InitializeHidden();
            await form.Ready;
            var original = form.Size;
            form.ResizeBoard(new Size(420, 620));
            bool nativeResize = Native.Bounds(form.Handle).Size == form.Size;
            form.ResizeBoard(new Size(1, 1));
            bool minimum = form.Size == form.MinimumSize;
            form.ResizeBoard(new Size(Int32.MaxValue, Int32.MaxValue));
            var area = Screen.FromPoint(Native.Bounds(form.Handle).Location).WorkingArea;
            bool maximum = form.Width <= area.Width - 32 && form.Height <= area.Height - 32;
            var beforeLock = form.Size;
            testPrefs.Locked = true; form.UpdateLockState(); form.ChooseSize(420, 620);
            bool lockedSize = form.Size == beforeLock;
            testPrefs.Locked = false; form.UpdateLockState(); form.ResizeBoard(original);
            // 序列化和启动尺寸恢复测试不触碰正常用户的 window.json。
            var encoded = Program.Json.Serialize(new Preferences { Width = original.Width, Height = original.Height });
            var restored = Program.Json.Deserialize<Preferences>(encoded);
            bool restoreSize;
            using (var probe = new BoardForm(Native.FindDesktop(), restored, true)) restoreSize = probe.Size == original;
            var legacy = new Preferences { X = 20, Y = 30, Width = 420, Height = 620, HasPosition = true };
            bool compactMigration;
            using (var probe = new BoardForm(Native.FindDesktop(), legacy, true))
                compactMigration = probe.Size == original && legacy.LayoutVersion == 2 && legacy.X == 20 && legacy.Y == 30;
            bool sizingOk = nativeResize && minimum && maximum && lockedSize && restoreSize && compactMigration;
            await Task.Delay(2500);
            await form.Core.ExecuteScriptAsync(@"(async()=>{window.__testData=await Promise.all(['config','schedule','items','plan'].map(async p=>({name:p,ok:(await fetch('data/'+p+'.json')).ok})));})()");
            await Task.Delay(1000);
            var summary = await form.Core.ExecuteScriptAsync(@"JSON.stringify({secure:isSecureContext,desktop:!!window.morningDesktop,layout:document.documentElement.classList.contains('desktop-board'),cards:document.querySelectorAll('.card').length,courses:document.querySelector('#courses').innerText,data:window.__testData,overflow:document.documentElement.scrollWidth>innerWidth,worker:!!navigator.serviceWorker.controller,localStorage:(()=>{localStorage.setItem('__test','ok');const v=localStorage.getItem('__test');localStorage.removeItem('__test');return v;})()})");
            var json = Program.Json.Deserialize<string>(summary);
            var result = Program.Json.Deserialize<System.Collections.Generic.Dictionary<string, object>>(json);
            bool attached = Native.GetParent(form.Handle) == Native.FindDesktop();
            bool child = (Native.GetWindowLongPtr(form.Handle, -16).ToInt64() & 0x40000000) != 0;
            bool invisible = !Native.IsWindowVisible(form.Handle);
            var files = (System.Collections.ArrayList)result["data"];
            bool filesOk = files.Count == 4;
            foreach (var file in files) filesOk &= (bool)((System.Collections.Generic.Dictionary<string, object>)file)["ok"];
            bool ok = sizingOk && invisible && filesOk && attached && child && (bool)result["secure"] && (bool)result["layout"] && (int)result["cards"] == 4 && !(bool)result["overflow"] && (string)result["localStorage"] == "ok";
            File.WriteAllText(Program.TestOutput, Program.Json.Serialize(new { ok, desktopAttached = attached, childWindow = child, hiddenWindow = invisible, sizing = new { nativeResize, minimum, maximum, lockedSize, restoreSize, compactMigration }, runtime = form.Core.Environment.BrowserVersionString, page = result }));
            Environment.ExitCode = ok ? 0 : 1;
        } catch (Exception ex) { File.WriteAllText(Program.TestOutput, Program.Json.Serialize(new { ok = false, error = ex.ToString(), nativeError = ex is System.ComponentModel.Win32Exception ? ((System.ComponentModel.Win32Exception)ex).NativeErrorCode : 0 })); Environment.ExitCode = 1; }
        finally { ExitThread(); }
    }
    protected override void ExitThreadCore() { timeout.Stop(); timeout.Dispose(); form.Dispose(); base.ExitThreadCore(); }
}

static class Native
{
    internal delegate bool EnumProc(IntPtr hwnd, IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string name, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string name, string title);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)] static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    internal static void Attach(IntPtr child, IntPtr parent)
    {
        if (!IsWindow(parent)) throw new InvalidOperationException("桌面层句柄无效。");
        var style = GetWindowLongPtr(child, -16).ToInt64();
        SetWindowLongPtr(child, -16, new IntPtr((style & ~0x80000000L) | 0x40000000L));
        SetParent(child, parent);
        if (GetParent(child) != parent) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "未能挂接桌面层。");
    }
    [DllImport("user32.dll")] internal static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] internal static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr order, int x, int y, int width, int height, uint flags);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    // DefView 是桌面图标层；挂在它内部，不挂到图标后方的壁纸层。
    internal static IntPtr FindDesktop()
    {
        IntPtr result = FindWindowEx(FindWindow("Progman", null), IntPtr.Zero, "SHELLDLL_DefView", null);
        if (result != IntPtr.Zero) return result;
        EnumWindows((window, value) => { result = FindWindowEx(window, IntPtr.Zero, "SHELLDLL_DefView", null); return result == IntPtr.Zero; }, IntPtr.Zero);
        return result;
    }
    internal static Rectangle Bounds(IntPtr hwnd) { RECT r; GetWindowRect(hwnd, out r); return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom); }
    internal static void Place(IntPtr hwnd, IntPtr parent, Point location, Size size)
    {
        var point = new POINT { X = location.X, Y = location.Y };
        if (parent != IntPtr.Zero) ScreenToClient(parent, ref point);
        if (!SetWindowPos(hwnd, IntPtr.Zero, point.X, point.Y, size.Width, size.Height, 0x10)) throw new InvalidOperationException("未能定位桌面窗口。");
    }
}

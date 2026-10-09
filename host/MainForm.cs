using System.ComponentModel;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace EveSandbox;

/// <summary>
/// 主窗口：WebView2 承载 UI，并把页面发来的 StatOracle 请求转发给 Python 子进程。
///
/// 离线保证（§11.2）：
///   · UI 通过虚拟主机名 eve.sandbox 从本地文件夹加载，不经过 HTTP 服务；
///   · 一切非 eve.sandbox 的导航与开新窗口请求都被拒绝；
///   · WebView2 以关闭后台联网特性的参数启动。
/// </summary>
public sealed class MainForm : Form
{
    private const string VirtualHost = "eve.sandbox";
    private const string EntryUrl = $"https://{VirtualHost}/index.html";

    /// <summary>
    /// 让窗口把**自身内容**渲染进目标 DC（PW_RENDERFULLCONTENT = 2），
    /// 不要求窗口处于最前台，也不会抓到叠在它上面的别的窗口。
    /// </summary>
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    // 以下属性是"运行时配置"，不是设计器属性 → 显式声明不参与设计器序列化（WFO1000）
    /// <summary>无人值守验收模式：自动加载页面、采集诊断、写出报告后退出。</summary>
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    [Browsable(false)]
    public bool VerifyMode { get; init; }

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    [Browsable(false)]
    public int VerifySeconds { get; init; } = 24;

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    [Browsable(false)]
    public string VerifyScenario { get; init; } = "line-brawl";

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    [Browsable(false)]
    public int VerifyUnitsPerSide { get; init; }

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    [Browsable(false)]
    public string? VerifyReportPath { get; init; }

    /// <summary>分辨率/DPI/双屏验收模式：逐显示器移动窗口、采集度量并截图。</summary>
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
    [Browsable(false)]
    public bool VerifyDisplayMode { get; init; }

    private readonly AppConfig _cfg;
    private readonly OracleHost _oracle;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly StatusStrip _status = new();
    private readonly ToolStripStatusLabel _lblPyfa = new() { Text = "PYFA --" };
    private readonly ToolStripStatusLabel _lblState = new() { Text = "核心：未启动" };
    private readonly ToolStripStatusLabel _lblMsg = new() { Text = "", Spring = true, TextAlign = ContentAlignment.MiddleLeft };
    private readonly bool _devMode;
    private bool _browserReady;

    public MainForm(AppConfig cfg)
    {
        _cfg = cfg;
        _oracle = new OracleHost(cfg);
        _oracle.Log += OnOracleLog;
        _devMode = Environment.GetEnvironmentVariable("EVESANDBOX_DEV") == "1";

        Text = "EVE战局沙盘推演 V0.8（完全离线）";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(1024, 700);
        Size = new Size(1680, 980);
        BackColor = Color.FromArgb(6, 9, 16);

        BuildMenu();
        BuildStatus();

        Controls.Add(_web);
        Controls.Add(_status);
        MainMenuStrip = _menu;

        // ★ 停靠顺序是这里唯一的坑，别动：
        //   WinForms 按「控件集合的倒序」停靠 —— 排在最后的先占外边缘，排最前的最后
        //   被停靠、只拿到剩余区域。上面 BuildMenu/BuildStatus 已经各 Add 过一次，
        //   所以此刻集合可能是 [_menu, _web, _status]：倒序就是先 _status 占底边、
        //   再 _web(Fill) 占**从客户区 y=0 开始**的整块，最后 _menu 才占顶边 ——
        //   菜单栏于是直接压在 webview 顶部菜单栏那么高的地方。
        //   表现：页面顶栏（EVE 战局沙盒推演 / ①数据导入…④推演）被盖掉大半，
        //   只剩一条缝，用户看不到标签页、页面整体上移、底部被挤掉。
        //   必须让 Fill 的 webview 排在首位（最后停靠），菜单与状态栏排在它后面。
        Controls.SetChildIndex(_web, 0);
        Controls.SetChildIndex(_menu, 1);
        Controls.SetChildIndex(_status, 2);
        PerformLayout();

        Shown += async (_, _) => await InitBrowserAsync();
        FormClosing += (_, _) => _oracle.Dispose();
    }

    private MenuStrip _menu = new();

    private void BuildMenu()
    {
        _menu = new MenuStrip { BackColor = Color.FromArgb(13, 21, 36), ForeColor = Color.FromArgb(214, 226, 245) };

        var file = new ToolStripMenuItem("文件(&F)");
        file.DropDownItems.Add(MenuItem("重新载入界面(&R)\tF5", () => Reload()));
        file.DropDownItems.Add(new ToolStripSeparator());
        file.DropDownItems.Add(MenuItem("退出(&X)", () => Close()));

        var settings = new ToolStripMenuItem("设置(&S)");
        settings.DropDownItems.Add(MenuItem("统计核心与目录…(&P)", () => OpenSettings()));
        settings.DropDownItems.Add(MenuItem("重启 StatOracle(&R)", () =>
        {
            _oracle.Restart();
            SetState("核心：已重启（下次请求时重新拉起）");
        }));

        var help = new ToolStripMenuItem("帮助(&H)");
        help.DropDownItems.Add(MenuItem("关于 / 免责声明 / 合规(&A)", () => ShowAbout()));
        help.DropDownItems.Add(MenuItem("打开配置目录(&C)", () => OpenFolder(AppConfig.ConfigDir)));
        help.DropDownItems.Add(MenuItem("打开核心缓存目录(&W)", () => OpenFolder(_cfg.ResolvedCoreWorkDir)));
        if (_devMode) help.DropDownItems.Add(MenuItem("开发者工具(&D)", () => _web.CoreWebView2?.OpenDevToolsWindow()));

        _menu.Items.Add(file);
        _menu.Items.Add(settings);
        _menu.Items.Add(help);
        MainMenuStrip = _menu;
        Controls.Add(_menu);
    }

    private static ToolStripMenuItem MenuItem(string text, Action run)
    {
        var it = new ToolStripMenuItem(text);
        it.Click += (_, _) => run();
        return it;
    }

    private void BuildStatus()
    {
        _status.BackColor = Color.FromArgb(12, 18, 30);
        _status.ForeColor = Color.FromArgb(143, 163, 192);
        _status.Items.AddRange(new ToolStripItem[] { _lblPyfa, _lblState, _lblMsg });
        _status.SizingGrip = false;
    }

    // ------------------------------------------------------------------ 浏览器

    private async Task InitBrowserAsync()
    {
        try
        {
            var userData = Path.Combine(AppConfig.ConfigDir, "WebView2");
            Directory.CreateDirectory(userData);
            var options = new CoreWebView2EnvironmentOptions(
                "--disable-background-networking --disable-component-update --disable-sync "
                + "--no-first-run --disable-features=SmartScreen,EdgeShoppingAssistant");
            var env = await CoreWebView2Environment.CreateAsync(null, userData, options);

            await _web.EnsureCoreWebView2Async(env);
            var core = _web.CoreWebView2;

            core.Settings.AreDevToolsEnabled = _devMode;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsSwipeNavigationEnabled = false;

            core.SetVirtualHostNameToFolderMapping(
                VirtualHost, Paths.UiDir, CoreWebView2HostResourceAccessKind.DenyCors);

            core.NavigationStarting += (_, e) =>
            {
                if (e.Uri.StartsWith($"https://{VirtualHost}/", StringComparison.OrdinalIgnoreCase)) return;
                if (e.Uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return;
                e.Cancel = true;
                SetMessage($"已拦截外部导航：{e.Uri}");
            };
            core.NewWindowRequested += (_, e) => { e.Handled = true; };
            core.PermissionRequested += (_, e) => { e.State = CoreWebView2PermissionState.Deny; };
            core.ProcessFailed += (_, e) => SetMessage($"WebView2 进程异常：{e.ProcessFailedKind}");
            core.WebMessageReceived += OnWebMessage;
            core.DocumentTitleChanged += (_, _) => { if (!string.IsNullOrWhiteSpace(core.DocumentTitle)) Text = core.DocumentTitle + "（完全离线）"; };

            _browserReady = true;
            core.Navigate(EntryUrl);
            if (VerifyDisplayMode) _ = RunVerifyDisplayAsync();
            else if (VerifyMode) _ = RunVerifyAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "无法初始化 WebView2 运行时。\n\n"
                + "本软件依赖 Microsoft Edge WebView2 Runtime（Windows 10/11 通常已预装）。\n"
                + "请安装后重试。\n\n详细信息：" + ex.Message,
                "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private void Reload()
    {
        if (_browserReady) _web.CoreWebView2.Reload();
    }

    private readonly List<string> _hostLog = new();

    private void HLog(string line)
    {
        lock (_hostLog)
        {
            _hostLog.Add($"{DateTime.Now:HH:mm:ss.fff} {line}");
            if (_hostLog.Count > 400) _hostLog.RemoveRange(0, 200);
        }
    }

    /// <summary>页面的 StatOracle 请求 → Python 子进程 → 回传。</summary>
    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // 页面用 chrome.webview.postMessage(字符串) 发送：此时 WebMessageAsJson 是
        // 一个 JSON 字符串字面量，必须先取回原字符串再解析。两种形态都兼容。
        JsonObject? msg = null;
        try
        {
            var asString = e.TryGetWebMessageAsString();
            msg = JsonNode.Parse(asString) as JsonObject;
        }
        catch
        {
            // 不是字符串消息 → 走对象形态
        }
        if (msg is null)
        {
            try
            {
                msg = JsonNode.Parse(e.WebMessageAsJson) as JsonObject;
            }
            catch
            {
                return;
            }
        }
        if (msg is null) return;
        var kind = msg["kind"]?.GetValue<string>();
        if (kind != "oracle")
        {
            HLog($"[页面] 收到非 oracle 消息：{kind}");
            return;
        }
        if (msg["id"] is not JsonValue idv || !idv.TryGetValue(out int id)) return;
        var payload = msg["payload"] as JsonObject ?? new JsonObject();
        HLog($"[页面] oracle 请求 id={id} op={payload["op"]}");

        var reply = new JsonObject { ["kind"] = "oracle", ["id"] = id };
        try
        {
            SetState("核心：查询中…");
            var resp = await _oracle.RequestAsync(payload);
            foreach (var kv in resp)
            {
                if (kv.Key == "id") continue;
                reply[kv.Key] = kv.Value?.DeepClone();
            }
            if (!reply.ContainsKey("ok")) reply["ok"] = true;
            SetState($"核心：运行中（{_oracle.RequestsServed} 次请求）");
        }
        catch (Exception ex)
        {
            reply["ok"] = false;
            reply["error"] = new JsonObject { ["code"] = "HOST_FAILED", ["message"] = ex.Message };
            SetState("核心：请求失败");
            SetMessage(ex.Message);
        }

        try
        {
            _web.CoreWebView2?.PostWebMessageAsJson(reply.ToJsonString());
        }
        catch
        {
            // 窗口已关闭
        }
    }

    /// <summary>无人值守验收的退出码：0 = 通过。</summary>
    public int VerifyExitCode { get; private set; } = 1;

    /// <summary>
    /// 分辨率 / DPI / 双屏验收：逐显示器把窗口移过去，采集页面度量（devicePixelRatio、
    /// 画布后备分辨率、是否溢出、图标加载数）并各自截图，供目视检查。
    /// </summary>
    private async Task RunVerifyDisplayAsync()
    {
        var report = new List<string>();
        void Log(string s) => report.Add(s);
        var core = _web.CoreWebView2;

        Log("宿主 分辨率 / DPI / 双屏 验收");
        Log($"进程 DPI 模式：{Application.HighDpiMode}");
        var screens = Screen.AllScreens;
        Log($"显示器数量：{screens.Length}");
        foreach (var sc in screens)
        {
            Log($"  {sc.DeviceName}：边界 {sc.Bounds.Width}×{sc.Bounds.Height}"
                + $" @({sc.Bounds.X},{sc.Bounds.Y})，工作区 {sc.WorkingArea.Width}×{sc.WorkingArea.Height}"
                + $"，主显示器={sc.Primary}");
        }

        var outDir = Path.GetDirectoryName(VerifyReportPath) ?? ".";
        Directory.CreateDirectory(outDir);

        // ★ 必须先等页面脚本把 __ui 挂上：在此之前下发场景指令只是空操作。
        for (int i = 0; i < 80; i++)
        {
            await Task.Delay(500);
            var probe = await core.ExecuteScriptAsync("!!(window.__ui && window.__ui.metrics)");
            if (probe.Contains("true", StringComparison.Ordinal)) break;
        }

        // 切到指定场景并推进（与手动操作同一条通路）
        var unitsArg = VerifyUnitsPerSide > 0 ? $", {VerifyUnitsPerSide}" : "";
        // ★ 载入场景后必须切到「④ 推演」页：沙盘画布不在推演页时是 display:none，
        //   量到的 canvasCssW/BackingH 全是 0，画布清晰度一项会无端判失败。
        await core.ExecuteScriptAsync(
            $"window.__ui && window.__ui.loadScenario('{VerifyScenario}'{unitsArg}); "
            + "window.__ui && window.__ui.page('sim'); "
            + "window.__ui && window.__ui.speed(15); true");

        // 等场景重建完成。含旗舰编成时要现算属性（每个新配装一次 PYFA 查询），
        // 因此给足时间；等到"单位数不再变化"为止，而不是只等一个固定秒数。
        var lastUnits = -1;
        var stable = 0;
        for (int i = 0; i < 45; i++)
        {
            await Task.Delay(1000);
            var probe = await MetricsAsync();
            var m = System.Text.RegularExpressions.Regex.Match(probe, "\"units\":(\\d+)");
            var n = m.Success ? int.Parse(m.Groups[1].Value) : -1;
            if (n > 0 && n == lastUnits) stable++;
            else stable = 0;
            lastUnits = n;
            if (stable >= 2) break;
        }
        Log($"场景 '{VerifyScenario}' 就绪，单位数 {lastUnits}");
        await core.ExecuteScriptAsync("window.__ui && window.__ui.fit(); true");
        await Task.Delay(500);

        async Task<string> MetricsAsync()
        {
            try
            {
                var raw = await core.ExecuteScriptAsync(
                    "JSON.stringify(window.__ui && window.__ui.metrics ? window.__ui.metrics() : null)");
                return System.Text.Json.JsonSerializer.Deserialize<string>(raw) ?? "null";
            }
            catch (Exception ex)
            {
                return "metrics 失败：" + ex.Message;
            }
        }

        async Task<string?> ShotAsync(string name)
        {
            try
            {
                var path = Path.Combine(outDir, name);
                using var ms = new MemoryStream();
                await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, ms);
                await File.WriteAllBytesAsync(path, ms.ToArray());
                return path;
            }
            catch (Exception ex)
            {
                Log("  截图失败：" + ex.Message);
                return null;
            }
        }

        var metrics = new List<(string Where, string Json)>();
        var geoms = new List<(string Where, string Json, bool Ok)>();

        // ★ 原生控件几何：webview 顶边必须落在菜单栏下沿之下、底边落在状态栏上沿之上。
        //   不算这一项的话，"菜单栏压住页面顶栏（①数据导入…④推演 标签页看不到）"
        //   这类**原生遮挡**在 CapturePreviewAsync 的截图里完全看不出来 ——
        //   它抓的是 webview 自己的画面，不包含窗口上的原生控件。
        string GeometryJson()
        {
            var ok = _web.Top >= _menu.Bottom - 1 && _web.Bottom <= _status.Top + 1 && _web.Height > 200;
            return $"{{\"clientH\":{ClientSize.Height},\"menuBottom\":{_menu.Bottom},"
                + $"\"webTop\":{_web.Top},\"webH\":{_web.Height},\"webBottom\":{_web.Bottom},"
                + $"\"statusTop\":{_status.Top},\"webTopOk\":{(ok ? "true" : "false")}}}";
        }

        // 整窗截图（含原生菜单栏 / 状态栏）：抓"菜单栏盖住页面顶栏"的视觉结果。
        // ★ 用 PrintWindow(PW_RENDERFULLCONTENT) 让窗口自己渲染，而不是 CopyFromScreen：
        //   屏幕拷贝要求窗口在最前台，验收跑在后台时会把**别的窗口**拍进来（截图完全失真）。
        void ShotWindow(string name)
        {
            var path = Path.Combine(outDir, $"window-{name}.png");
            try
            {
                var r = Bounds;
                using var bmp = new System.Drawing.Bitmap(Math.Max(1, r.Width), Math.Max(1, r.Height));
                using (var g = System.Drawing.Graphics.FromImage(bmp))
                {
                    var hdc = g.GetHdc();
                    bool printed;
                    try { printed = PrintWindow(Handle, hdc, 2); }
                    finally { g.ReleaseHdc(hdc); }
                    if (!printed) g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(r.Width, r.Height));
                }
                bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
                Log($"  整窗截图：window-{name}.png");
            }
            catch (Exception ex) { Log("  整窗截图失败：" + ex.Message); }
        }

        for (int i = 0; i < screens.Length; i++)
        {
            var sc = screens[i];
            var wa = sc.WorkingArea;
            var w = Math.Min(wa.Width, 1680);
            var h = Math.Min(wa.Height, 980);
            Bounds = new Rectangle(wa.X + (wa.Width - w) / 2, wa.Y + (wa.Height - h) / 2, w, h);
            await Task.Delay(1200);
            var m = await MetricsAsync();
            metrics.Add(($"显示器{i} {sc.DeviceName} {Bounds.Width}×{Bounds.Height}", m));
            Log($"[显示器{i}] 窗口 {Bounds.Width}×{Bounds.Height} → {m}");
            Log("  截图：" + (await ShotAsync($"display-{i}.png") ?? "（失败）"));
            var g0 = GeometryJson();
            geoms.Add(($"显示器{i}", g0, g0.Contains("\"webTopOk\":true", StringComparison.Ordinal)));
            Log("  控件几何：" + g0);
            ShotWindow($"display-{i}");
        }

        // 常规使用形态：最大化
        WindowState = FormWindowState.Maximized;
        await Task.Delay(1200);
        var maxed = await MetricsAsync();
        metrics.Add(("最大化", maxed));
        Log($"[最大化] → {maxed}");
        Log("  截图：" + (await ShotAsync("display-maximized.png") ?? "（失败）"));
        var g1 = GeometryJson();
        geoms.Add(("最大化", g1, g1.Contains("\"webTopOk\":true", StringComparison.Ordinal)));
        Log("  控件几何：" + g1);
        ShotWindow("maximized");

        // 判定：画布清晰（后备 = CSS×dpr）、无溢出、图标全部加载、场景已加载
        bool Has(string json, string needle) => json.Contains(needle, StringComparison.Ordinal);
        // 页面收到的地物数 == 场景配置里的地物数
        bool LandmarksOk(string json)
        {
            int Grab(string key)
            {
                var m = System.Text.RegularExpressions.Regex.Match(json, $"\"{key}\":(\\d+)");
                return m.Success ? int.Parse(m.Groups[1].Value) : -1;
            }
            var actual = Grab("celestials");
            var expected = Grab("landmarksExpected");
            return actual >= 0 && expected >= 0 && actual == expected;
        }
        // 舰队是否真的落在可视范围内。有单位但这项是 0，说明取景塌陷（缩得太远 /
        // 单位被压成亚像素）—— 用户看到的就是"沙盘里一条船都没有"。
        int UnitsOnScreen(string json)
        {
            var m = System.Text.RegularExpressions.Regex.Match(json, "\"unitsOnScreen\":(\\d+)");
            return m.Success ? int.Parse(m.Groups[1].Value) : -1;
        }
        var checks = new List<(string Name, bool Pass, string Detail)>
        {
            ("画布后备分辨率与 DPR 匹配（不发虚）",
                metrics.All((x) => Has(x.Json, "\"canvasCrisp\":true")), ""),
            ("无横向溢出（三栏不被挤破）",
                metrics.All((x) => Has(x.Json, "\"overflowX\":false")), ""),
            ("无纵向溢出",
                metrics.All((x) => Has(x.Json, "\"overflowY\":false")), ""),
            ("16 个吨位线稿全部加载",
                metrics.All((x) => Has(x.Json, "\"loaded\":16")), ""),
            ("场景单位已加载", metrics.All((x) => Has(x.Json, "\"units\":") && !Has(x.Json, "\"units\":0")), ""),
            // 地物数与**场景配置**一致（有的场景本就没有地物，不能写死 3，
            // 否则无地物的场景会被误判为失败）
            ("地物下发与场景配置一致（星门/空间站）",
                metrics.All((x) => LandmarksOk(x.Json)), ""),
            // 舰队要真的"看得见"：有单位 ≠ 看得到（取景塌陷会把它们压成亚像素）
            ("舰队在可视范围内（看得见）",
                metrics.All((x) => UnitsOnScreen(x.Json) > 0),
                string.Join(" | ", metrics.Select((x) => $"{x.Where} onScreen={UnitsOnScreen(x.Json)}"))),
            // 原生外壳几何：菜单栏 / 状态栏不得压住 webview，否则页面顶栏的
            // ①数据导入…④推演 标签页会被盖住（用户看不到标签页）。
            ("菜单栏与状态栏未压住页面（标签页可见）",
                geoms.All((g) => g.Ok), string.Join(" | ", geoms.Select((g) => $"{g.Where} {g.Json}"))),
        };

        Log("");
        Log("== 验收结果 ==");
        foreach (var (name, pass, detail) in checks)
        {
            Log($"  [{(pass ? "PASS" : "FAIL")}] {name} {detail}");
            if (!pass) VerifyExitCode = 1;
        }
        if (checks.All((c) => c.Pass)) VerifyExitCode = 0;

        Log("");
        Log("== 各形态原始度量 ==");
        foreach (var (where, json) in metrics) Log($"  {where}\n    {json}");

        try
        {
            File.WriteAllLines(VerifyReportPath!, report, System.Text.Encoding.UTF8);
        }
        catch { /* 忽略 */ }

        Close();
    }

    /// <summary>
    /// 无人值守验收：加载页面 → 切换场景 → 等待就绪 → 观察 N 秒 → 采集异常与帧率 → 写报告并退出。
    /// 走的是与手动操作**完全相同**的通路（页面 → 宿主桥 → WebView2 → Python 子进程）。
    /// </summary>
    private async Task RunVerifyAsync()
    {
        var report = new List<string>();
        void Log(string s) => report.Add(s);
        var pageErrors = new List<string>();
        var core = _web.CoreWebView2;

        try
        {
            var logRx = core.GetDevToolsProtocolEventReceiver("Log.entryAdded");
            logRx.DevToolsProtocolEventReceived += (_, e) =>
            {
                var t = e.ParameterObjectAsJson;
                if (t.Contains("\"level\":\"error\"", StringComparison.Ordinal)) pageErrors.Add(t);
            };
            await core.CallDevToolsProtocolMethodAsync("Log.enable", "{}");
            var exRx = core.GetDevToolsProtocolEventReceiver("Runtime.exceptionThrown");
            exRx.DevToolsProtocolEventReceived += (_, e) => pageErrors.Add(e.ParameterObjectAsJson);
            await core.CallDevToolsProtocolMethodAsync("Runtime.enable", "{}");
        }
        catch (Exception ex)
        {
            Log("（无法启用 CDP 异常采集：" + ex.Message + "）");
        }

        Log($"宿主验收开始：场景={VerifyScenario} 每方={VerifyUnitsPerSide} 观察={VerifySeconds}s");
        Log($"UI 目录：{Paths.UiDir}");
        Log($"PYFA 目录：{_cfg.PyfaDir}");

        async Task<string> DiagAsync()
        {
            try
            {
                var raw = await core.ExecuteScriptAsync("document.getElementById('diag')?.textContent ?? ''");
                return System.Text.Json.JsonSerializer.Deserialize<string>(raw) ?? "";
            }
            catch (Exception ex)
            {
                return "eval 失败：" + ex.Message;
            }
        }

        // 1) 等待页面脚本就绪（`#diag` 被填充）
        var ok = false;
        for (int i = 0; i < 60; i++)
        {
            await Task.Delay(500);
            var d = await DiagAsync();
            if (d.Contains("\"units\":")) { ok = true; break; }
        }
        Log(ok ? "✓ 页面脚本已就绪" : "✗ 页面脚本未就绪");

        // 2) 切换场景（与 UI 的 __ui 钩子同路）
        var unitsArg = VerifyUnitsPerSide > 0 ? $", {VerifyUnitsPerSide}" : "";
        // 同样要切到推演页：画布隐藏时量不到画布指标、帧率也没有意义
        await core.ExecuteScriptAsync(
            $"window.__ui && window.__ui.loadScenario('{VerifyScenario}'{unitsArg}); "
            + "window.__ui && window.__ui.page('sim'); "
            + "window.__ui && window.__ui.speed(15); true");

        string last = "";
        for (int i = 0; i < 90; i++)
        {
            await Task.Delay(1000);
            last = await DiagAsync();
            var m = System.Text.RegularExpressions.Regex.Match(last, "\"units\":(\\d+)");
            var mAlive = System.Text.RegularExpressions.Regex.Match(last, "\"alive\":(\\d+)");
            if (m.Success && int.Parse(m.Groups[1].Value) > 0
                && mAlive.Success && int.Parse(mAlive.Groups[1].Value) < int.Parse(m.Groups[1].Value))
                break;   // 单位已加载且已开始出现战损 → 推演真的在跑
        }
        Log("场景就绪：" + last);

        // 3) 观察窗口：采集帧率
        var fpsMax = 0;
        var samples = new List<string>();
        for (int i = 0; i < VerifySeconds; i++)
        {
            await Task.Delay(1000);
            last = await DiagAsync();
            samples.Add(last);
            var f = System.Text.RegularExpressions.Regex.Match(last, "\"fps\":(\\d+)");
            if (f.Success) fpsMax = Math.Max(fpsMax, int.Parse(f.Groups[1].Value));
        }
        Log($"观察结束。峰值 fps = {fpsMax}");
        Log("最终诊断：" + last);

        var tick = System.Text.RegularExpressions.Regex.Match(last, "\"tick\":(\\d+)");
        var units = System.Text.RegularExpressions.Regex.Match(last, "\"units\":(\\d+)");
        var alive = System.Text.RegularExpressions.Regex.Match(last, "\"alive\":(\\d+)");
        var errs = System.Text.RegularExpressions.Regex.Match(last, "\"errors\":\\[([^\\]]*)\\]");

        var checks = new List<(string Name, bool Pass, string Detail)>();
        checks.Add(("页面脚本就绪", ok, ""));
        checks.Add(("场景已加载", units.Success && int.Parse(units.Groups[1].Value) > 0, "units=" + (units.Success ? units.Groups[1].Value : "?")));
        checks.Add(("推演已推进", tick.Success && int.Parse(tick.Groups[1].Value) > 0, "tick=" + (tick.Success ? tick.Groups[1].Value : "?")));
        checks.Add(("发生战损", units.Success && alive.Success && int.Parse(alive.Groups[1].Value) < int.Parse(units.Groups[1].Value),
            $"alive={alive.Groups[1].Value}/units={units.Groups[1].Value}"));
        checks.Add(("帧率 ≥ 30", fpsMax >= 30, "fpsMax=" + fpsMax));
        checks.Add(("页面无脚本错误", errs.Success && errs.Groups[1].Value.Trim().Length == 0,
            errs.Success ? errs.Groups[1].Value : "（未能读取）"));
        checks.Add(("宿主侧无异常", pageErrors.Count == 0, pageErrors.Count + " 条"));
        checks.Add(("StatOracle 有提供服务", _oracle.RequestsServed > 0, $"PYFA {_oracle.PyfaVersion}，{_oracle.RequestsServed} 次请求"));

        Log("");
        Log("== 验收结果 ==");
        foreach (var (name, pass, detail) in checks)
        {
            Log($"  [{(pass ? "PASS" : "FAIL")}] {name} {detail}");
            if (!pass) VerifyExitCode = 1;
        }
        if (checks.All((c) => c.Pass)) VerifyExitCode = 0;
        if (pageErrors.Count > 0)
        {
            Log("宿主采集到的页面异常：");
            foreach (var e in pageErrors.Take(8)) Log("   " + (e.Length > 300 ? e[..300] : e));
        }
        Log("样本数：" + samples.Count);

        Log("");
        Log("== 宿主日志（末尾 40 条） ==");
        lock (_hostLog)
        {
            foreach (var l in _hostLog.TakeLast(40)) Log("  " + l);
        }

        try
        {
            if (!string.IsNullOrEmpty(VerifyReportPath))
                File.WriteAllLines(VerifyReportPath!, report, System.Text.Encoding.UTF8);
        }
        catch { /* 忽略 */ }

        Close();
    }

    private void OnOracleLog(string line)
    {
        HLog("[核心] " + line);
        SafeInvoke(() =>
        {
            SetMessage(line);
            if (line.Contains("就绪", StringComparison.Ordinal))
            {
                _lblPyfa.Text = $"PYFA {_oracle.PyfaVersion}";
                SetState("核心：就绪");
            }
        });
    }

    // ------------------------------------------------------------------ 杂项

    private void OpenSettings()
    {
        using var dlg = new SettingsForm(_cfg, firstRun: false);
        if (dlg.ShowDialog(this) == DialogResult.OK)
        {
            dlg.Result.Save();
            _oracle.Restart();
            SetState("核心：设置已更新（下次请求时重新拉起）");
        }
    }

    private void ShowAbout()
    {
        using var dlg = new AboutForm(_cfg, requireAccept: false);
        dlg.ShowDialog(this);
    }

    private void OpenFolder(string dir)
    {
        try
        {
            Directory.CreateDirectory(dir);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(dir) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "无法打开目录");
        }
    }

    private void SafeInvoke(Action a)
    {
        if (IsDisposed) return;
        try
        {
            if (InvokeRequired) BeginInvoke(a);
            else a();
        }
        catch
        {
            // 窗口正在销毁
        }
    }

    private void SetState(string text) => SafeInvoke(() => _lblState.Text = text);

    private void SetMessage(string text)
    {
        SafeInvoke(() => _lblMsg.Text = text.Length > 200 ? text[..200] : text);
    }
}

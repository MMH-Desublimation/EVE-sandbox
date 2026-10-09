namespace EveSandbox;

internal static class Program
{
    /// <summary>取命令行开关值，如 <c>--seconds 20</c>。</summary>
    private static string? Opt(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();

        var args = Environment.GetCommandLineArgs().Skip(1).ToArray();
        var verify = args.Contains("--verify");

        // 发行包自检：缺少随包资源时给出明确指引，而不是启动后白屏
        var uiEntry = Path.Combine(Paths.UiDir, "index.html");
        if (!File.Exists(Paths.SidecarScript) || !File.Exists(uiEntry))
        {
            var msg = "发行包不完整，缺少随包资源：\n\n"
                      + $"  sidecar：{Paths.SidecarScript}\n"
                      + $"  ui     ：{uiEntry}\n\n"
                      + "请确认解压完整，且 ui 与 sidecar 目录与 EveSandbox.exe 同级。";
            if (verify) Console.Error.WriteLine(msg);
            else MessageBox.Show(msg, "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Environment.ExitCode = 2;
            return;
        }

        var cfg = AppConfig.Load();

        // 1) 配置向导（首次运行，或已有配置已失效）
        var needWizard = !cfg.IsConfigured;
        if (!needWizard)
        {
            if (!PyfaLocator.Validate(cfg.PyfaDir, out _, out _)) needWizard = true;
            else if (!PythonLocator.Validate(cfg.PythonExe, out _, out _)) needWizard = true;
        }

        if (needWizard && verify)
        {
            // 无人值守：自动探测并落盘；失败则直接以错误码退出，便于 CI 判断
            var pyfa = PyfaLocator.Detect(cfg.PyfaDir, out _);
            var py = PythonLocator.Detect(cfg.PythonExe, out _);
            if (pyfa is null || py is null)
            {
                var err = $"自动探测失败：PYFA={(pyfa ?? "未找到")} Python={(py ?? "未找到")}";
                var report = Opt(args, "--report");
                if (report is not null) File.WriteAllText(report, err);
                Console.Error.WriteLine(err);
                Environment.ExitCode = 3;
                return;
            }
            cfg.PyfaDir = pyfa;
            cfg.PythonExe = py;
            cfg.AcceptedDisclaimer = true;
            cfg.Save();
        }
        else if (needWizard)
        {
            using var wizard = new SettingsForm(cfg, firstRun: true);
            if (wizard.ShowDialog() != DialogResult.OK) return;
            cfg = wizard.Result;
            cfg.Save();
        }

        // 2) 免责声明（§11.3 / D-41）：首次运行必须明确同意
        if (!cfg.AcceptedDisclaimer)
        {
            if (verify)
            {
                cfg.AcceptedDisclaimer = true;
                cfg.Save();
            }
            else
            {
                using var about = new AboutForm(cfg, requireAccept: true);
                if (about.ShowDialog() != DialogResult.OK) return;
                cfg.AcceptedDisclaimer = true;
                cfg.Save();
            }
        }

        try
        {
            if (!verify)
            {
                Application.Run(new MainForm(cfg));
                return;
            }

            var form = new MainForm(cfg)
            {
                VerifyMode = true,
                VerifyDisplayMode = args.Contains("--display"),
                VerifySeconds = int.TryParse(Opt(args, "--seconds"), out var s) ? s : 24,
                VerifyScenario = Opt(args, "--scenario") ?? "line-brawl",
                VerifyUnitsPerSide = int.TryParse(Opt(args, "--units"), out var u) ? u : 0,
                VerifyReportPath = Opt(args, "--report"),
                ShowInTaskbar = true,
            };
            Application.Run(form);
            Environment.ExitCode = form.VerifyExitCode;
        }
        catch (Exception ex)
        {
            MessageBox.Show("程序异常退出：\n\n" + ex, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Environment.ExitCode = 9;
        }
    }
}

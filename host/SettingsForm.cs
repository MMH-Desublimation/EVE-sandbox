namespace EveSandbox;

/// <summary>
/// 设置向导：指定 PYFA 安装目录与 Python 3.14 解释器。
///
/// ★ 本软件**不随包分发 PYFA 代码**，因此首次启动必须由用户指定自己的 PYFA 安装。
///   核心在用户机器上现场提取（见 sidecar/pyfa_core.py），不构成 GPLv3 再分发。
/// </summary>
public sealed class SettingsForm : Form
{
    private readonly AppConfig _cfg;
    private readonly TextBox _txtPyfa = new() { Dock = DockStyle.Fill };
    private readonly TextBox _txtPython = new() { Dock = DockStyle.Fill };
    private readonly TextBox _txtWork = new() { Dock = DockStyle.Fill };
    private readonly Label _lblStatus = new()
    {
        Dock = DockStyle.Fill,
        AutoSize = false,
        Height = 66,
        ForeColor = Color.FromArgb(90, 110, 140),
        Text = "PYFA 为 GPLv3 授权。本软件不随包分发其代码，仅调用你本机安装的 PYFA。",
    };

    public AppConfig Result { get; private set; }

    public SettingsForm(AppConfig cfg, bool firstRun)
    {
        _cfg = cfg;
        Result = Clone(cfg);

        Text = firstRun ? "首次运行：指定 PYFA 安装目录" : "设置";
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ClientSize = new Size(700, 330);
        Font = new Font("Microsoft YaHei UI", 9f);

        _txtPyfa.Text = cfg.PyfaDir ?? "";
        _txtPython.Text = cfg.PythonExe ?? "";
        _txtWork.Text = cfg.CoreWorkDir ?? "";

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(14),
            ColumnCount = 3,
            RowCount = 6,
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130));
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));

        var hint = new Label
        {
            Dock = DockStyle.Fill,
            Height = 44,
            ForeColor = Color.FromArgb(70, 90, 120),
            Text = "PYFA 安装目录 = 含 pyfa.exe 与 app\\ 子目录的那个文件夹。\n"
                 + "Python 必须为 3.14.x（与 PYFA 内嵌运行时同版本，否则无法加载其字节码）。",
        };
        root.Controls.Add(hint, 0, 0);
        root.SetColumnSpan(hint, 3);

        root.Controls.Add(RowLabel("PYFA 安装目录"), 0, 1);
        root.Controls.Add(_txtPyfa, 1, 1);
        root.Controls.Add(BrowseButton(() => PickFolder(_txtPyfa)), 2, 1);

        root.Controls.Add(RowLabel("Python 3.14 解释器"), 0, 2);
        root.Controls.Add(_txtPython, 1, 2);
        root.Controls.Add(BrowseButton(() => PickPython()), 2, 2);

        root.Controls.Add(RowLabel("核心缓存目录（可空）"), 0, 3);
        root.Controls.Add(_txtWork, 1, 3);
        root.Controls.Add(BrowseButton(() => PickFolder(_txtWork)), 2, 3);

        var detect = new Button { Text = "自动探测", AutoSize = true };
        detect.Click += (_, _) => AutoDetect();
        var check = new Button { Text = "检查", AutoSize = true };
        check.Click += (_, _) => ValidateNow(showDialog: true);
        var detectRow = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true };
        detectRow.Controls.Add(detect);
        detectRow.Controls.Add(check);
        root.Controls.Add(detectRow, 1, 4);

        root.Controls.Add(_lblStatus, 0, 5);
        root.SetColumnSpan(_lblStatus, 3);

        var ok = new Button { Text = "保存并启动", DialogResult = DialogResult.None, AutoSize = true };
        ok.Click += (_, _) => Confirm();
        var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, AutoSize = true };
        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            FlowDirection = FlowDirection.RightToLeft,
            Height = 46,
            Padding = new Padding(10),
        };
        buttons.Controls.Add(ok);
        buttons.Controls.Add(cancel);

        Controls.Add(root);
        Controls.Add(buttons);
        AcceptButton = ok;
        CancelButton = cancel;

        if (firstRun) Shown += (_, _) => AutoDetect();
    }

    private static Label RowLabel(string text) => new()
    {
        Text = text,
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleLeft,
        AutoSize = false,
    };

    private static Button BrowseButton(Action onClick)
    {
        var b = new Button { Text = "浏览…", Dock = DockStyle.Fill };
        b.Click += (_, _) => onClick();
        return b;
    }

    private static AppConfig Clone(AppConfig c) => new()
    {
        PyfaDir = c.PyfaDir,
        PythonExe = c.PythonExe,
        CoreWorkDir = c.CoreWorkDir,
        AcceptedDisclaimer = c.AcceptedDisclaimer,
        MaxRequestsPerProcess = c.MaxRequestsPerProcess,
        LastPyfaVersion = c.LastPyfaVersion,
    };

    private void PickFolder(TextBox target)
    {
        using var dlg = new FolderBrowserDialog
        {
            Description = "选择 PYFA 安装目录（含 pyfa.exe）",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = false,
        };
        if (Directory.Exists(target.Text)) dlg.SelectedPath = target.Text;
        if (dlg.ShowDialog(this) == DialogResult.OK) target.Text = dlg.SelectedPath;
    }

    private void PickPython()
    {
        using var dlg = new OpenFileDialog
        {
            Title = "选择 Python 3.14 解释器",
            Filter = "python.exe|python.exe|所有文件|*.*",
        };
        if (dlg.ShowDialog(this) == DialogResult.OK) _txtPython.Text = dlg.FileName;
    }

    private void AutoDetect()
    {
        UseWaitCursor = true;
        try
        {
            var pyfa = PyfaLocator.Detect(_txtPyfa.Text, out var ver);
            if (pyfa is not null)
            {
                _txtPyfa.Text = pyfa;
                _lblStatus.Text = $"已找到 PYFA {ver}：{pyfa}";
                _lblStatus.ForeColor = Color.FromArgb(40, 130, 90);
            }
            var py = PythonLocator.Detect(_txtPython.Text, out var pyver);
            if (py is not null)
            {
                _txtPython.Text = py;
                _lblStatus.Text += $"\n已找到 Python {pyver}：{py}";
                _lblStatus.ForeColor = Color.FromArgb(40, 130, 90);
            }
            if (pyfa is null && py is null)
            {
                _lblStatus.Text = "未能自动找到，请手动指定。";
                _lblStatus.ForeColor = Color.FromArgb(170, 90, 40);
            }
            else if (pyfa is null || py is null)
            {
                _lblStatus.Text += "\n（还有一项未能自动找到，请手动指定）";
                _lblStatus.ForeColor = Color.FromArgb(170, 90, 40);
            }
        }
        finally
        {
            UseWaitCursor = false;
        }
    }

    private bool ValidateNow(bool showDialog)
    {
        var okPyfa = PyfaLocator.Validate(_txtPyfa.Text, out var ver, out var errPyfa);
        var okPy = PythonLocator.Validate(_txtPython.Text, out var pyver, out var errPy);

        var lines = new List<string>();
        lines.Add(okPyfa ? $"✓ PYFA {ver}" : $"✗ PYFA：{errPyfa}");
        lines.Add(okPy ? $"✓ Python {pyver}" : $"✗ Python：{errPy}");
        _lblStatus.Text = string.Join("\n", lines);

        var ok = okPyfa && okPy;
        _lblStatus.ForeColor = ok ? Color.FromArgb(40, 130, 90) : Color.FromArgb(180, 70, 60);
        if (!ok && showDialog)
        {
            MessageBox.Show(string.Join("\n", lines), "检查未通过", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        return ok;
    }

    private void Confirm()
    {
        if (!ValidateNow(showDialog: true)) return;
        Result = Clone(_cfg);
        Result.PyfaDir = _txtPyfa.Text.Trim();
        Result.PythonExe = _txtPython.Text.Trim();
        Result.CoreWorkDir = string.IsNullOrWhiteSpace(_txtWork.Text) ? null : _txtWork.Text.Trim();
        DialogResult = DialogResult.OK;
        Close();
    }
}

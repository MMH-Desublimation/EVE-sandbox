using System.Diagnostics;

namespace EveSandbox;

/// <summary>
/// 关于 / 免责声明 / 合规信息（交接文档 §11.3、D-41）。
/// 首次启动时要求用户明确同意。
/// </summary>
public sealed class AboutForm : Form
{
    private const string Disclaimer =
        "本软件使用 PYFA 作为数值计算引擎。PYFA 是对 EVE Online 的高精度近似，"
        + "与游戏服务器真值可能存在微小差异。本软件用于战术推演与教学，"
        + "不适用于对真实战报的逐项复现。";

    public AboutForm(AppConfig cfg, bool requireAccept)
    {
        Text = requireAccept ? "使用前请阅读" : "关于 / 免责声明 / 合规";
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(720, 520);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        Font = new Font("Microsoft YaHei UI", 9f);

        var text = new TextBox
        {
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            Dock = DockStyle.Fill,
            BackColor = Color.White,
            BorderStyle = BorderStyle.None,
            Text = BuildText(cfg),
        };

        var copy = new Button { Text = "复制 PYFA 源码地址", AutoSize = true };
        copy.Click += (_, _) =>
        {
            try
            {
                Clipboard.SetText("https://github.com/pyfa-org/PyFA");
            }
            catch { /* 忽略 */ }
        };

        var openNotice = new Button { Text = "打开合规说明文件", AutoSize = true };
        openNotice.Click += (_, _) => OpenComplianceFolder();

        var accept = new Button
        {
            Text = requireAccept ? "我已阅读并同意" : "关闭",
            AutoSize = true,
            DialogResult = requireAccept ? DialogResult.OK : DialogResult.Cancel,
        };

        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            FlowDirection = FlowDirection.RightToLeft,
            Height = 50,
            Padding = new Padding(12),
        };
        buttons.Controls.Add(accept);
        buttons.Controls.Add(openNotice);
        buttons.Controls.Add(copy);

        var wrap = new Panel { Dock = DockStyle.Fill, Padding = new Padding(14) };
        wrap.Controls.Add(text);

        Controls.Add(wrap);
        Controls.Add(buttons);
        AcceptButton = accept;
        CancelButton = requireAccept ? null : accept;
    }

    private static void OpenComplianceFolder()
    {
        try
        {
            var dir = Paths.ComplianceDir;
            if (Directory.Exists(dir))
            {
                Process.Start(new ProcessStartInfo(dir) { UseShellExecute = true });
                return;
            }
            MessageBox.Show("未找到 compliance 目录，请查看发行包内的 NOTICE.md。",
                "合规说明", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "无法打开", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private static string BuildText(AppConfig cfg)
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine("EVE 战局沙盒推演");
        sb.AppendLine("一个用于《EVE Online》舰队交火预演的桌面沙盒（完全离线）。");
        sb.AppendLine();
        sb.AppendLine("────────────────  免责声明  ────────────────");
        sb.AppendLine(Disclaimer);
        sb.AppendLine();
        sb.AppendLine("────────────────  数值来源  ────────────────");
        sb.AppendLine("数值由 PYFA（Python Fitting Assistant）计算。PYFA 以 GPLv3 授权。");
        sb.AppendLine("★ 本软件**不随包分发 PYFA 的任何代码**。");
        sb.AppendLine("  统计核心来自你自己安装的 PYFA，并在你的机器上现场提取与调用。");
        sb.AppendLine("  因此本软件与 PYFA 之间是「独立程序在运行时互相调用」的关系，");
        sb.AppendLine("  不构成 GPLv3 意义上的再分发或衍生作品。");
        sb.AppendLine();
        sb.AppendLine($"  PYFA 安装目录：{cfg.PyfaDir ?? "（未设置）"}");
        sb.AppendLine($"  PYFA 版本　　：{cfg.LastPyfaVersion ?? "（未知）"}");
        sb.AppendLine($"  PYFA 源码途径：https://github.com/pyfa-org/PyFA");
        sb.AppendLine();
        sb.AppendLine("────────────────  离线保证  ────────────────");
        sb.AppendLine("· 本软件完全无联网行为，也没有任何自动更新检查；");
        sb.AppendLine("· 界面从本地文件夹加载，不经过任何 HTTP 服务；");
        sb.AppendLine("· 所有外部导航请求都会被拒绝；");
        sb.AppendLine("· 「更新 PYFA」= 在设置中指向你本机的新目录，不会下载任何东西。");
        sb.AppendLine();
        sb.AppendLine("────────────────  开源  ────────────────");
        sb.AppendLine("本软件自身开源（GitHub 免费公开）。");
        sb.AppendLine();
        sb.AppendLine("────────────────  操作  ────────────────");
        sb.AppendLine("左键选择 · Ctrl+左键框选 · 中键拖拽平移 · 滚轮缩放 · 右键指令");
        sb.AppendLine("空格播放/暂停 · Ctrl+1~8 编组、1~8 选组 · Esc 取消选择");
        sb.AppendLine("装备/武器按钮：左键开停，右键换弹药");
        return sb.ToString();
    }
}

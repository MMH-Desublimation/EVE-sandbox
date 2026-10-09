using System.Text.Json;
using System.Text.Json.Serialization;

namespace EveSandbox;

/// <summary>
/// 宿主配置（持久化到 %APPDATA%\EveSandbox\config.json）。
///
/// ★ 本软件**不随包分发 PYFA 代码**：首次启动由用户指定自己的 PYFA 安装目录
///   （见 D-01/D-02 的用户决议），核心在用户机器上现场提取，因此不构成 GPLv3 再分发。
/// </summary>
public sealed class AppConfig
{
    /// <summary>PYFA 安装目录（含 pyfa.exe 与 app/），由用户指定。</summary>
    public string? PyfaDir { get; set; }

    /// <summary>Python 3.14 解释器（必须与 PYFA 内嵌运行时同版本，否则无法加载其字节码）。</summary>
    public string? PythonExe { get; set; }

    /// <summary>无头核心工作目录（提取产物缓存）。为空则用 %LOCALAPPDATA%\EveSandbox\core。</summary>
    public string? CoreWorkDir { get; set; }

    /// <summary>是否已接受免责声明（§11.3）。</summary>
    public bool AcceptedDisclaimer { get; set; }

    /// <summary>子进程处理多少次请求后主动重启（防内存增长与状态污染，见交接文档 §3.4）。</summary>
    public int MaxRequestsPerProcess { get; set; } = 3000;

    /// <summary>上次记录的 PYFA 版本（用于存档版本一致性提示）。</summary>
    public string? LastPyfaVersion { get; set; }

    [JsonIgnore]
    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(PyfaDir) && !string.IsNullOrWhiteSpace(PythonExe);

    public static string ConfigDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "EveSandbox");

    public static string ConfigPath => Path.Combine(ConfigDir, "config.json");

    /// <summary>核心缓存的实际落点（计算属性，**不写进配置文件**）。</summary>
    [JsonIgnore]
    public string ResolvedCoreWorkDir =>
        string.IsNullOrWhiteSpace(CoreWorkDir)
            ? Path.Combine(ConfigDir, "core")
            : CoreWorkDir;

    public static AppConfig Load()
    {
        try
        {
            if (File.Exists(ConfigPath))
            {
                var json = File.ReadAllText(ConfigPath);
                var cfg = JsonSerializer.Deserialize<AppConfig>(json);
                if (cfg is not null) return cfg;
            }
        }
        catch
        {
            // 配置损坏 → 回到默认，交给设置向导修复
        }
        return new AppConfig();
    }

    public void Save()
    {
        Directory.CreateDirectory(ConfigDir);
        var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(ConfigPath, json);
    }
}

/// <summary>定位随包资源（ui 产物与 sidecar 脚本），同时支持开发运行与发布运行。</summary>
public static class Paths
{
    /// <summary>
    /// 从 exe 所在目录向上寻找"同时含 <c>sidecar/pyfa_oracle.py</c> 与 <c>ui/index.html</c>"的目录。
    /// 发布形态下就是 exe 同级的发行目录；开发形态下是仓库根。
    /// </summary>
    public static string? FindAppRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
        {
            var sidecar = Path.Combine(dir.FullName, "sidecar", "pyfa_oracle.py");
            if (File.Exists(sidecar)) return dir.FullName;
        }
        return null;
    }

    public static string AppRoot => FindAppRoot() ?? AppContext.BaseDirectory;

    /// <summary>UI 产物目录（优先 dist/ui，其次 ui）。</summary>
    public static string UiDir
    {
        get
        {
            var root = AppRoot;
            foreach (var candidate in new[] { Path.Combine(root, "ui"), Path.Combine(root, "dist", "ui") })
            {
                if (File.Exists(Path.Combine(candidate, "index.html"))) return candidate;
            }
            return Path.Combine(root, "dist", "ui");
        }
    }

    public static string SidecarDir => Path.Combine(AppRoot, "sidecar");

    public static string SidecarScript => Path.Combine(SidecarDir, "pyfa_oracle.py");

    public static string ComplianceDir => Path.Combine(AppRoot, "compliance");
}

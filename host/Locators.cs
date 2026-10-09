using System.Diagnostics;
using System.Text;

namespace EveSandbox;

/// <summary>PYFA 安装目录的探测与校验。</summary>
public static class PyfaLocator
{
    /// <summary>校验一个目录是否为有效的 PYFA 安装目录。</summary>
    public static bool Validate(string? dir, out string version, out string error)
    {
        version = "";
        error = "";
        if (string.IsNullOrWhiteSpace(dir))
        {
            error = "未指定目录";
            return false;
        }
        if (!Directory.Exists(dir))
        {
            error = "目录不存在";
            return false;
        }
        var exe = Path.Combine(dir, "pyfa.exe");
        if (!File.Exists(exe))
        {
            error = "该目录下没有 pyfa.exe（请选择 pyfa.exe 所在的目录，通常以 pyfa 结尾）";
            return false;
        }
        var versionFile = Path.Combine(dir, "app", "version.yml");
        if (!File.Exists(versionFile))
        {
            error = "该目录下没有 app\\version.yml，可能不是完整的 PYFA 安装";
            return false;
        }
        try
        {
            foreach (var line in File.ReadAllLines(versionFile))
            {
                var t = line.Trim();
                if (t.StartsWith("version:", StringComparison.OrdinalIgnoreCase))
                {
                    version = t[8..].Trim().Trim('"', '\'');
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            error = "读取 version.yml 失败：" + ex.Message;
            return false;
        }
        if (string.IsNullOrEmpty(version))
        {
            error = "version.yml 中没有版本号";
            return false;
        }
        return true;
    }

    /// <summary>自动探测：先看配置，再看环境变量，最后在常见位置做有界搜索。</summary>
    public static string? Detect(string? configured, out string version, TimeSpan? budget = null)
    {
        version = "";
        if (Validate(configured, out version, out _)) return configured;

        var env = Environment.GetEnvironmentVariable("PYFA_DIR");
        if (Validate(env, out version, out _)) return env;

        foreach (var cand in CommonCandidates())
        {
            if (Validate(cand, out version, out _)) return cand;
        }

        var found = Search(budget ?? TimeSpan.FromSeconds(2.0));
        if (found is not null && Validate(found, out version, out _)) return found;
        return null;
    }

    private static IEnumerable<string> CommonCandidates()
    {
        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);

        yield return Path.Combine(pf, "pyfa");
        yield return Path.Combine(pf86, "pyfa");
        yield return Path.Combine(pf, "PYFA");
        yield return Path.Combine(desktop, "pyfa");
        yield return Path.Combine(docs, "pyfa");
        yield return Path.Combine(desktop, "eve  pyfa", "pyfa");
        yield return @"D:\eve  pyfa\pyfa";
        yield return @"C:\eve  pyfa\pyfa";
        yield return @"D:\pyfa\pyfa";
        yield return @"C:\pyfa\pyfa";
    }

    /// <summary>在各固定磁盘根做深度受限的 BFS（跳过系统目录），找 pyfa.exe 的父目录。</summary>
    private static string? Search(TimeSpan budget)
    {
        var sw = Stopwatch.StartNew();
        var skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "windows", "program files", "program files (x86)", "programdata",
            "$recycle.bin", "system volume information", "node_modules", "appdata",
            "perflogs", "msys64", "python312", "python313",
        };

        foreach (var drive in DriveInfo.GetDrives())
        {
            if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;
            var queue = new Queue<(string Dir, int Depth)>();
            queue.Enqueue((drive.RootDirectory.FullName, 0));
            while (queue.Count > 0)
            {
                if (sw.Elapsed > budget) return null;
                var (dir, depth) = queue.Dequeue();
                IEnumerable<string> subs;
                try
                {
                    subs = Directory.EnumerateDirectories(dir);
                }
                catch
                {
                    continue;
                }
                foreach (var sub in subs)
                {
                    var name = Path.GetFileName(sub);
                    if (skip.Contains(name) || name.StartsWith('.')) continue;
                    try
                    {
                        if (File.Exists(Path.Combine(sub, "pyfa.exe"))) return sub;
                    }
                    catch
                    {
                        continue;
                    }
                    if (depth + 1 < 3) queue.Enqueue((sub, depth + 1));
                }
            }
        }
        return null;
    }
}

/// <summary>Python 3.14 解释器的探测与校验（必须与 PYFA 内嵌运行时同版本）。</summary>
public static class PythonLocator
{
    public const string RequiredMajorMinor = "3.14";

    public static bool Validate(string? exe, out string version, out string error)
    {
        version = "";
        error = "";
        if (string.IsNullOrWhiteSpace(exe))
        {
            error = "未指定解释器";
            return false;
        }
        if (!File.Exists(exe))
        {
            error = "文件不存在";
            return false;
        }
        var (ok, stdout, stderr) = RunCapture(exe, new[] { "-c", "import sys;print('%d.%d'%sys.version_info[:2])" }, 8000);
        if (!ok)
        {
            error = string.IsNullOrWhiteSpace(stderr) ? "无法执行该解释器" : stderr.Trim();
            return false;
        }
        version = stdout.Trim();
        if (version != RequiredMajorMinor)
        {
            error = $"需要 Python {RequiredMajorMinor}.x（与 PYFA 内嵌运行时一致），当前为 {version}";
            return false;
        }
        return true;
    }

    public static string? Detect(string? configured, out string version)
    {
        version = "";
        if (Validate(configured, out version, out _)) return configured;

        var env = Environment.GetEnvironmentVariable("PYFA_PYTHON");
        if (Validate(env, out version, out _)) return env;

        // 1) py 启动器指定的 3.14
        var pyLauncher = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows), "py.exe");
        if (File.Exists(pyLauncher))
        {
            var (ok, stdout, _) = RunCapture(pyLauncher,
                new[] { "-3.14", "-c", "import sys;print(sys.executable)" }, 8000);
            var cand = ok ? stdout.Trim() : "";
            if (Validate(cand, out version, out _)) return cand;
        }

        // 2) 常见安装位置
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var roots = new List<string>
        {
            Path.Combine(local, "Python", "pythoncore-3.14-64", "python.exe"),
            Path.Combine(local, "Programs", "Python", "Python314", "python.exe"),
            @"C:\Python314\python.exe",
            @"C:\Program Files\Python314\python.exe",
        };
        var pyRoot = Path.Combine(local, "Python");
        if (Directory.Exists(pyRoot))
        {
            try
            {
                foreach (var d in Directory.EnumerateDirectories(pyRoot, "pythoncore-3.14*"))
                    roots.Add(Path.Combine(d, "python.exe"));
            }
            catch { /* 忽略 */ }
        }
        foreach (var cand in roots)
        {
            if (Validate(cand, out version, out _)) return cand;
        }
        return null;
    }

    public static (bool Ok, string StdOut, string StdErr) RunCapture(string exe, string[] args, int timeoutMs)
    {
        try
        {
            var psi = new ProcessStartInfo(exe)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi);
            if (p is null) return (false, "", "");
            var stdout = p.StandardOutput.ReadToEnd();
            var stderr = p.StandardError.ReadToEnd();
            if (!p.WaitForExit(timeoutMs))
            {
                try { p.Kill(true); } catch { /* 忽略 */ }
                return (false, stdout, "执行超时");
            }
            return (p.ExitCode == 0, stdout, stderr);
        }
        catch (Exception ex)
        {
            return (false, "", ex.Message);
        }
    }
}

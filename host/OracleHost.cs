using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace EveSandbox;

/// <summary>
/// StatOracle 子进程宿主（交接文档 §3.4 进程模型）。
///
/// 职责：
///   · 拉起 / 停止 Python 侧的无头 PYFA 核心（stdin/stdout，每行一个 JSON）；
///   · 处理 N 次请求后主动重启（防内存增长与状态污染）；
///   · 崩溃恢复：进程异常退出 → 重启 → 重放未完成请求（calcFit 幂等，安全）。
/// </summary>
public sealed class OracleHost : IDisposable
{
    private readonly AppConfig _cfg;
    private readonly SemaphoreSlim _startLock = new(1, 1);
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonObject>> _pending = new();

    private Process? _proc;
    private TaskCompletionSource<string>? _ready;
    private int _nextId;

    public string PyfaVersion { get; private set; } = "";
    public int RequestsServed { get; private set; }
    public bool IsRunning => _proc is { HasExited: false };
    public event Action<string>? Log;

    public OracleHost(AppConfig cfg)
    {
        _cfg = cfg;
    }

    private void Emit(string msg) => Log?.Invoke(msg);

    // ------------------------------------------------------------------ 启动

    public async Task<string> EnsureStartedAsync(CancellationToken ct = default)
    {
        await _startLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (IsRunning && _ready is { Task.IsCompletedSuccessfully: true })
                return PyfaVersion;

            Directory.CreateDirectory(_cfg.ResolvedCoreWorkDir);

            var psi = new ProcessStartInfo(_cfg.PythonExe!)
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = Paths.AppRoot,
            };
            psi.ArgumentList.Add(Paths.SidecarScript);
            psi.ArgumentList.Add("--pyfa-dir");
            psi.ArgumentList.Add(_cfg.PyfaDir!);
            psi.ArgumentList.Add("--work-dir");
            psi.ArgumentList.Add(_cfg.ResolvedCoreWorkDir);
            psi.ArgumentList.Add("--max-requests");
            psi.ArgumentList.Add(_cfg.MaxRequestsPerProcess.ToString());
            psi.Environment["PYTHONUTF8"] = "1";
            psi.Environment["PYTHONIOENCODING"] = "utf-8";
            psi.Environment["PYTHONUNBUFFERED"] = "1";

            var cold = !File.Exists(Path.Combine(_cfg.ResolvedCoreWorkDir, "core.meta.json"));
            Emit(cold
                ? "首次启动：正在从 PYFA 提取无头计算核心（约 1 分钟）…"
                : "正在启动 StatOracle…");

            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            _ready = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            _proc = proc;

            proc.OutputDataReceived += (_, e) => { if (e.Data is not null) OnStdoutLine(e.Data); };
            proc.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) Emit(e.Data.Trim()); };
            proc.Exited += (_, _) => OnExited();

            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            var timeout = TimeSpan.FromSeconds(cold ? 300 : 90);
            var readyTask = _ready.Task;
            var done = await Task.WhenAny(readyTask, Task.Delay(timeout, ct)).ConfigureAwait(false);
            if (done != readyTask)
            {
                try { proc.Kill(true); } catch { /* 忽略 */ }
                throw new TimeoutException(cold
                    ? "提取 PYFA 核心超时。请确认 PYFA 安装目录正确且可读。"
                    : "StatOracle 启动超时。");
            }
            PyfaVersion = await readyTask.ConfigureAwait(false);
            _cfg.LastPyfaVersion = PyfaVersion;
            Emit($"StatOracle 就绪（PYFA {PyfaVersion}）");
            return PyfaVersion;
        }
        finally
        {
            _startLock.Release();
        }
    }

    // ------------------------------------------------------------------ 通信

    private void OnStdoutLine(string line)
    {
        var text = line.Trim();
        if (text.Length == 0) return;
        JsonObject? msg;
        try
        {
            msg = JsonNode.Parse(text) as JsonObject;
        }
        catch
        {
            Emit("[协议] 非法 JSON 行：" + text[..Math.Min(160, text.Length)]);
            return;
        }
        if (msg is null) return;

        if (msg["ready"]?.GetValue<bool>() == true)
        {
            _ready?.TrySetResult(msg["pyfaVersion"]?.GetValue<string>() ?? "unknown");
            return;
        }
        if (msg["id"] is not JsonValue idv || !idv.TryGetValue(out int id)) return;
        if (_pending.TryRemove(id, out var tcs)) tcs.TrySetResult(msg);
    }

    private void OnExited()
    {
        var code = -1;
        try { code = _proc?.ExitCode ?? -1; } catch { /* 忽略 */ }
        Emit($"[宿主] StatOracle 子进程退出（code={code}）");
        _ready = null;
        foreach (var kv in _pending)
        {
            kv.Value.TrySetException(new IOException("StatOracle 子进程已退出"));
        }
        _pending.Clear();
    }

    public void Restart()
    {
        try
        {
            if (_proc is { HasExited: false }) _proc.Kill(true);
        }
        catch { /* 忽略 */ }
        _proc = null;
        _ready = null;
    }

    /// <summary>发送一条请求并等待响应。首次失败会自动重启并重试一次（calcFit 幂等）。</summary>
    public async Task<JsonObject> RequestAsync(JsonObject payload, CancellationToken ct = default)
    {
        Exception? last = null;
        for (int attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                await EnsureStartedAsync(ct).ConfigureAwait(false);

                var id = Interlocked.Increment(ref _nextId);
                var body = new JsonObject();
                foreach (var kv in payload) body[kv.Key] = kv.Value?.DeepClone();
                body["id"] = id;

                var tcs = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
                _pending[id] = tcs;

                await _writeLock.WaitAsync(ct).ConfigureAwait(false);
                try
                {
                    await _proc!.StandardInput.WriteLineAsync(body.ToJsonString()).ConfigureAwait(false);
                    await _proc.StandardInput.FlushAsync(ct).ConfigureAwait(false);
                }
                finally
                {
                    _writeLock.Release();
                }

                var longCall = TimeSpan.FromSeconds(180);
                var done = await Task.WhenAny(tcs.Task, Task.Delay(longCall, ct)).ConfigureAwait(false);
                if (done != tcs.Task)
                {
                    _pending.TryRemove(id, out _);
                    throw new TimeoutException("StatOracle 响应超时");
                }

                RequestsServed++;
                var result = await tcs.Task.ConfigureAwait(false);

                // 达到重启阈值：让下一次请求走冷启动（子进程按需重启）
                if (_cfg.MaxRequestsPerProcess > 0 && RequestsServed >= _cfg.MaxRequestsPerProcess)
                {
                    Emit($"已达 {_cfg.MaxRequestsPerProcess} 次请求，重启子进程以释放内存");
                    Restart();
                }
                return result;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                last = ex;
                if (attempt == 0)
                {
                    Emit($"[宿主] 请求失败（{ex.Message}），重启子进程后重试一次");
                    Restart();
                }
            }
        }
        throw last ?? new IOException("StatOracle 请求失败");
    }

    public void Dispose() => Restart();
}

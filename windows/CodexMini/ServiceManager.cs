using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Forms;

namespace CodexMiniWin;

internal enum ServiceState
{
    NotInstalled,
    Running,
    Stopped,
    Unknown
}

internal sealed record ServiceSnapshot(
    ServiceState State,
    bool HealthOk,
    int Port,
    int? Pid,
    int? ThreadCount,
    string LatestThreadTitle,
    string LogPreview,
    DateTime LastUpdated
);

internal sealed class ServiceManager
{
    private const string AppName = "Codex Max";
    private const int DefaultPort = 8787;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true
    };

    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private readonly string appDataDir;
    private readonly string logsDir;
    private readonly string installDir;
    private readonly string configPath;
    private readonly string stdoutPath;
    private readonly string stderrPath;
    private readonly string embeddedProjectDir;
    private readonly string sourceProjectDir;
    private readonly string embeddedNodePath;
    private readonly string appDataNodePath;

    public ServiceManager()
    {
        appDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppName);
        logsDir = Path.Combine(appDataDir, "logs");
        installDir = Path.Combine(appDataDir, "service");
        configPath = Path.Combine(appDataDir, "launcher.json");
        stdoutPath = Path.Combine(logsDir, "service.out.log");
        stderrPath = Path.Combine(logsDir, "service.err.log");
        embeddedProjectDir = Path.Combine(AppContext.BaseDirectory, "Resources", "CodexMaxProject");
        sourceProjectDir = FindSourceProjectDir(AppContext.BaseDirectory);
        embeddedNodePath = Path.Combine(AppContext.BaseDirectory, "Resources", "node", "node.exe");
        appDataNodePath = Path.Combine(appDataDir, "node", "node.exe");
    }

    public string ShortInstallDirectory => installDir;
    public string LogsDirectory => logsDir;

    public async Task PrepareIfNeededAsync()
    {
        Directory.CreateDirectory(appDataDir);
        Directory.CreateDirectory(logsDir);
        var config = ReadConfig();
        WriteConfig(config);
        if (Directory.Exists(embeddedProjectDir) && File.Exists(Path.Combine(embeddedProjectDir, "server.js")))
        {
            CopyDirectory(embeddedProjectDir, installDir);
        }
        else
        {
            ExtractEmbeddedPayloadIfNeeded();
        }
        await Task.CompletedTask;
    }

    public async Task<ServiceSnapshot> RefreshAsync()
    {
        var config = ReadConfig();
        var state = ResolveState(config);
        var healthOk = await CheckHealthAsync(config);
        var (threadCount, latestThreadTitle) = healthOk
            ? await RefreshThreadsAsync(config)
            : (null, "尚未读取线程");
        return new ServiceSnapshot(
            healthOk ? ServiceState.Running : state,
            healthOk,
            config.Port,
            ResolvePid(config),
            threadCount,
            latestThreadTitle,
            ReadLogPreview(),
            DateTime.Now
        );
    }

    public async Task StartAsync()
    {
        await PrepareIfNeededAsync();
        var config = ReadConfig();
        if (await CheckHealthAsync(config)) return;

        var existingPid = FindPortOwnerPid(config.Port);
        if (existingPid > 0)
        {
            if (!IsLikelyCodexMiniService(existingPid))
            {
                throw new InvalidOperationException($"端口 {config.Port} 已被其他程序占用（PID {existingPid}），无法启动 Codex Max。");
            }

            await KillProcessTreeAsync(existingPid);
            await Task.Delay(500);
        }

        var projectDir = ResolveServiceProjectDir();
        var serverPath = Path.Combine(projectDir, "server.js");
        if (!File.Exists(serverPath))
        {
            throw new InvalidOperationException("没有找到内嵌服务文件 server.js。");
        }

        var nodePath = ResolveNodePath();
        var start = new ProcessStartInfo(nodePath)
        {
            WorkingDirectory = projectDir,
            CreateNoWindow = true,
            UseShellExecute = false,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.ArgumentList.Add("server.js");
        start.Environment["MOBILE_TYPER_TOKEN"] = config.Token;
        start.Environment["PORT"] = config.Port.ToString();
        start.Environment["CODEX_MAX_APP_NAME"] = AppName;
        start.Environment["CODEX_MAX_STATE_DIR"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex-max");

        var process = Process.Start(start) ?? throw new InvalidOperationException("启动 Codex Max 服务失败。");
        _ = Task.Run(() => AppendProcessOutputAsync(process.StandardOutput, stdoutPath));
        _ = Task.Run(() => AppendProcessOutputAsync(process.StandardError, stderrPath));
        config.Pid = process.Id;
        WriteConfig(config);

        for (var i = 0; i < 24; i++)
        {
            await Task.Delay(250);
            if (await CheckHealthAsync(config)) return;
        }

        throw new InvalidOperationException("Codex Max 服务启动后没有通过健康检查。" + Environment.NewLine + ReadTail(stderrPath, 1200));
    }

    public async Task StopAsync()
    {
        var config = ReadConfig();
        var pids = new HashSet<int>();
        if (config.Pid > 0) pids.Add(config.Pid);
        var portPid = FindPortOwnerPid(config.Port);
        if (portPid > 0) pids.Add(portPid);

        foreach (var pid in pids)
        {
            await KillProcessTreeAsync(pid);
        }

        config.Pid = 0;
        WriteConfig(config);
        await Task.Delay(350);
    }

    public async Task RestartAsync()
    {
        await StopAsync();
        await Task.Delay(350);
        await StartAsync();
    }

    public async Task OpenWebAsync()
    {
        if (!await CheckHealthAsync(ReadConfig())) await StartAsync();
        Process.Start(new ProcessStartInfo(PrimaryEntryUrl()) { UseShellExecute = true });
    }

    public async Task CopyLocalLinkAsync()
    {
        if (!await CheckHealthAsync(ReadConfig())) await StartAsync();
        Clipboard.SetText(PrimaryEntryUrl());
    }

    public void OpenLogs()
    {
        Directory.CreateDirectory(logsDir);
        Process.Start(new ProcessStartInfo(logsDir) { UseShellExecute = true });
    }

    public string PrimaryEntryUrl()
    {
        var urls = EntryUrls().ToList();
        return urls.Count > 1 ? urls[1] : urls[0];
    }

    public IEnumerable<string> EntryUrls()
    {
        var config = ReadConfig();
        var token = Uri.EscapeDataString(config.Token);
        yield return $"http://localhost:{config.Port}/?token={token}";
        foreach (var address in LanAddresses())
        {
            yield return $"http://{address}:{config.Port}/?token={token}";
        }
    }

    private async Task<bool> CheckHealthAsync(LauncherConfig config)
    {
        try
        {
            using var response = await http.GetAsync($"http://127.0.0.1:{config.Port}/codex/health?token={Uri.EscapeDataString(config.Token)}");
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private async Task<(int? Count, string LatestTitle)> RefreshThreadsAsync(LauncherConfig config)
    {
        try
        {
            var url = $"http://127.0.0.1:{config.Port}/codex/threads?limit=20&token={Uri.EscapeDataString(config.Token)}";
            var summary = await http.GetFromJsonAsync<ThreadSummary>(url);
            var rows = summary?.Threads ?? new List<ThreadRow>();
            var title = rows.FirstOrDefault()?.Title ?? rows.FirstOrDefault()?.Name ?? "暂无线程";
            return (rows.Count, title);
        }
        catch
        {
            return (null, "尚未读取线程");
        }
    }

    private LauncherConfig ReadConfig()
    {
        try
        {
            if (File.Exists(configPath))
            {
                var loaded = JsonSerializer.Deserialize<LauncherConfig>(File.ReadAllText(configPath), JsonOptions);
                if (loaded is not null && !string.IsNullOrWhiteSpace(loaded.Token))
                {
                    if (loaded.Port <= 0) loaded.Port = DefaultPort;
                    return loaded;
                }
            }
        }
        catch
        {
        }
        return new LauncherConfig { Token = GenerateToken(), Port = DefaultPort };
    }

    private void WriteConfig(LauncherConfig config)
    {
        Directory.CreateDirectory(appDataDir);
        File.WriteAllText(configPath, JsonSerializer.Serialize(config, JsonOptions), new UTF8Encoding(false));
    }

    private ServiceState ResolveState(LauncherConfig config)
    {
        if (!File.Exists(Path.Combine(ResolveServiceProjectDir(), "server.js"))) return ServiceState.NotInstalled;
        var pid = ResolvePid(config);
        return pid.HasValue ? ServiceState.Running : ServiceState.Stopped;
    }

    private int? ResolvePid(LauncherConfig config)
    {
        var portPid = FindPortOwnerPid(config.Port);
        if (portPid > 0) return portPid;
        if (config.Pid > 0)
        {
            try
            {
                using var process = Process.GetProcessById(config.Pid);
                if (!process.HasExited) return config.Pid;
            }
            catch
            {
            }
        }
        return null;
    }

    private string ResolveServiceProjectDir()
    {
        if (Directory.Exists(installDir) && File.Exists(Path.Combine(installDir, "server.js"))) return installDir;
        if (Directory.Exists(embeddedProjectDir) && File.Exists(Path.Combine(embeddedProjectDir, "server.js"))) return embeddedProjectDir;
        return sourceProjectDir;
    }

    private string ResolveNodePath()
    {
        if (File.Exists(appDataNodePath)) return appDataNodePath;
        if (File.Exists(embeddedNodePath)) return embeddedNodePath;
        var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim(), "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        throw new InvalidOperationException("没有找到 Node.js。请安装 Node.js 18+，或在 App 资源中内置 node.exe。");
    }

    private void ExtractEmbeddedPayloadIfNeeded()
    {
        var assembly = typeof(ServiceManager).Assembly;
        using var stream = assembly.GetManifestResourceStream("CodexMaxPayload.zip");
        if (stream is null) return;

        using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
        foreach (var entry in archive.Entries)
        {
            if (string.IsNullOrWhiteSpace(entry.Name)) continue;
            var relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
            var target = Path.GetFullPath(Path.Combine(appDataDir, relative));
            var appDataRoot = Path.GetFullPath(appDataDir);
            if (!target.StartsWith(appDataRoot, StringComparison.OrdinalIgnoreCase)) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, overwrite: true);
        }
    }

    private string ReadLogPreview()
    {
        foreach (var file in new[] { stderrPath, stdoutPath })
        {
            var text = ReadTail(file, 1200).Trim();
            if (!string.IsNullOrWhiteSpace(text)) return text;
        }
        return "";
    }

    private static string ReadTail(string file, int maxChars)
    {
        try
        {
            if (!File.Exists(file)) return "";
            var text = File.ReadAllText(file);
            return text.Length <= maxChars ? text : text[^maxChars..];
        }
        catch
        {
            return "";
        }
    }

    private static string GenerateToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(18);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static string FindSourceProjectDir(string start)
    {
        var current = new DirectoryInfo(start);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "server.js")) &&
                Directory.Exists(Path.Combine(current.FullName, "public")))
            {
                return current.FullName;
            }
            current = current.Parent;
        }
        return start;
    }

    private static IEnumerable<string> LanAddresses()
    {
        var rows = NetworkInterface.GetAllNetworkInterfaces()
            .Where(item => item.OperationalStatus == OperationalStatus.Up)
            .SelectMany(item => item.GetIPProperties().UnicastAddresses)
            .Where(item => item.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
            .Select(item => item.Address)
            .Where(IsUsableLanAddress)
            .Select(address => address.ToString())
            .Distinct()
            .ToList();

        return rows
            .OrderBy(address => LanAddressPriority(address))
            .ThenBy(address => address, StringComparer.Ordinal);
    }

    private static bool IsUsableLanAddress(IPAddress address)
    {
        if (IPAddress.IsLoopback(address)) return false;
        var bytes = address.GetAddressBytes();
        if (bytes.Length != 4) return false;
        if (bytes[0] == 169 && bytes[1] == 254) return false;
        if (bytes[0] == 198 && (bytes[1] == 18 || bytes[1] == 19)) return false;
        if (bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127) return false;
        if (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) return true;
        if (bytes[0] == 192 && bytes[1] == 168) return true;
        if (bytes[0] == 10) return true;
        return false;
    }

    private static int LanAddressPriority(string address)
    {
        if (address.StartsWith("192.168.", StringComparison.Ordinal)) return 0;
        if (address.StartsWith("10.", StringComparison.Ordinal)) return 1;
        if (address.StartsWith("172.", StringComparison.Ordinal)) return 2;
        return 9;
    }

    private static int FindPortOwnerPid(int port)
    {
        try
        {
            var start = new ProcessStartInfo("netstat.exe", "-ano -p tcp")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using var process = Process.Start(start);
            if (process is null) return 0;
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(2500);
            foreach (var line in output.Split('\n'))
            {
                var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 5) continue;
                if (!parts[0].Equals("TCP", StringComparison.OrdinalIgnoreCase)) continue;
                if (!parts[1].EndsWith($":{port}", StringComparison.Ordinal)) continue;
                if (!parts[3].Equals("LISTENING", StringComparison.OrdinalIgnoreCase)) continue;
                if (int.TryParse(parts[4], out var pid)) return pid;
            }
        }
        catch
        {
        }
        return 0;
    }

    private static bool IsLikelyCodexMiniService(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            var name = process.ProcessName;
            var commandLine = GetProcessCommandLine(pid);
            if (commandLine.Contains("server.js", StringComparison.OrdinalIgnoreCase)) return true;
            if (commandLine.Contains("CodexMaxProject", StringComparison.OrdinalIgnoreCase)) return true;
            if (commandLine.Contains("Codex Max", StringComparison.OrdinalIgnoreCase)) return true;
            return name.Contains("node", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static async Task KillProcessTreeAsync(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            if (process.HasExited) return;
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
        }
        catch
        {
        }
    }

    private static async Task AppendProcessOutputAsync(StreamReader reader, string file)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            await using var stream = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            await using var writer = new StreamWriter(stream, new UTF8Encoding(false));
            while (!reader.EndOfStream)
            {
                var line = await reader.ReadLineAsync();
                if (line is null) break;
                await writer.WriteLineAsync(line);
                await writer.FlushAsync();
            }
        }
        catch
        {
        }
    }

    private static string GetProcessCommandLine(int pid)
    {
        try
        {
            var escaped = $"ProcessId = {pid}";
            var start = new ProcessStartInfo("powershell.exe",
                $"-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"(Get-CimInstance Win32_Process -Filter '{escaped}').CommandLine\"")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using var process = Process.Start(start);
            if (process is null) return "";
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(2500);
            return output.Trim();
        }
        catch
        {
            return "";
        }
    }

    private static void CopyDirectory(string sourceDir, string targetDir)
    {
        Directory.CreateDirectory(targetDir);
        foreach (var directory in Directory.EnumerateDirectories(sourceDir, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(targetDir, Path.GetRelativePath(sourceDir, directory)));
        }
        foreach (var file in Directory.EnumerateFiles(sourceDir, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(targetDir, Path.GetRelativePath(sourceDir, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
        }
    }

    private sealed class LauncherConfig
    {
        public string Token { get; set; } = "";
        public int Port { get; set; } = DefaultPort;
        public int Pid { get; set; }
    }

    private sealed class ThreadSummary
    {
        [JsonPropertyName("threads")]
        public List<ThreadRow> Threads { get; set; } = new();
    }

    private sealed class ThreadRow
    {
        [JsonPropertyName("title")]
        public string? Title { get; set; }

        [JsonPropertyName("name")]
        public string? Name { get; set; }
    }
}

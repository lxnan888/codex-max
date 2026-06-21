using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
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
    string ControlMode,
    string ControlTarget,
    string TargetLabel,
    string LogPreview,
    DateTime LastUpdated
);

internal sealed record HealthSnapshot(
    bool Ok,
    string ControlMode,
    string ControlTarget,
    string TargetLabel
);

internal sealed record CdpLaunchSnapshot(
    bool Ok,
    string Message,
    bool CodexReady
);

internal sealed record WorkspaceOption(
    string Label,
    string Kind,
    string Value
);

internal sealed class ServiceManager
{
    private const string AppName = "Codex Max";
    private const int DefaultPort = 8787;
    private const int VscodeCdpPort = 9339;
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
    private readonly MiniProcessManager processManager = new();

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

    public async Task PrepareIfNeededAsync()
    {
        Directory.CreateDirectory(appDataDir);
        Directory.CreateDirectory(logsDir);
        WriteConfig(ReadConfig());
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
        var health = await GetHealthAsync(config);
        return new ServiceSnapshot(
            health.Ok ? ServiceState.Running : state,
            health.Ok,
            config.Port,
            ResolvePid(config),
            null,
            "VSCode GUI",
            health.ControlMode,
            health.ControlTarget,
            health.TargetLabel,
            ReadLogPreview(),
            DateTime.Now
        );
    }

    public async Task StartAsync()
    {
        await PrepareIfNeededAsync();
        var config = ReadConfig();
        var projectDir = ResolveServiceProjectDir();
        var serviceStamp = ComputeServiceStamp(projectDir);
        var healthOk = await CheckHealthAsync(config);
        if (healthOk && !string.IsNullOrWhiteSpace(config.ServiceStamp) && config.ServiceStamp == serviceStamp) return;

        var existingPid = processManager.FindPortOwnerPid(config.Port);
        if (existingPid > 0)
        {
            if (!processManager.IsLikelyCodexMaxService(existingPid))
            {
                throw new InvalidOperationException($"端口 {config.Port} 已被其他程序占用（PID {existingPid}），无法启动 Codex Max。");
            }
            await processManager.KillProcessTreeAsync(existingPid);
            await Task.Delay(500);
        }

        var serverPath = Path.Combine(projectDir, "server.js");
        if (!File.Exists(serverPath))
        {
            throw new InvalidOperationException("没有找到服务文件 server.js。");
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
        start.Environment["PORT"] = config.Port.ToString();
        start.Environment["CODEX_MAX_APP_NAME"] = AppName;
        start.Environment["CODEX_MAX_VSCODE_CDP_PORT"] = VscodeCdpPort.ToString();

        var process = Process.Start(start) ?? throw new InvalidOperationException("启动 Codex Max 服务失败。");
        _ = Task.Run(() => AppendProcessOutputAsync(process.StandardOutput, stdoutPath));
        _ = Task.Run(() => AppendProcessOutputAsync(process.StandardError, stderrPath));
        config.Pid = process.Id;
        config.ServiceStamp = serviceStamp;
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
        var portPid = processManager.FindPortOwnerPid(config.Port);
        if (portPid > 0 && processManager.IsLikelyCodexMaxService(portPid)) pids.Add(portPid);
        foreach (var pid in pids) await processManager.KillProcessTreeAsync(pid);
        config.Pid = 0;
        config.ServiceStamp = "";
        WriteConfig(config);
        await Task.Delay(350);
    }

    public async Task RestartAsync()
    {
        await StopAsync();
        await Task.Delay(350);
        await StartAsync();
    }

    public async Task<CdpLaunchSnapshot> StartAndLaunchVscodeAsync(WorkspaceOption? workspace)
    {
        await StartAsync();
        return await LaunchControlledVscodeAsync(workspace);
    }

    public async Task<CdpLaunchSnapshot> LaunchControlledVscodeAsync(WorkspaceOption? workspace)
    {
        var config = ReadConfig();
        if (!await CheckHealthAsync(config)) await StartAsync();
        config = ReadConfig();
        if (workspace is not null) SaveSelectedWorkspace(workspace);
        using var launchHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(45) };
        using var response = await launchHttp.PostAsJsonAsync(
            $"http://127.0.0.1:{config.Port}/codex/cdp-launch",
            new
            {
                workspace = workspace is null ? null : new
                {
                    kind = workspace.Kind,
                    value = workspace.Value
                }
            },
            JsonOptions
        );
        var result = await response.Content.ReadFromJsonAsync<CdpLaunchResponse>(JsonOptions);
        if (!response.IsSuccessStatusCode || result?.Ok != true)
        {
            throw new InvalidOperationException(result?.Message ?? "启动受控 VSCode 失败。");
        }
        return new CdpLaunchSnapshot(true, result.Message ?? "已启动受控 VSCode。", result.CodexReady);
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
        var config = ReadConfig();
        return $"http://127.0.0.1:{config.Port}/";
    }

    public IReadOnlyList<WorkspaceOption> ListWorkspaceOptions()
    {
        var rows = new List<WorkspaceOption>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Add(WorkspaceOption item)
        {
            var key = item.Kind == "empty" ? "__empty__" : item.Value;
            if (string.IsNullOrWhiteSpace(key)) return;
            if (!seen.Add(key)) return;
            rows.Add(item);
        }

        var config = ReadConfig();
        if (!string.IsNullOrWhiteSpace(config.SelectedWorkspaceValue))
        {
            Add(new WorkspaceOption(config.SelectedWorkspaceLabel, config.SelectedWorkspaceKind, config.SelectedWorkspaceValue));
        }

        foreach (var item in ReadVscodeStorageWorkspaces())
        {
            Add(item);
        }

        foreach (var item in ReadVscodeStateDbWorkspaces())
        {
            Add(item);
        }

        Add(new WorkspaceOption("不指定工作区", "empty", ""));
        return rows;
    }

    public string ReadSelectedWorkspaceValue()
    {
        return ReadConfig().SelectedWorkspaceValue;
    }

    public void SaveSelectedWorkspace(WorkspaceOption workspace)
    {
        var config = ReadConfig();
        config.SelectedWorkspaceKind = workspace.Kind;
        config.SelectedWorkspaceValue = workspace.Value;
        config.SelectedWorkspaceLabel = workspace.Label;
        WriteConfig(config);
    }

    public WorkspaceOption? BrowseLocalWorkspace()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "选择 VSCode 工作目录",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true
        };
        if (dialog.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(dialog.SelectedPath)) return null;
        return new WorkspaceOption($"本地 · {dialog.SelectedPath}", "local", dialog.SelectedPath);
    }

    private IEnumerable<WorkspaceOption> ReadVscodeStorageWorkspaces()
    {
        var storagePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Code", "User", "globalStorage", "storage.json");
        if (!File.Exists(storagePath)) yield break;
        JsonDocument? doc = null;
        try
        {
            doc = JsonDocument.Parse(File.ReadAllText(storagePath));
        }
        catch
        {
            yield break;
        }
        using (doc)
        {
            if (!doc.RootElement.TryGetProperty("windowsState", out var windowsState)) yield break;
            var candidates = new List<JsonElement>();
            if (windowsState.TryGetProperty("lastActiveWindow", out var lastActive)) candidates.Add(lastActive);
            if (windowsState.TryGetProperty("openedWindows", out var opened) && opened.ValueKind == JsonValueKind.Array)
            {
                candidates.AddRange(opened.EnumerateArray());
            }
            foreach (var window in candidates)
            {
                foreach (var item in WorkspaceOptionsFromWindow(window))
                {
                    yield return item;
                }
            }

            if (doc.RootElement.TryGetProperty("backupWorkspaces", out var backupWorkspaces) &&
                backupWorkspaces.TryGetProperty("folders", out var backupFolders) &&
                backupFolders.ValueKind == JsonValueKind.Array)
            {
                foreach (var folder in backupFolders.EnumerateArray())
                {
                    if (folder.TryGetProperty("folderUri", out var folderUri) && folderUri.ValueKind == JsonValueKind.String)
                    {
                        var option = WorkspaceOptionFromValue(folderUri.GetString() ?? "", folder);
                        if (option is not null) yield return option;
                    }
                }
            }

            if (doc.RootElement.TryGetProperty("profileAssociations", out var profileAssociations) &&
                profileAssociations.TryGetProperty("workspaces", out var profileWorkspaces) &&
                profileWorkspaces.ValueKind == JsonValueKind.Object)
            {
                foreach (var workspace in profileWorkspaces.EnumerateObject())
                {
                    var option = WorkspaceOptionFromValue(workspace.Name, default);
                    if (option is not null) yield return option;
                }
            }
        }
    }

    private IEnumerable<WorkspaceOption> ReadVscodeStateDbWorkspaces()
    {
        var statePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Code", "User", "globalStorage", "state.vscdb");
        if (!File.Exists(statePath)) yield break;
        byte[] bytes;
        try
        {
            using var stream = new FileStream(statePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            bytes = new byte[Math.Min(stream.Length, 12 * 1024 * 1024)];
            var read = stream.Read(bytes, 0, bytes.Length);
            if (read <= 0) yield break;
            if (read < bytes.Length) Array.Resize(ref bytes, read);
        }
        catch
        {
            yield break;
        }

        var text = Encoding.UTF8.GetString(bytes);
        foreach (Match match in Regex.Matches(text, @"(?:vscode-remote://|file:///)[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+", RegexOptions.IgnoreCase))
        {
            var raw = match.Value.TrimEnd('\0', '"', '\'', ',', '}', ']', '<', '>');
            var option = WorkspaceOptionFromValue(raw, default);
            if (option is not null) yield return option;
        }
    }

    private static IEnumerable<WorkspaceOption> WorkspaceOptionsFromWindow(JsonElement window)
    {
        if (window.TryGetProperty("folder", out var folderProp) && folderProp.ValueKind == JsonValueKind.String)
        {
            var value = folderProp.GetString() ?? "";
            var option = WorkspaceOptionFromValue(value, window);
            if (option is not null) yield return option;
        }
        if (window.TryGetProperty("workspace", out var workspaceProp))
        {
            if (workspaceProp.ValueKind == JsonValueKind.String)
            {
                var option = WorkspaceOptionFromValue(workspaceProp.GetString() ?? "", window);
                if (option is not null) yield return option;
            }
            else if (workspaceProp.ValueKind == JsonValueKind.Object &&
                workspaceProp.TryGetProperty("configPath", out var configPath) &&
                configPath.ValueKind == JsonValueKind.String)
            {
                var option = WorkspaceOptionFromValue(configPath.GetString() ?? "", window);
                if (option is not null) yield return option;
            }
        }
    }

    private static WorkspaceOption? WorkspaceOptionFromValue(string value, JsonElement window)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (value.StartsWith("vscode-remote://", StringComparison.OrdinalIgnoreCase))
        {
            var label = RemoteWorkspaceLabel(value, window);
            return new WorkspaceOption(label, "remote", value);
        }
        var localPath = value;
        if (value.StartsWith("file:///", StringComparison.OrdinalIgnoreCase))
        {
            localPath = Uri.UnescapeDataString(value["file:///".Length..]).Replace('/', Path.DirectorySeparatorChar);
        }
        return new WorkspaceOption($"本地 · {localPath}", "local", localPath);
    }

    private static string RemoteWorkspaceLabel(string uri, JsonElement window)
    {
        var remoteAuthority = "";
        if (window.ValueKind == JsonValueKind.Object &&
            window.TryGetProperty("remoteAuthority", out var authorityProp) &&
            authorityProp.ValueKind == JsonValueKind.String)
        {
            remoteAuthority = authorityProp.GetString() ?? "";
        }
        var match = System.Text.RegularExpressions.Regex.Match(uri, @"^vscode-remote://([^/]+)(/.*)?$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var authority = match.Success ? Uri.UnescapeDataString(match.Groups[1].Value) : remoteAuthority;
        var pathPart = match.Success ? Uri.UnescapeDataString(match.Groups[2].Value) : uri;
        if (authority.StartsWith("ssh-remote+", StringComparison.OrdinalIgnoreCase))
        {
            authority = "SSH: " + authority["ssh-remote+".Length..];
        }
        return $"{authority} · {pathPart}";
    }

    private async Task<bool> CheckHealthAsync(LauncherConfig config)
    {
        return (await GetHealthAsync(config)).Ok;
    }

    private async Task<HealthSnapshot> GetHealthAsync(LauncherConfig config)
    {
        try
        {
            using var response = await http.GetAsync($"http://127.0.0.1:{config.Port}/codex/health");
            if (!response.IsSuccessStatusCode) return new HealthSnapshot(false, "", "vscode", "VSCode Codex");
            var health = await response.Content.ReadFromJsonAsync<HealthResponse>(JsonOptions);
            return new HealthSnapshot(health?.Ok == true, health?.ControlMode ?? "", "vscode", health?.TargetLabel ?? "VSCode Codex");
        }
        catch
        {
            return new HealthSnapshot(false, "", "vscode", "VSCode Codex");
        }
    }

    private LauncherConfig ReadConfig()
    {
        try
        {
            if (File.Exists(configPath))
            {
                var loaded = JsonSerializer.Deserialize<LauncherConfig>(File.ReadAllText(configPath), JsonOptions);
                if (loaded is not null)
                {
                    if (loaded.Port <= 0) loaded.Port = DefaultPort;
                    if (string.IsNullOrWhiteSpace(loaded.SelectedWorkspaceKind)) loaded.SelectedWorkspaceKind = "empty";
                    if (string.IsNullOrWhiteSpace(loaded.SelectedWorkspaceLabel)) loaded.SelectedWorkspaceLabel = "不指定工作区";
                    return loaded;
                }
            }
        }
        catch
        {
        }
        return new LauncherConfig { Port = DefaultPort, SelectedWorkspaceKind = "empty", SelectedWorkspaceLabel = "不指定工作区" };
    }

    private void WriteConfig(LauncherConfig config)
    {
        if (config.Port <= 0) config.Port = DefaultPort;
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
        var portPid = processManager.FindPortOwnerPid(config.Port);
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

    private static string ComputeServiceStamp(string projectDir)
    {
        try
        {
            using var sha = System.Security.Cryptography.SHA256.Create();
            foreach (var relativePath in new[] {
                "server.js",
                Path.Combine("public", "index.html"),
                Path.Combine("src", "platform", "win32.js"),
                Path.Combine("src", "platform", "index.js")
            })
            {
                var file = Path.Combine(projectDir, relativePath);
                if (!File.Exists(file)) continue;
                var nameBytes = Encoding.UTF8.GetBytes(relativePath);
                sha.TransformBlock(nameBytes, 0, nameBytes.Length, null, 0);
                var bytes = File.ReadAllBytes(file);
                sha.TransformBlock(bytes, 0, bytes.Length, null, 0);
            }
            sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
            return Convert.ToHexString(sha.Hash ?? Array.Empty<byte>());
        }
        catch
        {
            return "";
        }
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

    private bool ExtractEmbeddedPayloadIfNeeded()
    {
        var assembly = typeof(ServiceManager).Assembly;
        var resourceName = assembly.GetManifestResourceNames()
            .FirstOrDefault(name => name.EndsWith("CodexMaxPayload.zip", StringComparison.OrdinalIgnoreCase));
        if (string.IsNullOrWhiteSpace(resourceName)) return false;
        using var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream is null) return false;
        using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
        foreach (var entry in archive.Entries)
        {
            if (string.IsNullOrWhiteSpace(entry.Name)) continue;
            var relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
            if (relative.Equals(Path.Combine("node", "node.exe"), StringComparison.OrdinalIgnoreCase) &&
                File.Exists(appDataNodePath))
            {
                continue;
            }
            var target = Path.GetFullPath(Path.Combine(appDataDir, relative));
            var appDataRoot = Path.GetFullPath(appDataDir);
            if (!target.StartsWith(appDataRoot, StringComparison.OrdinalIgnoreCase)) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, overwrite: true);
        }
        return true;
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
        public int Port { get; set; } = DefaultPort;
        public int Pid { get; set; }
        public string ServiceStamp { get; set; } = "";
        public string SelectedWorkspaceKind { get; set; } = "empty";
        public string SelectedWorkspaceValue { get; set; } = "";
        public string SelectedWorkspaceLabel { get; set; } = "不指定工作区";
    }

    private sealed class HealthResponse
    {
        [JsonPropertyName("ok")]
        public bool Ok { get; set; }

        [JsonPropertyName("controlMode")]
        public string? ControlMode { get; set; }

        [JsonPropertyName("targetLabel")]
        public string? TargetLabel { get; set; }
    }

    private sealed class CdpLaunchResponse
    {
        [JsonPropertyName("ok")]
        public bool Ok { get; set; }

        [JsonPropertyName("message")]
        public string? Message { get; set; }

        [JsonPropertyName("codexReady")]
        public bool CodexReady { get; set; }
    }
}

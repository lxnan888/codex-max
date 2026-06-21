using System.Diagnostics;

namespace CodexMiniWin;

internal sealed class MiniProcessManager
{
    public int FindPortOwnerPid(int port)
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

    public bool IsLikelyCodexMaxService(int pid)
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

    public async Task KillProcessTreeAsync(int pid)
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
}

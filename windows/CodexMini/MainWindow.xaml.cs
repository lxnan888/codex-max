using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
using WpfControl = System.Windows.Controls.Control;
using WpfMessageBox = System.Windows.MessageBox;
using WpfColor = System.Windows.Media.Color;

namespace CodexMiniWin;

public partial class MainWindow : Window
{
    private readonly ServiceManager service = new();
    private readonly DispatcherTimer refreshTimer = new() { Interval = TimeSpan.FromSeconds(5) };
    private readonly List<WpfControl> actionControls;
    private bool serviceRunning;

    public MainWindow()
    {
        InitializeComponent();
        actionControls = new List<WpfControl>
        {
            OpenWebButton,
            CopyLinkButton,
            RestartButton,
            RefreshButton,
            OpenLogsButton,
            StartStopButton
        };
        refreshTimer.Tick += async (_, _) => await RefreshStateAsync();
        Loaded += async (_, _) =>
        {
            await RunActionAsync(async () =>
            {
                await service.PrepareIfNeededAsync();
                await service.StartAsync();
            });
            await RefreshStateAsync();
            refreshTimer.Start();
        };
        Closed += (_, _) => refreshTimer.Stop();
    }

    private async void OpenWeb_Click(object sender, RoutedEventArgs e)
    {
        await RunActionAsync(async () => await service.OpenWebAsync());
        await RefreshStateAsync();
    }

    private async void CopyLink_Click(object sender, RoutedEventArgs e)
    {
        await RunActionAsync(async () =>
        {
            await service.CopyLocalLinkAsync();
            WpfMessageBox.Show(this, "已复制本机链接", "Codex Max", MessageBoxButton.OK, MessageBoxImage.Information);
        });
        await RefreshStateAsync();
    }

    private async void Restart_Click(object sender, RoutedEventArgs e)
    {
        await RunActionAsync(async () => await service.RestartAsync());
        await RefreshStateAsync();
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e)
    {
        await RefreshStateAsync();
    }

    private void OpenLogs_Click(object sender, RoutedEventArgs e)
    {
        service.OpenLogs();
    }

    private async void StartStop_Click(object sender, RoutedEventArgs e)
    {
        await RunActionAsync(async () =>
        {
            if (serviceRunning) await service.StopAsync();
            else await service.StartAsync();
        });
        await RefreshStateAsync();
    }

    private async Task RefreshStateAsync()
    {
        var snapshot = await service.RefreshAsync();
        serviceRunning = snapshot.HealthOk;
        var good = (SolidColorBrush)FindResource("GreenBrush");
        var warn = (SolidColorBrush)FindResource("OrangeBrush");
        var bad = new SolidColorBrush(WpfColor.FromRgb(255, 120, 100));
        var statusBrush = snapshot.HealthOk ? good : snapshot.State == ServiceState.Running ? warn : bad;
        StateDot.Foreground = statusBrush;
        StateText.Foreground = statusBrush;
        StateText.Text = StateTextFor(snapshot.State);
        HttpValue.Foreground = snapshot.HealthOk ? good : warn;
        HttpValue.Text = snapshot.HealthOk ? "正常" : "不可用";
        HttpFootnote.Text = snapshot.HealthOk ? "HTTP 健康检查正常" : "健康检查不可用";
        PortValue.Text = snapshot.Port.ToString();
        PortFootnote.Text = "本机入口";
        ThreadValue.Text = snapshot.ThreadCount?.ToString() ?? "-";
        ThreadFootnote.Text = snapshot.LatestThreadTitle;
        InstallPath.Text = service.ShortInstallDirectory;
        UpdatedAt.Text = "更新于 " + snapshot.LastUpdated.ToString("HH:mm:ss");
        EntryKind.Text = "本机入口";
        EntryUrl.Text = service.PrimaryEntryUrl();
        LogPreview.Text = string.IsNullOrWhiteSpace(snapshot.LogPreview)
            ? "暂无最近日志"
            : "最近日志已收起，完整内容可从右侧打开";
        StartStopButton.Content = snapshot.HealthOk ? "\uE71A 停止" : "\uE768 启动";
    }

    private async Task RunActionAsync(Func<Task> action)
    {
        SetBusy(true);
        try
        {
            await action();
        }
        catch (Exception ex)
        {
            WpfMessageBox.Show(this, ex.Message, "Codex Max", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private void SetBusy(bool busy)
    {
        Cursor = busy ? System.Windows.Input.Cursors.Wait : null;
        foreach (var control in actionControls) control.IsEnabled = !busy;
    }

    private static string StateTextFor(ServiceState state) => state switch
    {
        ServiceState.NotInstalled => "未安装",
        ServiceState.Running => "运行中",
        ServiceState.Stopped => "已停止",
        _ => "未知"
    };
}

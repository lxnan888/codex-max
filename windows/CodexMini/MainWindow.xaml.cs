using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
using WpfColor = System.Windows.Media.Color;
using WpfControl = System.Windows.Controls.Control;
using WpfMessageBox = System.Windows.MessageBox;

namespace CodexMiniWin;

public partial class MainWindow : Window
{
    private readonly ServiceManager service = new();
    private readonly DispatcherTimer refreshTimer = new() { Interval = TimeSpan.FromSeconds(5) };
    private readonly List<WpfControl> actionControls;
    private WorkspaceOption? currentWorkspace;
    private bool serviceRunning;
    private bool allowClose;
    private bool closeInProgress;

    public MainWindow()
    {
        InitializeComponent();
        actionControls = new List<WpfControl>
        {
            OpenWebButton,
            CopyLinkButton,
            LaunchCdpButton,
            RestartButton,
            RefreshButton,
            BrowseWorkspaceButton,
            OpenLogsButton,
            WorkspaceCombo
        };
        refreshTimer.Tick += async (_, _) => await RefreshStateAsync();
        Loaded += async (_, _) =>
        {
            await RunActionAsync(async () =>
            {
                await service.PrepareIfNeededAsync();
                LoadWorkspaces();
            });
            await RefreshStateAsync();
            refreshTimer.Start();
        };
        Closing += async (_, e) =>
        {
            if (allowClose) return;
            e.Cancel = true;
            if (closeInProgress) return;
            closeInProgress = true;
            refreshTimer.Stop();
            await RunActionAsync(async () => await service.StopAsync());
            allowClose = true;
            Close();
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
            WpfMessageBox.Show(this, "已复制本地链接。", "Codex Max", MessageBoxButton.OK, MessageBoxImage.Information);
        });
        await RefreshStateAsync();
    }

    private async void Restart_Click(object sender, RoutedEventArgs e)
    {
        await RunActionAsync(async () => await service.RestartAsync());
        await RefreshStateAsync();
    }

    private async void LaunchCdp_Click(object sender, RoutedEventArgs e)
    {
        await RunActionAsync(async () =>
        {
            if (serviceRunning)
            {
                await service.StopAsync();
                WpfMessageBox.Show(this, "已停止 mini 服务；VSCode 进程保持打开。", "Codex Max", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            if (currentWorkspace is not null) service.SaveSelectedWorkspace(currentWorkspace);
            var result = await service.StartAndLaunchVscodeAsync(currentWorkspace);
            WpfMessageBox.Show(this, result.Message, "Codex Max", MessageBoxButton.OK, MessageBoxImage.Information);
        });
        await RefreshStateAsync();
    }

    private async void BrowseWorkspace_Click(object sender, RoutedEventArgs e)
    {
        await RunActionAsync(async () =>
        {
            var workspace = service.BrowseLocalWorkspace();
            if (workspace is null) return;
            service.SaveSelectedWorkspace(workspace);
            LoadWorkspaces(workspace.Value);
            await Task.CompletedTask;
        });
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e)
    {
        LoadWorkspaces();
        await RefreshStateAsync();
    }

    private void OpenLogs_Click(object sender, RoutedEventArgs e)
    {
        service.OpenLogs();
    }

    private void LoadWorkspaces(string? preferredValue = null)
    {
        var options = service.ListWorkspaceOptions();
        var selectedValue = preferredValue ?? service.ReadSelectedWorkspaceValue();
        currentWorkspace = options.FirstOrDefault(item => item.Value == selectedValue) ?? options.FirstOrDefault();
        WorkspaceCombo.ItemsSource = options;
        WorkspaceCombo.SelectedItem = currentWorkspace;
        RenderCurrentWorkspace();
    }

    private void WorkspaceCombo_SelectionChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
    {
        if (WorkspaceCombo.SelectedItem is not WorkspaceOption workspace) return;
        currentWorkspace = workspace;
        service.SaveSelectedWorkspace(workspace);
        RenderCurrentWorkspace();
    }

    private void RenderCurrentWorkspace()
    {
        if (currentWorkspace is null)
        {
            WorkspaceKindText.Text = "工作区";
            WorkspaceTitleText.Text = "没有读取到 VSCode 最近工作区";
            WorkspaceValueText.Text = "可以点击“选择目录”手动指定本地目录。";
            return;
        }

        WorkspaceKindText.Text = currentWorkspace.Kind switch
        {
            "remote" => "SSH 工作区",
            "local" => "本地目录",
            _ => "工作区"
        };
        WorkspaceTitleText.Text = currentWorkspace.Label;
        WorkspaceValueText.Text = string.IsNullOrWhiteSpace(currentWorkspace.Value)
            ? "不指定工作区，启动 VSCode 默认窗口。"
            : currentWorkspace.Value;
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
        StateText.Text = snapshot.HealthOk ? "已启动" : "未启动";
        HttpValue.Foreground = snapshot.HealthOk && snapshot.ControlMode == "cdp" ? good : warn;
        HttpValue.Text = snapshot.HealthOk ? (snapshot.ControlMode == "cdp" ? "CDP" : "等待") : "不可用";
        HttpFootnote.Text = snapshot.HealthOk
            ? $"{snapshot.TargetLabel} · {(snapshot.ControlMode == "cdp" ? "GUI 实时同步" : "等待 VSCode Codex")}"
            : $"{snapshot.TargetLabel} · 服务未运行";
        PortValue.Text = snapshot.Port.ToString();
        ThreadValue.Text = "GUI";
        ThreadFootnote.Text = "从 VSCode Codex WebView 实时读取";
        InstallPath.Text = service.ShortInstallDirectory;
        UpdatedAt.Text = "更新于 " + snapshot.LastUpdated.ToString("HH:mm:ss");
        LogPreview.Text = string.IsNullOrWhiteSpace(snapshot.LogPreview)
            ? "暂无最近日志"
            : "最近日志已收起，完整内容可从右侧打开";

        LaunchCdpText.Text = snapshot.HealthOk ? "关闭 VSCode" : "启动 VSCode";
        LaunchCdpIcon.Text = snapshot.HealthOk ? "\uE711" : "\uE768";
        LaunchCdpButton.Background = snapshot.HealthOk ? new SolidColorBrush(WpfColor.FromRgb(68, 34, 34)) : new SolidColorBrush(WpfColor.FromRgb(22, 59, 42));
        LaunchCdpButton.BorderBrush = snapshot.HealthOk ? new SolidColorBrush(WpfColor.FromRgb(122, 58, 58)) : new SolidColorBrush(WpfColor.FromRgb(43, 99, 71));
        LaunchCdpButton.Foreground = snapshot.HealthOk ? bad : good;
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
}

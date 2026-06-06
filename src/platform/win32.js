'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PS_PREAMBLE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class CodexMiniWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg;
    public ushort wParamL;
    public ushort wParamH;
  }
}
"@

function Get-CodexWindow {
  $script:codexMiniBestWindow = [IntPtr]::Zero
  $script:codexMiniBestScore = -1
  [CodexMiniWin32]::EnumWindows({
    param([IntPtr]$hwnd, [IntPtr]$lparam)
    if (-not [CodexMiniWin32]::IsWindowVisible($hwnd)) { return $true }
    $procId = 0
    [void][CodexMiniWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    if ($procId -le 0) { return $true }
    $processName = ''
    $processPath = ''
    try {
      $process = Get-Process -Id $procId -ErrorAction Stop
      $processName = [string]$process.ProcessName
      try { $processPath = [string]$process.Path } catch {}
    } catch {}
    $titleBuilder = New-Object System.Text.StringBuilder 512
    [void][CodexMiniWin32]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity)
    $title = $titleBuilder.ToString()
    $descriptor = "$title $processName $processPath"
    if ($descriptor -match '(?i)Codex Max') { return $true }
    $score = 0
    if ($processName -match '^(Codex|OpenAI Codex|codex)') { $score += 10 }
    if ($title -match 'Codex') { $score += 6 }
    if ($score -le 0) { return $true }
    if ($score -gt $script:codexMiniBestScore) {
      $script:codexMiniBestWindow = $hwnd
      $script:codexMiniBestScore = $score
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  if ($script:codexMiniBestScore -lt 6) { return [IntPtr]::Zero }
  return $script:codexMiniBestWindow
}

function Invoke-CodexLink([string]$url) {
  Start-Process $url
}

function Reset-KeyboardModifiers {
  $keys = @(0x10, 0x11, 0x12, 0x5B, 0x5C)
  $events = New-Object 'CodexMiniWin32+INPUT[]' $keys.Length
  for ($i = 0; $i -lt $keys.Length; $i++) {
    $events[$i].type = 1
    $events[$i].u.ki.wVk = [UInt16]$keys[$i]
    $events[$i].u.ki.dwFlags = 2
  }
  [void][CodexMiniWin32]::SendInput([uint32]$events.Length, $events, [Runtime.InteropServices.Marshal]::SizeOf([type][CodexMiniWin32+INPUT]))
}

function Set-CodexForeground([IntPtr]$hwnd) {
  $targetPid = 0
  $targetThread = [CodexMiniWin32]::GetWindowThreadProcessId($hwnd, [ref]$targetPid)
  $foreground = [CodexMiniWin32]::GetForegroundWindow()
  $foregroundPid = 0
  $foregroundThread = if ($foreground -ne [IntPtr]::Zero) { [CodexMiniWin32]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid) } else { 0 }
  $currentThread = [CodexMiniWin32]::GetCurrentThreadId()
  $attachedTarget = $false
  $attachedForeground = $false
  try {
    if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
      $attachedTarget = [CodexMiniWin32]::AttachThreadInput($currentThread, $targetThread, $true)
    }
    if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread -and $foregroundThread -ne $targetThread) {
      $attachedForeground = [CodexMiniWin32]::AttachThreadInput($currentThread, $foregroundThread, $true)
    }
    [void][CodexMiniWin32]::ShowWindow($hwnd, 9)
    [void][CodexMiniWin32]::BringWindowToTop($hwnd)
    [void][CodexMiniWin32]::SetActiveWindow($hwnd)
    [void][CodexMiniWin32]::SetFocus($hwnd)
    [void][CodexMiniWin32]::SetForegroundWindow($hwnd)
  } finally {
    if ($attachedForeground) { [void][CodexMiniWin32]::AttachThreadInput($currentThread, $foregroundThread, $false) }
    if ($attachedTarget) { [void][CodexMiniWin32]::AttachThreadInput($currentThread, $targetThread, $false) }
  }
}

function Activate-CodexWindow {
  $hwnd = Get-CodexWindow
  if ($hwnd -eq [IntPtr]::Zero) {
    throw '没有找到 Codex Desktop 主窗口。请确认 Codex Desktop 已安装并能通过 codex:// 打开。'
  }
  [void][CodexMiniWin32]::ShowWindow($hwnd, 9)
  Start-Sleep -Milliseconds 70
  Reset-KeyboardModifiers
  for ($i = 0; $i -lt 8; $i++) {
    Set-CodexForeground $hwnd
    Start-Sleep -Milliseconds 80
    if ([CodexMiniWin32]::GetForegroundWindow() -eq $hwnd) {
      Reset-KeyboardModifiers
      return $hwnd
    }
    [CodexMiniWin32]::SwitchToThisWindow($hwnd, $true)
    Start-Sleep -Milliseconds 110
    if ([CodexMiniWin32]::GetForegroundWindow() -eq $hwnd) {
      Reset-KeyboardModifiers
      return $hwnd
    }
  }
  throw '没能把 Codex Desktop 激活为前台窗口，已停止发送，避免按键落到其他窗口。'
}

function Invoke-MouseClick([int]$x, [int]$y, [int]$settleMs = 140) {
  [void][CodexMiniWin32]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 40
  [void][CodexMiniWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 35
  [void][CodexMiniWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds $settleMs
}

function Click-CodexComposerFallback([IntPtr]$hwnd) {
  $rect = New-Object CodexMiniWin32+RECT
  [void][CodexMiniWin32]::GetWindowRect($hwnd, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { throw 'Codex 窗口尺寸异常，无法计算输入框位置。' }

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($root -ne $null) {
    try {
      $buttons = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Button
        ))
      )
      $leftEdge = 0
      $rightEdge = 0
      $toolbarTop = 0
      $toolbarBottom = 0
      foreach ($button in $buttons) {
        $buttonRect = $button.Current.BoundingRectangle
        if ($buttonRect.Width -lt 12 -or $buttonRect.Height -lt 12) { continue }
        if ($buttonRect.X -lt $rect.Left -or $buttonRect.Right -gt $rect.Right -or
            $buttonRect.Y -lt ($rect.Top + ($height * 0.65)) -or $buttonRect.Bottom -gt $rect.Bottom) { continue }
        $name = [string]$button.Current.Name
        if ($name -match '(添加文件|自定义|听写|停止|发送|模型|推理|GPT|gpt|[0-9](?:\\.[0-9])?\\s*(低|中|高|超高)?)') {
          if ($toolbarTop -eq 0 -or $buttonRect.Top -lt $toolbarTop) { $toolbarTop = $buttonRect.Top }
          if ($buttonRect.Bottom -gt $toolbarBottom) { $toolbarBottom = $buttonRect.Bottom }
          if ($name -match '(添加文件|自定义)') {
            if ($buttonRect.Right -gt $leftEdge) { $leftEdge = $buttonRect.Right }
          } else {
            if ($rightEdge -eq 0 -or $buttonRect.X -lt $rightEdge) { $rightEdge = $buttonRect.X }
          }
        }
      }
      if ($toolbarTop -gt 0 -and $toolbarBottom -gt $toolbarTop) {
        $toolbarHeight = $toolbarBottom - $toolbarTop
        $textOffset = [Math]::Max(26, [Math]::Min(54, $toolbarHeight + 20))
        $y = [int]($toolbarTop - $textOffset)
        if ($y -lt ($rect.Top + ($height * 0.52))) {
          $y = [int]($toolbarTop - [Math]::Max(18, [Math]::Min(32, $toolbarHeight)))
        }
        if ($leftEdge -gt 0 -and $rightEdge -gt 0 -and ($rightEdge - $leftEdge) -gt 120) {
          $x = [int](($leftEdge + $rightEdge) / 2)
        } else {
          $x = [int]($rect.Left + ($width * 0.50))
        }
        Invoke-MouseClick $x $y 180
        return
      }
    } catch {}
  }

  $x = [int]($rect.Left + ($width * 0.50))
  $y = [int]($rect.Bottom - [Math]::Max(82, [Math]::Min(138, $height * 0.10)))
  Invoke-MouseClick $x $y 160
}

function Click-CodexComposerActionButton {
  $hwnd = Activate-CodexWindow
  $rect = New-Object CodexMiniWin32+RECT
  [void][CodexMiniWin32]::GetWindowRect($hwnd, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { throw 'Codex 窗口尺寸异常，无法计算停止按钮位置。' }
  $x = [int]($rect.Right - [Math]::Max(44, [Math]::Min(86, $width * 0.055)))
  $y = [int]($rect.Bottom - [Math]::Max(86, [Math]::Min(170, $height * 0.11)))
  Invoke-MouseClick $x $y 180
}

function Focus-CodexComposerOnce {
  $hwnd = Activate-CodexWindow
  $windowRect = New-Object CodexMiniWin32+RECT
  [void][CodexMiniWin32]::GetWindowRect($hwnd, [ref]$windowRect)
  $windowWidth = $windowRect.Right - $windowRect.Left
  $windowHeight = $windowRect.Bottom - $windowRect.Top
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($root -ne $null) {
    $controls = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty,
        $true
      ))
    )
    $best = $null
    $bestScore = -1
    foreach ($item in $controls) {
      $rect = $item.Current.BoundingRectangle
      if ($rect.Width -lt 180 -or $rect.Height -lt 18) { continue }
      if ($rect.X -lt $windowRect.Left -or $rect.Y -lt $windowRect.Top -or
          $rect.Right -gt $windowRect.Right -or $rect.Bottom -gt $windowRect.Bottom) { continue }
      if ($rect.Bottom -lt ($windowRect.Top + ($windowHeight * 0.45))) { continue }
      $controlType = $item.Current.ControlType
      $name = [string]$item.Current.Name
      $automationId = [string]$item.Current.AutomationId
      $className = [string]$item.Current.ClassName
      $descriptor = "$name $automationId $className"
      $hasComposerSignal = $descriptor -match '(input|message|composer|prompt|chat|ask|textarea|editor|输入|消息|提问|询问)'
      $isTextControl = $controlType -eq [System.Windows.Automation.ControlType]::Edit -or $hasComposerSignal
      if (-not $isTextControl) { continue }
      $score = [int]$rect.Bottom
      if ($controlType -eq [System.Windows.Automation.ControlType]::Edit) { $score += 800 }
      if ($hasComposerSignal) { $score += 1000 }
      if ($rect.X -gt ($windowRect.Left + ($windowWidth * 0.12))) { $score += 120 }
      if ($score -gt $bestScore) {
        $best = $item
        $bestScore = $score
      }
    }
    if ($best -ne $null) {
      try {
        $best.SetFocus()
        $bestRect = $best.Current.BoundingRectangle
        Invoke-MouseClick ([int]($bestRect.X + ($bestRect.Width / 2))) ([int]($bestRect.Y + ($bestRect.Height / 2))) 140
        return
      } catch {}
    }
  }

  Click-CodexComposerFallback $hwnd
}

function Focus-CodexComposer {
  $lastError = $null
  for ($i = 0; $i -lt 3; $i++) {
    try {
      Focus-CodexComposerOnce
      return
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 220
    }
  }
  if ($lastError -ne $null) { throw $lastError }
}

function Prime-CodexComposerFocus {
  $hwnd = Activate-CodexWindow
  $windowRect = New-Object CodexMiniWin32+RECT
  [void][CodexMiniWin32]::GetWindowRect($hwnd, [ref]$windowRect)
  $windowWidth = $windowRect.Right - $windowRect.Left
  $windowHeight = $windowRect.Bottom - $windowRect.Top
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($root -eq $null) { return $false }

  try {
    $controls = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty,
        $true
      ))
    )
    $best = $null
    $bestScore = -1
    foreach ($item in $controls) {
      $rect = $item.Current.BoundingRectangle
      if ($rect.Width -lt 180 -or $rect.Height -lt 18) { continue }
      if ($rect.X -lt $windowRect.Left -or $rect.Y -lt $windowRect.Top -or
          $rect.Right -gt $windowRect.Right -or $rect.Bottom -gt $windowRect.Bottom) { continue }
      if ($rect.Bottom -lt ($windowRect.Top + ($windowHeight * 0.45))) { continue }
      $controlType = $item.Current.ControlType
      $name = [string]$item.Current.Name
      $automationId = [string]$item.Current.AutomationId
      $className = [string]$item.Current.ClassName
      $descriptor = "$name $automationId $className"
      $hasComposerSignal = $descriptor -match '(input|message|composer|prompt|chat|ask|textarea|editor|输入|消息|提问|询问|要求后续变更)'
      $isTextControl = $controlType -eq [System.Windows.Automation.ControlType]::Edit -or $hasComposerSignal
      if (-not $isTextControl) { continue }
      $score = [int]$rect.Bottom
      if ($controlType -eq [System.Windows.Automation.ControlType]::Edit) { $score += 800 }
      if ($hasComposerSignal) { $score += 1000 }
      if ($rect.X -gt ($windowRect.Left + ($windowWidth * 0.12))) { $score += 120 }
      if ($score -gt $bestScore) {
        $best = $item
        $bestScore = $score
      }
    }
    if ($best -ne $null) {
      $best.SetFocus()
      Start-Sleep -Milliseconds 45
      return $true
    }
  } catch {}

  return $false
}

function Get-CodexToolbarState {
  $hwnd = Get-CodexWindow
  if ($hwnd -eq [IntPtr]::Zero) {
    @{
      raw = ''
      modelLabel = ''
      reasoningLabel = ''
    } | ConvertTo-Json -Compress
    return
  }
  $windowRect = New-Object CodexMiniWin32+RECT
  [void][CodexMiniWin32]::GetWindowRect($hwnd, [ref]$windowRect)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $state = @{
    raw = ''
    modelLabel = ''
    reasoningLabel = ''
  }
  if ($root -eq $null) {
    $state | ConvertTo-Json -Compress
    return
  }
  $buttons = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    ))
  )
  $best = $null
  $bestX = -1
  foreach ($button in $buttons) {
    $rect = $button.Current.BoundingRectangle
    if ($rect.Width -lt 24 -or $rect.Height -lt 18) { continue }
    if ($rect.Y -lt ($windowRect.Bottom - 150) -or $rect.Y -gt $windowRect.Bottom) { continue }
    if ($rect.X -lt ($windowRect.Left + 250) -or $rect.X -gt $windowRect.Right) { continue }
    $name = ([string]$button.Current.Name).Trim()
    if ($name -match '^(.+?)\\s+(低|中|高|超高)$') {
      if ($rect.X -gt $bestX) {
        $best = $name
        $bestX = $rect.X
      }
    }
  }
  if ($best) {
    $parts = $best -split '\\s+'
    $state.raw = $best
    $state.reasoningLabel = $parts[$parts.Length - 1]
    $state.modelLabel = ($parts[0..($parts.Length - 2)] -join ' ')
  }
  $state | ConvertTo-Json -Compress
}

function Send-KeyChord([int[]]$keys) {
  Activate-CodexWindow | Out-Null
  Reset-KeyboardModifiers
  $events = New-Object 'CodexMiniWin32+INPUT[]' ($keys.Length * 2)
  $index = 0
  foreach ($key in $keys) {
    $events[$index].type = 1
    $events[$index].u.ki.wVk = [UInt16]$key
    $events[$index].u.ki.dwFlags = 0
    $index++
  }
  for ($i = $keys.Length - 1; $i -ge 0; $i--) {
    $events[$index].type = 1
    $events[$index].u.ki.wVk = [UInt16]$keys[$i]
    $events[$index].u.ki.dwFlags = 2
    $index++
  }
  $sent = [CodexMiniWin32]::SendInput([uint32]$events.Length, $events, [Runtime.InteropServices.Marshal]::SizeOf([type][CodexMiniWin32+INPUT]))
  if ($sent -ne $events.Length) { throw "SendInput failed: sent $sent of $($events.Length)" }
  Start-Sleep -Milliseconds 40
  Reset-KeyboardModifiers
}

function Send-UnicodeText([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return }
  Activate-CodexWindow | Out-Null
  Reset-KeyboardModifiers
  foreach ($ch in $text.ToCharArray()) {
    $events = New-Object 'CodexMiniWin32+INPUT[]' 2
    $events[0].type = 1
    $events[0].u.ki.wVk = 0
    $events[0].u.ki.wScan = [UInt16][char]$ch
    $events[0].u.ki.dwFlags = 0x0004
    $events[1].type = 1
    $events[1].u.ki.wVk = 0
    $events[1].u.ki.wScan = [UInt16][char]$ch
    $events[1].u.ki.dwFlags = 0x0004 -bor 0x0002
    $sent = [CodexMiniWin32]::SendInput([uint32]$events.Length, $events, [Runtime.InteropServices.Marshal]::SizeOf([type][CodexMiniWin32+INPUT]))
    if ($sent -ne $events.Length) { throw "SendInput text failed: sent $sent of $($events.Length)" }
    Start-Sleep -Milliseconds 5
  }
  Reset-KeyboardModifiers
}

function Send-WinFormsKeys([string]$keys, [int]$settleMs = 80) {
  Activate-CodexWindow | Out-Null
  Reset-KeyboardModifiers
  Start-Sleep -Milliseconds 35
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Start-Sleep -Milliseconds $settleMs
  Reset-KeyboardModifiers
}

function Paste-TextAndEnter([string]$text) {
  [System.Windows.Forms.Clipboard]::SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
  Activate-CodexWindow | Out-Null
  Reset-KeyboardModifiers
  Start-Sleep -Milliseconds 45
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 260
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 180
  Reset-KeyboardModifiers
}

function Paste-TextOnly([string]$text) {
  [System.Windows.Forms.Clipboard]::SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
  Activate-CodexWindow | Out-Null
  Reset-KeyboardModifiers
  Start-Sleep -Milliseconds 45
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 260
  Reset-KeyboardModifiers
}

function Paste-CommandSelection([string]$command, [string]$selection, [int]$commandSettleMs, [int]$selectionSettleMs) {
  [System.Windows.Forms.Clipboard]::SetText($command, [System.Windows.Forms.TextDataFormat]::UnicodeText)
  Activate-CodexWindow | Out-Null
  Reset-KeyboardModifiers
  Start-Sleep -Milliseconds 45
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 260
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds $commandSettleMs
  [System.Windows.Forms.Clipboard]::SetText($selection, [System.Windows.Forms.TextDataFormat]::UnicodeText)
  Start-Sleep -Milliseconds 45
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 260
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds $selectionSettleMs
  Reset-KeyboardModifiers
}

function Convert-Key([string]$key) {
  switch ($key.ToLowerInvariant()) {
    'enter' { return 0x0D }
    'esc' { return 0x1B }
    'escape' { return 0x1B }
    '.' { return 0xBE }
    default {
      if ($key.Length -eq 1) { return [int][char]$key.ToUpperInvariant() }
      throw "Unsupported key: $key"
    }
  }
}
`;

const PS_HELPER_LOOP = `
$ProgressPreference = 'SilentlyContinue'
function Write-CodexMiniResponse([object]$payload) {
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 12))
  [Console]::Out.Flush()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $request = $null
  $id = $null
  try {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    $action = [string]$request.action
    $result = @{}
    switch ($action) {
      'ping' {
      }
      'invokeLink' {
        Invoke-CodexLink ([string]$request.url)
      }
      'activate' {
        Activate-CodexWindow | Out-Null
      }
      'focusComposer' {
        Focus-CodexComposer
      }
      'primeComposer' {
        Prime-CodexComposerFocus | Out-Null
      }
      'setClipboardText' {
        [System.Windows.Forms.Clipboard]::SetText([string]$request.text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
      }
      'copyImage' {
        $img = [System.Drawing.Image]::FromFile([string]$request.filePath)
        try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }
      }
      'pasteTextAndEnter' {
        Paste-TextAndEnter ([string]$request.text)
      }
      'pasteTextOnly' {
        Paste-TextOnly ([string]$request.text)
      }
      'commandSelection' {
        Paste-CommandSelection ([string]$request.command) ([string]$request.selection) ([int]$request.commandSettleMs) ([int]$request.selectionSettleMs)
      }
      'pressPaste' {
        Send-WinFormsKeys '^v' 140
      }
      'pressEnter' {
        Send-WinFormsKeys '{ENTER}' 120
      }
      'pressShortcut' {
        $keys = @()
        foreach ($value in $request.keys) { $keys += [int]$value }
        Send-KeyChord $keys
      }
      'pressCancel' {
        Send-WinFormsKeys '{ESC}' 100
        Start-Sleep -Milliseconds 80
        Send-WinFormsKeys '^.' 160
        Start-Sleep -Milliseconds 160
        Click-CodexComposerActionButton
      }
      'getToolbarState' {
        $json = Get-CodexToolbarState
        $result = $json | ConvertFrom-Json
      }
      'snapshotClipboard' {
        $meta = @{ type = 'empty' }
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
          [System.IO.File]::WriteAllText(([string]$request.textFile), [System.Windows.Forms.Clipboard]::GetText(), (New-Object System.Text.UTF8Encoding($false)))
          $meta.type = 'text'
        } elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
          $img = [System.Windows.Forms.Clipboard]::GetImage()
          if ($img -ne $null) {
            $img.Save(([string]$request.imageFile), [System.Drawing.Imaging.ImageFormat]::Png)
            $img.Dispose()
            $meta.type = 'image'
          }
        } elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
          $files = @()
          foreach ($item in [System.Windows.Forms.Clipboard]::GetFileDropList()) { $files += [string]$item }
          $meta.type = 'files'
          $meta.files = $files
        }
        [System.IO.File]::WriteAllText(([string]$request.metaFile), ($meta | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
      }
      'restoreClipboard' {
        $meta = [System.IO.File]::ReadAllText(([string]$request.metaFile)) | ConvertFrom-Json
        if ($meta.type -eq 'text') {
          $text = [System.IO.File]::ReadAllText(([string]$request.textFile))
          [System.Windows.Forms.Clipboard]::SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
        } elseif ($meta.type -eq 'image') {
          $img = [System.Drawing.Image]::FromFile([string]$request.imageFile)
          try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }
        } elseif ($meta.type -eq 'files') {
          $list = New-Object System.Collections.Specialized.StringCollection
          foreach ($file in $meta.files) { [void]$list.Add([string]$file) }
          [System.Windows.Forms.Clipboard]::SetFileDropList($list)
        } else {
          [System.Windows.Forms.Clipboard]::Clear()
        }
      }
      default {
        throw "Unsupported helper action: $action"
      }
    }
    Write-CodexMiniResponse @{ id = $id; ok = $true; result = $result }
  } catch {
    Write-CodexMiniResponse @{ id = $id; ok = $false; error = [string]($_.Exception.Message) }
  }
}
`;

function runPowerShell(script, input, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeoutMs || process.env.CODEX_MAX_WIN32_POWERSHELL_TIMEOUT_MS || process.env.CODEX_MINI_WIN32_POWERSHELL_TIMEOUT_MS || 12000);
    let settled = false;
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `${PS_PREAMBLE}\n${script}`,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      finish(() => {
        try { child.kill(); } catch {}
        reject(Object.assign(new Error(`Windows 自动化超时（${timeoutMs}ms）。`), { code: 'WIN32_AUTOMATION_TIMEOUT', stdout, stderr }));
      });
    }, timeoutMs) : null;
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', error => finish(() => reject(error)));
    child.on('close', code => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `powershell.exe exited with code ${code}`), { code, stdout, stderr }));
      });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function createPowerShellHelper() {
  let child = null;
  let nextId = 1;
  let buffer = '';
  const pending = new Map();

  function rejectAll(error) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }

  function stop() {
    const current = child;
    child = null;
    buffer = '';
    if (current && current.exitCode === null && !current.killed) {
      try { current.kill(); } catch {}
    }
    rejectAll(new Error('Windows helper stopped.'));
  }

  function ensureStarted() {
    if (child && child.exitCode === null && !child.killed) return child;
    child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `${PS_PREAMBLE}\n${PS_HELPER_LOOP}`,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const item = pending.get(message.id);
        if (!item) continue;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.ok) item.resolve(message.result || {});
        else item.reject(new Error(message.error || 'Windows helper action failed.'));
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', error => {
      const failed = child;
      if (failed === child) child = null;
      rejectAll(error);
    });
    child.on('exit', () => {
      child = null;
      rejectAll(new Error('Windows helper exited.'));
    });
    return child;
  }

  function request(action, payload = {}, options = {}) {
    const timeoutMs = Number(options.timeoutMs || process.env.CODEX_MAX_WIN32_HELPER_TIMEOUT_MS || process.env.CODEX_MINI_WIN32_HELPER_TIMEOUT_MS || 8000);
    return new Promise((resolve, reject) => {
      const proc = ensureStarted();
      const id = nextId++;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Windows helper timeout (${timeoutMs}ms): ${action}`));
      }, timeoutMs) : null;
      pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(`${JSON.stringify({ id, action, ...payload })}\n`);
      } catch (error) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  return { request, stop };
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function win32KeyCode(key) {
  const normalized = String(key || '').toLowerCase();
  if (normalized === 'enter') return 0x0D;
  if (normalized === 'esc' || normalized === 'escape') return 0x1B;
  if (normalized === '.') return 0xBE;
  if (normalized.length === 1) return normalized.toUpperCase().charCodeAt(0);
  throw new Error(`Unsupported key: ${key}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createQueue() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const next = tail.then(fn, fn);
    tail = next.catch(() => {});
    return next;
  };
}

module.exports = function createWin32Platform(env) {
  const {
    isCodexThreadId,
    codexThreadDeepLink,
    codexNewThreadDeepLink,
    CODEX_DEEPLINK_SETTLE_MS,
    CODEX_APP_FOCUS_SETTLE_MS,
    CODEX_THREAD_SYNC_FRESH_MS,
  } = env;

  const enqueue = createQueue();
  const helper = createPowerShellHelper();
  const warmupTimer = setTimeout(() => {
    helper.request('ping', {}, { timeoutMs: 6000 }).catch(() => {});
  }, 50);
  if (warmupTimer.unref) warmupTimer.unref();
  let lastCodexThreadActivation = { threadId: '', at: 0 };
  let keepAwakeProcess = null;
  let keepAwakeStartedAt = '';

  function hasFreshCodexThreadActivation(threadId) {
    return Boolean(
      isCodexThreadId(threadId) &&
      lastCodexThreadActivation.threadId === threadId &&
      Date.now() - lastCodexThreadActivation.at <= CODEX_THREAD_SYNC_FRESH_MS
    );
  }

  async function activateCodexThread(threadId = '', options = {}) {
    if (options.allowCached && hasFreshCodexThreadActivation(threadId)) {
      await helper.request('activate', {}, { timeoutMs: 5000 });
      await delay(CODEX_APP_FOCUS_SETTLE_MS);
      return;
    }

    const deepLink = codexThreadDeepLink(threadId);
    if (deepLink) {
      await helper.request('invokeLink', {
        url: deepLink,
      }, { timeoutMs: 5000 });
      await delay(CODEX_DEEPLINK_SETTLE_MS);
    } else {
      await helper.request('invokeLink', { url: 'codex://threads/new' }, { timeoutMs: 5000 });
      await delay(CODEX_DEEPLINK_SETTLE_MS);
    }
    await helper.request('activate', {}, { timeoutMs: 5000 });
    await delay(CODEX_APP_FOCUS_SETTLE_MS);
    if (isCodexThreadId(threadId)) lastCodexThreadActivation = { threadId, at: Date.now() };
  }

  async function activateNewCodexThread(cwd = '') {
    const deepLink = codexNewThreadDeepLink(cwd);
    await helper.request('invokeLink', { url: deepLink }, { timeoutMs: 5000 });
    await delay(CODEX_DEEPLINK_SETTLE_MS + 220);
    await helper.request('activate', {}, { timeoutMs: 5000 });
    await delay(CODEX_APP_FOCUS_SETTLE_MS);
    lastCodexThreadActivation = { threadId: '', at: 0 };
  }

  async function activateNewProjectlessCodexThread() {
    await activateNewCodexThread('');
  }

  async function focusTarget(target, threadId = '', options = {}) {
    if (target !== 'codex') return;
    const shouldReloadThread = options.reloadThread !== false && isCodexThreadId(threadId);
    if (shouldReloadThread && options.bounceViaNewThread) {
      await activateNewCodexThread('');
      await delay(160);
    }
    await activateCodexThread(threadId, {
      allowCached: shouldReloadThread ? false : Boolean(options.assumeThreadSynced),
    });
    if (options.skipComposerClick) {
      await helper.request('primeComposer', {}, { timeoutMs: 5000 });
      return;
    }
    await helper.request('focusComposer', {}, { timeoutMs: 6000 });
  }

  async function copyTextToClipboard(text) {
    await helper.request('setClipboardText', { text: String(text || '') }, { timeoutMs: 4000 });
  }

  async function copyImageToClipboard(file) {
    const filePath = file && file.filePath;
    if (!filePath || !fs.existsSync(filePath)) throw new Error(`图片文件不存在：${filePath || ''}`);
    await helper.request('copyImage', { filePath }, { timeoutMs: 6000 });
  }

  async function typeText(text) {
    await runPowerShell(`Send-UnicodeText ${psLiteral(String(text || ''))}`);
  }

  async function pasteTextAndEnter(text) {
    await helper.request('pasteTextAndEnter', { text: String(text || '') }, { timeoutMs: 6000 });
  }

  async function pasteTextOnly(text) {
    await helper.request('pasteTextOnly', { text: String(text || '') }, { timeoutMs: 6000 });
  }

  async function runCodexCommandSelection(command, selection, options = {}) {
    await helper.request('commandSelection', {
      command: String(command || ''),
      selection: String(selection || ''),
      commandSettleMs: Number(options.commandSettleMs || 700),
      selectionSettleMs: Number(options.selectionSettleMs || 700),
    }, { timeoutMs: Number(options.timeoutMs || 9000) });
  }

  async function pressPaste() {
    await helper.request('pressPaste', {}, { timeoutMs: 5000 });
  }

  async function pressEnter() {
    await helper.request('pressEnter', {}, { timeoutMs: 5000 });
  }

  async function pressCodexShortcut(key, modifiers = []) {
    const codes = [];
    for (const modifier of modifiers) {
      const normalized = String(modifier || '').toLowerCase();
      if (normalized === 'command' || normalized === 'control' || normalized === 'ctrl') codes.push(0x11);
      else if (normalized === 'shift') codes.push(0x10);
      else if (normalized === 'option' || normalized === 'alt') codes.push(0x12);
    }
    codes.push(win32KeyCode(key));
    await helper.request('pressShortcut', { keys: codes }, { timeoutMs: 5000 });
  }

  async function pressCancelCodexResponse() {
    await helper.request('pressCancel', {}, { timeoutMs: 7000 });
  }

  async function getToolbarState() {
    return helper.request('getToolbarState', {}, { timeoutMs: 5000 });
  }

  async function snapshotClipboard() {
    const dir = path.join(os.tmpdir(), `codex-max-clipboard-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    const metaFile = path.join(dir, 'meta.json');
    const textFile = path.join(dir, 'text.txt');
    const imageFile = path.join(dir, 'image.png');
    await helper.request('snapshotClipboard', { metaFile, textFile, imageFile }, { timeoutMs: 5000 });
    return { dir, metaFile, textFile, imageFile };
  }

  async function restoreClipboard(snapshot) {
    if (!snapshot || !fs.existsSync(snapshot.metaFile)) return;
    await helper.request('restoreClipboard', {
      metaFile: snapshot.metaFile,
      textFile: snapshot.textFile,
      imageFile: snapshot.imageFile,
    }, { timeoutMs: 5000 });
  }

  async function withClipboardPreserved(fn) {
    return enqueue(async () => {
      const snapshot = await snapshotClipboard();
      try {
        return await fn();
      } finally {
        await delay(Number(process.env.CODEX_MAX_WIN32_CLIPBOARD_RESTORE_DELAY_MS || process.env.CODEX_MINI_WIN32_CLIPBOARD_RESTORE_DELAY_MS || 900));
        try { await restoreClipboard(snapshot); } finally { fs.rmSync(snapshot.dir, { recursive: true, force: true }); }
      }
    });
  }

  async function runExclusive(fn) {
    return enqueue(fn);
  }

  function keepAwakeStatus() {
    const enabled = Boolean(keepAwakeProcess && keepAwakeProcess.exitCode === null && !keepAwakeProcess.killed);
    return {
      enabled,
      startedAt: enabled ? keepAwakeStartedAt : '',
      command: 'SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)',
    };
  }

  function startKeepAwake() {
    return enqueue(async () => {
      const current = keepAwakeStatus();
      if (current.enabled) return current;
      const script = `${PS_PREAMBLE}
        $ES_CONTINUOUS = 0x80000000
        $ES_SYSTEM_REQUIRED = 0x00000001
        $ES_DISPLAY_REQUIRED = 0x00000002
        [void][CodexMiniWin32]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED)
        while ($true) {
          Start-Sleep -Seconds 45
          [void][CodexMiniWin32]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED)
        }
      `;
      keepAwakeProcess = spawn('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ], { stdio: 'ignore', windowsHide: true });
      keepAwakeStartedAt = new Date().toISOString();
      keepAwakeProcess.on('exit', () => {
        keepAwakeProcess = null;
        keepAwakeStartedAt = '';
      });
      keepAwakeProcess.on('error', () => {
        keepAwakeProcess = null;
        keepAwakeStartedAt = '';
      });
      return keepAwakeStatus();
    });
  }

  function stopKeepAwake() {
    return enqueue(async () => {
      const child = keepAwakeProcess;
      keepAwakeProcess = null;
      keepAwakeStartedAt = '';
      if (child && child.exitCode === null && !child.killed) {
        try { child.kill(); } catch {}
      }
      await runPowerShell(`
        $ES_CONTINUOUS = 0x80000000
        [void][CodexMiniWin32]::SetThreadExecutionState($ES_CONTINUOUS)
      `);
      return keepAwakeStatus();
    });
  }

  function cleanup() {
    helper.stop();
    const child = keepAwakeProcess;
    keepAwakeProcess = null;
    keepAwakeStartedAt = '';
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill(); } catch {}
    }
  }

  return {
    name: 'win32',
    focusTarget,
    activateCodexThread,
    activateNewCodexThread,
    activateNewProjectlessCodexThread,
    copyTextToClipboard,
    typeText,
    pasteTextAndEnter,
    pasteTextOnly,
    runCodexCommandSelection,
    copyImageToClipboard,
    pressPaste,
    pressEnter,
    pressCodexShortcut,
    pressCancelCodexResponse,
    getToolbarState,
    keepAwakeStatus,
    startKeepAwake,
    stopKeepAwake,
    withClipboardPreserved,
    runExclusive,
    cleanup,
  };
};

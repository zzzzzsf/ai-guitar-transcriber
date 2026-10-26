# 生成 src-tauri/appicon.png（1024x1024，透明圆角）
# 设计：App 主题色渐变（--accent-from #8b5cf6 -> --accent-to #d946ef）圆角方形 + 白色吉他拨片 + 渐变音孔圆点
# 产出后用 Tauri CLI 生成全套图标：
#   cd src-tauri && npx @tauri-apps/cli icon appicon.png
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 2 * $r
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# 背景：圆角方形 + 对角渐变（App 主题色）
$bg = New-RoundRect 0 0 $size $size 224
$from = [System.Drawing.Color]::FromArgb(0xFF, 0x8B, 0x5C, 0xF6)
$to   = [System.Drawing.Color]::FromArgb(0xFF, 0xD9, 0x46, 0xEF)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
    (New-Object System.Drawing.Rectangle(0, 0, $size, $size)), $from, $to, 45.0)
$g.FillPath($brush, $bg)

# 白色吉他拨片（上圆下尖的水滴形）
$pick = New-Object System.Drawing.Drawing2D.GraphicsPath
$pick.AddArc(272, 220, 480, 480, 180, 180)
$pick.AddBezier(752, 460, 738, 620, 636, 792, 512, 852)
$pick.AddBezier(512, 852, 388, 792, 286, 620, 272, 460)
$pick.CloseFigure()
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.FillPath($white, $pick)

# 拨片内的渐变音孔圆点
$dot = New-Object System.Drawing.Drawing2D.GraphicsPath
$dot.AddEllipse(416, 356, 192, 192)
$g.FillPath($brush, $dot)

$g.Dispose()
$out = Join-Path $PSScriptRoot '..\appicon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "appicon written: $out"

Add-Type -AssemblyName System.Drawing
$b64 = '6YCB44CA6LSn44CA5Y2VCgrkvpvotKfljZXkvY3vvJrph43luobpkavovr7pkqLmnZDmnInpmZDlhazlj7gK5Y2V5Y+377yaWFMtMjAyNjA5MTktMDA444CA44CA44CA5pel5pyf77yaMjAyNuW5tDnmnIgxOeaXpQoK5bqP5Y+3ICAg5ZOB5ZCNICAgICAg6KeE5qC85Z6L5Y+3ICAgICAgICAgICAg5Y2V5L2NICAgIOaVsOmHjyAgICAgIOWNleS7tyAgICAgICAg6YeR6aKdCjEgICAgICDonrrnurnpkqIgICAgSFJCNDAwIDEybW0gICAgICAgICDlkKggICAgICAyLjUgICAgICAzODAwLjAwICAgICA5NTAwLjAwCjIgICAgICDlnIbpkqIgICAgICBRMjM1IDIwbW0gICAgICAgICAgIOWQqCAgICAgIDEuMiAgICAgIDQyMDAuMDAgICAgIDUwNDAuMDAKMyAgICAgIOinkumSoiAgICAgIDUww5c1MMOXNSAgICAgICAgICAgICDlkKggICAgICAwLjggICAgICAzOTUwLjAwICAgICAzMTYwLjAwCgrlkIjorqEgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAxNzcwMC4wMAoK5aSH5rOo77ya6LSn5bey5pS25Yiw77yM6aqM5pS25ZCI5qC844CC'
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
$w = 1240; $h = 1754
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$bmp.SetResolution(200, 200)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$font = New-Object System.Drawing.Font("SimSun", 19, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$rect = New-Object System.Drawing.RectangleF(120, 120, ($w - 240), ($h - 240))
$g.DrawString($text, $font, [System.Drawing.Brushes]::Black, $rect)
$g.Dispose()
$bmp.Save("F:\\\\2026-09-19\\\\new-chat-1\\\\_verify\\\\shots\\\\delivery-note-small.jpg", [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
Write-Output ("saved " + (Get-Item "F:\\\\2026-09-19\\\\new-chat-1\\\\_verify\\\\shots\\\\delivery-note-small.jpg").Length + " bytes")
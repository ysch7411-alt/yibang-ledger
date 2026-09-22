// 生成一张「真值已知」的送货单图片，用来验证 OCR 快路的准确率。
// 思路：本机有中文字体（服务器没有），用 PowerShell + System.Drawing 画。
// 关键：.ps1 必须是纯 ASCII，否则 Windows PowerShell 5.1 会把中文按 ANSI 解码成乱码，
// 所以中文文本走 base64 传进去。
const fs = require('fs');
const path = require('path');

const NOTE = [
  '送　货　单',
  '',
  '供货单位：重庆鑫达钢材有限公司',
  '单号：XS-20260919-008　　　日期：2026年9月19日',
  '',
  '序号   品名      规格型号            单位    数量      单价        金额',
  '1      螺纹钢    HRB400 12mm         吨      2.5      3800.00     9500.00',
  '2      圆钢      Q235 20mm           吨      1.2      4200.00     5040.00',
  '3      角钢      50×50×5             吨      0.8      3950.00     3160.00',
  '',
  '合计                                                      17700.00',
  '',
  '备注：货已收到，验收合格。'
].join('\n');

const b64 = Buffer.from(NOTE, 'utf8').toString('base64');

// 用法: node make-note-image.js [宽 高 字号 输出名]
// 缩小版是为了能塞进 automation_evaluate 的参数上限（实测 125KB 的 base64 会被拒）
const W = Number(process.argv[2] || 1654);
const H = Number(process.argv[3] || 2339);
const FONT = Number(process.argv[4] || 24);
const NAME = process.argv[5] || 'delivery-note.jpg';

const outDir = path.resolve(__dirname, 'shots');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outJpg = path.join(outDir, NAME);

const ps = [
  'Add-Type -AssemblyName System.Drawing',
  "$b64 = '" + b64 + "'",
  '$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))',
  '$w = ' + W + '; $h = ' + H,
  '$bmp = New-Object System.Drawing.Bitmap($w, $h)',
  '$bmp.SetResolution(200, 200)',
  '$g = [System.Drawing.Graphics]::FromImage($bmp)',
  '$g.Clear([System.Drawing.Color]::White)',
  '$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit',
  '$font = New-Object System.Drawing.Font("SimSun", ' + FONT + ', [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)',
  '$rect = New-Object System.Drawing.RectangleF(120, 120, ($w - 240), ($h - 240))',
  '$g.DrawString($text, $font, [System.Drawing.Brushes]::Black, $rect)',
  '$g.Dispose()',
  '$bmp.Save("' + outJpg.replace(/\\/g, '\\\\\\\\') + '", [System.Drawing.Imaging.ImageFormat]::Jpeg)',
  '$bmp.Dispose()',
  'Write-Output ("saved " + (Get-Item "' + outJpg.replace(/\\/g, '\\\\\\\\') + '").Length + " bytes")'
].join('\r\n');

const ps1 = path.join(outDir, 'gen-note.ps1');
fs.writeFileSync(ps1, ps, 'ascii');
console.log('ps1: ' + ps1);
console.log('jpg 目标: ' + outJpg);
console.log('（中文走 base64，脚本纯 ASCII）');

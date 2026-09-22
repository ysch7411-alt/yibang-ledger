#!/bin/sh
# 直接调用 DevTools 的 CLI，绕开 wechatide.cmd（.cmd 的 %* 在参数含空格/引号时会串味）
DIR="D:/Program Files (x86)/Tencent/微信web开发者工具"
BOOTSTRAP='const e=process.argv[1],a=process.argv.slice(2).filter(function(x){return x!=="--electron"});if(!process.env.cwd)process.env.cwd=process.cwd();process.argv=[process.execPath,e,"--electron"].concat(a);require(e)'
ELECTRON_RUN_AS_NODE=1 "$DIR/微信开发者工具.exe" -e "$BOOTSTRAP" "$DIR/resources/app.asar.unpacked/js/common/cli/skill-index.js" "$@"

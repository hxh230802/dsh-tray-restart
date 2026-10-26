# dsh-tray-restart

把 **「重启 DeepSeek Harness」** 加到 DeepSeek Harness 桌面端**现有的菜单**里：

- 系统托盘右键菜单：`打开 DeepSeek Harness` / **`重启 DeepSeek Harness`** / `退出 DeepSeek Harness`
- 标题栏「应用」菜单（macOS 为菜单栏）：生产构建也出现 **`重启 DeepSeek Harness`**（官方原本只在 development 构建里放重启项）

点它执行的是应用自己的 `app.relaunch()` + `quitWithoutConfirmation()`：先走正常的退出流程（Host 关闭、任务收尾），再重新拉起应用。它和官方开发版里的重启项是同一套逻辑。

## 原理

桌面端的托盘和应用菜单由 Electron 主进程的 `resources/app.asar` → `lib/main.js` 创建。DSH 插件跑在 Host 子进程里，没有任何运行时接口能往这些原生菜单里加项，所以本插件在 Host 每次启动时直接给 `lib/main.js` 打一个**等长**补丁：

1. 找到 `lib/main.js`，检查是否已有 `dsh-tray-restart:menu:v2` 标记；
2. 没有则做两处文本替换，删掉同区域等长的注释、用空格补齐，保证**字节长度完全不变**（asar 里每个文件的 offset 是固定的，不能改长度）；
3. 用真实的 Node 对补丁后的 ESM 跑 `node --check`，失败就完全不碰 `app.asar`；
4. 备份原始 `main.js`，原地写入，更新 asar header 里该文件的 SHA256，再读回校验；
5. 因为主进程已经加载了旧代码，**重启一次 DSH** 后新菜单才会出现。

应用更新会替换 `app.asar`；下次启动插件检测到标记消失，会自动重新打补丁。

## 安装

在 DSH 的插件管理器里安装 GitHub 仓库：

```
github:hxh230802/dsh-tray-restart
```

或使用 `plugin_manager` 工具：

```json
{ "action": "install_bundle", "target": "github:hxh230802/dsh-tray-restart" }
```

安装后如果 Host 已经热加载了插件，`app.asar` 会立刻被补上，但菜单要**重启一次**才更新。也可以手动落盘：

```powershell
node scripts/apply.mjs
```

## 还原

原始 `lib/main.js` 备份在：

```
%USERPROFILE%\.dsh\dsh-tray-restart\backup\main.original.js
%USERPROFILE%\.dsh\dsh-tray-restart\backup\manifest.json
```

还原（会先确认当前 `main.js` 仍是插件写入的那一版）：

```powershell
node scripts/restore.mjs
```

如果应用更新过，脚本会拒绝还原，避免把旧文件覆盖到新版本上。

极端情况下（asar header 被写坏、常规 restore 无法解析），用原始 header 备份直接回写：

```powershell
node scripts/emergency-restore.mjs
```

## 配置

profile patch 里按 id `dsh-tray-restart` 覆盖：

```yaml
- id: dsh-tray-restart
  config:
    enabled: true       # false = 不加载、不检查补丁
    dryRun: false       # true = 只生成补丁并做语法校验，不写 app.asar
    verifySyntax: true  # 写入前跑 node --check
    asarPath: ''        # 仅调试/非标准安装时显式指定 app.asar
```

## 状态与日志

```
%USERPROFILE%\.dsh\dsh-tray-restart\status.json
%USERPROFILE%\.dsh\logs\dsh-tray-restart.log
```

`status.json` 的 `state` 可能是 `patched`、`already-patched`、`dry-run`、`failed`、`skipped`。

## 注意

- 补丁只匹配当前桌面端版本的 `main.js` 文案（`0.2.0-rc.2` 验证通过）。应用大版本更新后如果锚点对不上，插件会记录 `unsupported` 并**保持 `app.asar` 原样**，不会把应用弄坏。
- 这是对已安装应用文件的修改，不是官方 API；写入前有语法校验和备份。若应用无法启动，运行 `node scripts/restore.mjs` 还原即可。
- 「重启」会中断正在运行的任务；它没有额外的二次确认，和官方开发版菜单一致。
- 仅 Windows 桌面端需要打补丁；`dsh web` / 开发模式会跳过。

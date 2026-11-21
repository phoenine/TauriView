# 构建 Windows 安装包

## 推荐命令

```powershell
npm run build:desktop
```

它等价于先执行 `tauri build`，再执行 `scripts/fix-installer-integrity.ps1`。

## 为什么需要后处理

如果打包终端本身处于低完整性级别（例如某些沙箱或受限 shell），新生成的 `tauriview.exe` 和 NSIS `setup.exe` 会继承 Low 完整性标签。双击安装时，安装器以 Low 运行，无法写入 Medium 的 `%LOCALAPPDATA%\TauriView`，会在安装中途报：

```text
Error opening file for writing:
C:\Users\<用户>\AppData\Local\TauriView\tauriview.exe
```

脚本会对以下文件执行 `icacls <文件> /setintegritylevel M`：

- `src-tauri\target\release\tauriview.exe`
- `src-tauri\target\release\bundle\nsis\*.exe`

随后检查 SDDL 中不再出现 Low 标签（`;;;LW)`）。已经是 Medium 或没有显式标签的文件不会被改坏。

## 手动构建

如果已经直接运行过 `npm run tauri build`，可以补跑：

```powershell
npm run fix:installer
```

## 说明

- 当前发布使用 NSIS；MSI 仍受 WiX 代码页 1252 对中文产品字符串的限制，脚本不处理 MSI。
- 该步骤只调整构建产物的完整性标签，不改变安装包内容或签名。

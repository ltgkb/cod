# COD 桌面伙伴 0.7.0：三端接入与发布审计

## 接入范围

COD Desktop 在 macOS、Windows 和 Linux 上发现已安装的桌宠，校验已审计版本，随后由用户在“命令面板 → 桌面伙伴”中手动启动或停止。桌宠不会随 COD 静默自启。

真实模型对话由 COD Desktop 的临时回环代理提供：

- 代理只监听 `127.0.0.1` 的随机端口；
- 桌宠只获得随机、短生命周期的代理密钥，不获得 COD 登录令牌；
- 代理固定当前用户在 COD 中选择的模型源和模型，桌宠不能改写计费路由；
- 登出、退出 COD 或停止桌宠时，同时关闭代理及由 COD 启动的桌宠进程；
- 子进程环境使用白名单，不继承数据库、云平台或其他宿主密钥。

## 支持的安装位置

| 平台 | 已审核架构 | 默认发现位置 |
| --- | --- | --- |
| macOS | Apple Silicon | `/Applications/COD桌宠.app`、`~/Applications/COD桌宠.app` |
| Windows | x64 | `%LOCALAPPDATA%\Programs\COD Desktop Pet\COD-Desktop-Pet.exe`、`%LOCALAPPDATA%\Programs\cod-desktop-pet\COD-Desktop-Pet.exe`、`%ProgramFiles%\COD Desktop Pet\COD-Desktop-Pet.exe` |
| Linux | x64 | `~/.local/opt/cod-desktop-pet/cod-desktop-pet`、`~/Applications/COD-Desktop-Pet-0.7.0-linux-x64/cod-desktop-pet`、`~/Applications/COD-Desktop-Pet-0.7.0-linux-x86_64.AppImage`、`/opt/cod-desktop-pet/cod-desktop-pet` |

开发态可以用绝对路径环境变量 `COD_DESKTOP_PET_PATH` 指向解压后的应用；正式包忽略该变量。正式构建也可以把平台对应的程序放入 COD 的 `resources/desktop-pet`。

## 已验证内容

- `SHA256SUMS-0.7.0.txt` 中六个安装包的 SHA-256 均与文件一致。
- macOS、Windows、Linux 的 `app.asar` 完全一致，SHA-256 为 `3ac8f66d8724e2bc5d5381791f2971e53f33d4fd2fc8848fc1204eb7d61d3a72`。
- Electron 版本为 `43.4.0`；渲染器开启 `contextIsolation`、关闭 `nodeIntegration`、启用沙箱。
- 页面通过 `codpet:` 自定义协议加载，资源路径采用白名单与目录边界检查。
- CSP 禁止远端脚本、对象和渲染器网络；导航、新窗口与 webview 被拦截。
- IPC 校验发送窗口及精确 `codpet:` URL；语音权限只允许桌宠主窗口请求音频。
- COD 工作台地址固定为 `https://cod.kai.com`，重定向与含凭据 URL 被拒绝。
- 工作台令牌通过 Electron `safeStorage` 加密；Linux `basic_text` 后端被拒绝。
- ZIP/TAR 未发现绝对路径或 `..` 穿越条目。

COD 还会在每次启动前重新校验桌宠主程序和 ASAR。发现文件但哈希不符时，状态为“文件校验失败”并拒绝执行。

## 正式发布阻断

当前 0.7.0 只能用于受控内测，不能放到公开下载页：

1. macOS 应用仅有 ad-hoc 签名，`spctl` 拒绝，且没有公证票据；需要 Developer ID Application 签名、Hardened Runtime 审核和 notarization/stapling。
2. Windows 安装器与主程序没有 Authenticode 证书目录；需要受信任代码签名证书和签名时间戳。
3. Linux 暂无独立发布签名；至少应提供固定 HTTPS 下载、SHA-256，以及 GPG/minisign 签名。
4. macOS 申请麦克风与语音识别权限，并启用了 Electron JIT、unsigned executable memory 和 disable library validation。正式签名前需确认最后一项确属 Electron/语音 Helper 所需，能移除则移除。
5. 内置聊天历史是本地明文 JSON（权限 `0600`），不是端到端加密存储。产品文案应明确本机存储，并提供清除入口。

公开下载清单应继续保持 `preparing`，直到三端签名和发布验收完成。

## COD Desktop 三端构建复验（2026-08-12）

同一份 COD Desktop 0.1.3 源码已分别生成 macOS arm64、Windows x64 和 Linux x64 包；三个解包目录的 `app.asar` 均包含 `desktop-pet.js`、`pet-chat-proxy.js` 与 `taskboard-url.js`。Goose sidecar 会在打包前读取可执行文件头并拒绝平台或架构不匹配，交叉构建使用 npm 官方包 `@aaif/goose-binary-*-x64@0.20.2`，没有把临时下载内容写入仓库。

| COD 包 | SHA-256 | 复验结果 |
| --- | --- | --- |
| `COD-0.1.3-mac-arm64.dmg` | `b68d92f6703e3259f16787bd7de60951ceb2312ef5c0260fabee4f5f54c11b67` | 打包成功；深度签名结构有效；ATS 仅允许本机例外；仍为 ad-hoc，未公证 |
| `COD-0.1.3-mac-arm64.zip` | `2bc047e05b837be3e0fa3707084145c903ee40fcf07d662eb2a5f007993635ac` | 打包成功；内容同上 |
| `COD-0.1.3-windows-x64.exe` | `a045283fe27d969902f1feeded724c318d935caf084473bdffd828b5ebefc9fc` | NSIS 交叉打包成功；内含 PE32+ x64 Goose；没有可验证的发布者证书 |
| `COD-0.1.3-x86_64.AppImage` | `aae82b2bc4dc28a6eaedad7ebe1fec4fbe32aa3fc2b52351c0cee2c74d38089e` | 打包成功；内含 ELF x64 Goose；尚无发布签名 |
| `COD-0.1.3-amd64.deb` | `122dd9ebf84201d736c090df4d5f161950be6db19371c1c0798e2d86a064556d` | 打包成功；内含 ELF x64 Goose；尚无仓库签名 |

这些结果证明三端目标、资源和集成代码可以构建，不代替在真实 Windows/Linux 主机上的安装、SmartScreen/桌面环境和卸载回归，也不解除上面的签名阻断。

## 0.7.0 安装包哈希

| 文件 | SHA-256 |
| --- | --- |
| `COD-Desktop-Pet-0.7.0-mac-arm64.dmg` | `b7c45b6292fdff41ea670e86fbe6dac1c94a5d4047d8cade28802eb2f3aad378` |
| `COD-Desktop-Pet-0.7.0-mac-arm64.zip` | `71f229b0e2058edaabca5187885f34374180aaf7344c0842a408a763f68bcf3f` |
| `COD-Desktop-Pet-0.7.0-win-x64.exe` | `d06d1bb787e64f1899d20fa07d0d2b8aa7bf38cdd9971d2b54871ae11e69bded` |
| `COD-Desktop-Pet-0.7.0-win-x64.zip` | `619b6ec5e416540288fc0061d83b3be8c5ddd3131cd7f5207228801fdbb37850` |
| `COD-Desktop-Pet-0.7.0-linux-x86_64.AppImage` | `7cb003b999cb00ec9cf3f83450e77100eda22a0c25eda0a6de56531adf2b9695` |
| `COD-Desktop-Pet-0.7.0-linux-x64.tar.gz` | `317316fda0ca43057d546b5fa6b7710caf6420dba7ee5143dea959aa54cb6001` |

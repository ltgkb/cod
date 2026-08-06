# COD 阶段 0 技术验证报告

日期：2026-08-06

服务器：`ubuntu@95.41.23.60`

## 结论

Goose 可以作为 COD 的 Agent 和桌面端技术底座。阶段 0 已验证源码构建、ACP 服务、OpenAI-compatible 模型网关、SSE 流式响应、Token 用量、文件工具、终端工具以及 Linux Electron 生产打包链路。

建议进入阶段 1，但保持上游与 COD 公司代码分离，不在 Goose 目录内散落业务逻辑。

## 环境

- Ubuntu 24.04，x86_64
- 2 vCPU，7.6 GiB 内存
- 根磁盘 48 GiB
- Goose commit：`1c1bd5299a243f309cb251d2bbe429c7f470793e`
- Goose version：`1.45.0`
- Rust：`1.96.1`
- Node：`24.10.0`
- pnpm：`10.30.3`

## 已通过验证

1. Goose 默认功能集从源码编译成功。
2. ACP 后端只监听 `127.0.0.1:3284`：
   - `/health` 返回 HTTP 200。
   - `/acp` 未携带 `x-secret-key` 返回 HTTP 401。
   - 携带正确密钥后进入 JSON-RPC 校验。
3. OpenAI-compatible Provider：
   - Base URL 应配置为 API 根路径，例如 `https://ai.kai.com/v1`。
   - Goose 会自动追加 `/chat/completions`。
   - SSE 流式输出正常。
   - `prompt_tokens`、`completion_tokens`、`total_tokens` 正常进入用量统计。
4. 代码 Agent 闭环：
   - `tree` 检查项目目录。
   - `edit` 修改文件。
   - `shell` 执行验证命令。
   - 测试项目由错误的减法修复为加法，执行结果为 `PASS`。
5. 桌面前端：
   - pnpm 依赖安装成功。
   - TypeScript typecheck 成功。
   - i18n 编译成功。
   - Electron Forge Linux x64 production package 成功。
6. 轻量 COD 功能集：
   - 不启用 `local-inference`、`code-mode`、AWS、Nostr 和 updater。
   - 保留 TLS、TUI、telemetry、OTel、system keyring。
   - `developer` 文件与终端工具仍能完成完整代码任务。

## 体积观察

当前均为 Debug 构建，不能视为最终安装包大小：

- 默认 Goose Debug binary：约 855 MiB。
- COD 轻量 Debug binary：约 579 MiB。
- Linux Electron 解包目录：约 889 MiB，内嵌 Debug binary。

阶段 1 应使用 Release 构建、符号裁剪和安装包压缩后重新测量。

## 需要 COD 自研的模块

- COD 品牌、产品导航和交互调整。
- `ai.kai.com` Provider、登录态、模型目录和错误码映射。
- 余额、充值、扣费、用量明细。
- `wiki.kai.com` MCP/HTTP adapter 和引用展示。
- 控制平面、设备注册、任务同步和远程审批。
- Web/PWA。
- 飞书、企业微信和其他 Bot gateway。
- `hongkong.kai.com` API/MCP 或 WebView 集成。

## 阶段 1 建议

1. 建立 COD 私有仓库及 CI。
2. 增加 `cod` 自有应用与配置目录，上游 Goose 作为可同步 remote。
3. 完成品牌白标与轻量 Release 构建。
4. 接入真实 `ai.kai.com` 测试环境。
5. 完成登录、余额和充值入口。
6. 用真实模型重复代码任务基准测试。

## 当前服务器目录

```text
/home/ubuntu/cod-project/
├── upstream/goose/       # Goose 上游源码
├── work/                 # 构建缓存、Mock、日志和验证 fixture
└── docs/                 # COD 技术文档
```

## 当前后台服务

- Goose ACP：`127.0.0.1:3284`
- Mock AI gateway：`127.0.0.1:18080`

两者均未直接暴露公网。

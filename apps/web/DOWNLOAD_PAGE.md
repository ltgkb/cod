# COD 客户端下载页

`public/download/` 由 `@cod/web` 的 Vite 构建原样复制到 `dist/download/`，生产地址为：

```text
https://cod.kai.com/download/
```

页面复用 COD 浅色界面的品牌令牌：

- 品牌色 `#177777`
- 页面底色 `#fbfdfd`
- 内容层 `#ffffff`
- 浅层与输入底色 `#f4f8f8`
- 细边框 `#d7e4e4`
- 主文字 `#172033`
- 正文 `#475569`

产品画面使用完整的 `1440 × 900` 浅色 COD 工作区截图，并按原始 `16:10` 比例展示。不要用 `object-fit: cover` 放大裁切窗口，也不要再加入模型表格或算力窗口的局部截图。

## 接入正式安装包

编辑 `public/download/release-manifest.json` 中对应平台条目。只有同时满足以下条件时，页面才会生成真实下载链接：

1. `status` 为 `available`
2. `url` 是 HTTP 或 HTTPS 地址

推荐使用不可变的版本化地址，例如：

```text
/downloads/desktop/0.2.0/COD-0.2.0-mac-arm64.dmg
```

同时填写 `version`、`architecture`、`requirements`、`size` 和 `sha256`。正式开放前须完成平台签名、公证或验收，不要把 CI 临时 artifact 或未签名 QA 包填入稳定频道。

## 本地预览

运行 COD Web 开发服务器后访问 `/download/`，或从 `public/download` 启动任意静态文件服务器。

# COD 算力市场 V2：产品、设计与工程交接规范

> 状态：可开发（2026-08-13）  
> 适用端：Web、macOS、Windows、Linux、Android、iOS  
> 产品基准：奇点算力移动端的信息架构、页面层级、商品密度与核心交易路径  
> 品牌与系统边界：使用 COD 品牌、账户、卡时、权限与控制面；不复制奇点算力商标、Logo、原文案或未获授权素材  
> 旧实现：[COMPUTE_MARKET_LIFECYCLE.md](./COMPUTE_MARKET_LIFECYCLE.md) 仅作为 V1 兼容与迁移依据

## 0. 一句话定义

把当前藏在工作台弹窗里的“需求登记表”升级成独立的 GPU 算力交易与设备托管产品：用户可以找卡、看配置、下单或询价、跟踪部署、管理托管设备与资产；管理员可以维护商品、库存、订单、设备、托管申请、报价和售后。

设计判断：这是面向算力租赁用户、设备方和运营人员的交易型产品，视觉与信息架构以奇点算力为参照，保持高信息密度、低学习成本和明确的资产/设备状态；COD 负责统一账户、卡时、任务联动与多端能力。

设计参数：`DESIGN_VARIANCE 4 / MOTION_INTENSITY 2 / VISUAL_DENSITY 7`。交易信息优先，不使用营销型大留白、玻璃拟态或与业务无关的动画。

---

## 1. “一比一复刻”的准确范围

### 1.1 必须对齐

- 移动端五栏结构：`首页 / 设备托管 / 资讯 / 排行榜 / 我的`。
- 首页热门算力卡的内容顺序、密度、筛选入口和“列表 → 详情 → 购买/询价”路径。
- 商品详情中的硬件摘要、CPU/内存/硬盘/驱动/CUDA、镜像、周期、数量、价格和底部主操作。
- “我的”页面中的资产、邀请、设备四状态以及服务入口网格。
- 托管设备从申请、审核、部署、运行、异常到退场的完整生命周期。
- 页面在 390 × 844 逻辑像素下的首要视觉层级和操作可达性。
- Android、iOS、Web 与三个桌面端使用同一业务语义、同一 API、同一状态文案。

### 1.2 必须替换

- 奇点算力名称、Logo、版权说明全部替换为 COD。
- 青色仍可作为算力模块的业务强调色，但必须来自 COD Token，不硬编码第三方色值。
- GPU 商品图片使用自有拍摄、厂商授权媒体包或明确可商用素材，并保留来源清单。
- 第三方宣传文案、性能承诺、价格、库存、评分和排行数据不得照抄；只展示 COD 后端真实返回的数据。
- “立即购买”“运行中”“可提现”等强承诺，只能在对应后端能力真实可用时展示。

### 1.3 不接受的“相似实现”

- 不继续使用一个超长弹窗承载所有功能。
- 不把四个业务类型继续做成同一表单的四个 Tab。
- 不用静态数组伪造库存、订单、收益、排行或设备状态。
- 不显示点击后只有“敬请期待”的入口；未完成能力必须由服务端 capability 隐藏。
- 不把“申请记录”计入“我的资产”或“我的设备”。

### 1.4 参考图逐项映射

| 参考 | 必须复刻的结构 | COD 页面 |
| --- | --- | --- |
| 热门算力卡长列表 | 标题/筛选、GPU 大图、型号显存、价格带、用途标签、2×2 规格、库存与详情 | 首页、商品列表、`OfferCard` |
| 商品详情 | 摘要卡、三组硬件配置、镜像表、时/天/月、数量、合计、底部主按钮 | 商品详情、确认订单 |
| “我的”页 | 用户头部、资产/邀请双卡、设备四状态、服务网格、五栏底部导航 | 我的、资产、邀请、设备、服务页 |

验收采用逐项结构对比，不以“颜色相近”或“有相同文字”为通过标准。

---

## 2. 产品目标与边界

### 2.1 核心目标

1. 用户可在 3 次点击内从首页进入某个 GPU 商品详情。
2. 有即时交付能力的商品可完成库存预占、结算与订单创建；其余商品走透明的人工询价。
3. 设备托管方能看到真实的审核、部署、运行和异常状态，而不是只有一条联系记录。
4. 管理员能够闭环处理商品、库存、订单、设备、报价和工单。
5. 同事可在独立目录和 V2 API 上开发，合并时对 `App.tsx`、`server.ts` 等热点文件只产生少量接线改动。

### 2.2 本轮不隐含承诺

- COD 不因 UI 上线自动成为设备保管方、托管服务商或融资提供方。
- 未接入真实库存锁定、支付、交付和退款前，不得开放即时购买。
- 未签署书面合同、完成设备验收前，不得把托管申请显示为正式资产。
- 排行榜不得使用无法核验的收益数据；没有真实数据时整个入口由 capability 隐藏。

---

## 3. 用户、权限与产品角色

| 角色 | 能做什么 | 不能做什么 |
| --- | --- | --- |
| 游客 | 浏览公开商品、资讯、公开排行；进入登录 | 查看价格协议、库存明细、订单、设备和资产 |
| 普通用户 | 下单/询价、管理本人订单、资产、地址、优惠券和邀请 | 查看他人信息、修改库存或推进交付状态 |
| 设备方 | 提交托管/入驻、管理本人设备、查看结算与工单 | 自行把设备设为审核通过或运行中 |
| 运营管理员 | 商品、库存、订单、托管申请、设备状态、报价、工单和内容运营 | 代替用户接受报价、伪造支付、删除审计记录 |
| 超级管理员 | 管理 capability、运营角色和系统配置 | 绕过审计或租户边界 |

任何含联系方式、合同、结算、地址的信息都必须按租户和所属用户隔离。管理员列表只展示脱敏摘要，进入详情时记录审计事件。

---

## 4. 信息架构与路由

算力市场是独立全屏模块，不再是工作区 Modal。入口仍位于 COD 左侧栏/移动端“更多”，点击后进入 `/compute`；退出后回到用户进入前的 COD 工作区。

```text
算力市场
├── 首页 ── 商品列表 ── 商品详情 ── 下单/询价 ── 订单交付
├── 设备托管 ── 托管申请 ── 申请详情 ── 我的设备 ── 运维/退场
├── 资讯 ── 资讯详情
├── 排行榜
└── 我的
    ├── 我的资产 ── 账本
    ├── 我的设备 / 我的订单
    ├── 邀请好友
    └── 认证、采购、优惠券、地址与客服
```

### 4.1 用户路由

| 路由 | 页面 | 登录要求 | 移动端入口 |
| --- | --- | --- | --- |
| `/compute` | 首页 / 热门算力 | 否 | 首页 |
| `/compute/offers` | 全部算力与筛选 | 否 | 首页“全部/筛选” |
| `/compute/offers/:offerId` | 商品详情 | 否 | 商品卡 |
| `/compute/checkout/:skuId` | 确认订单或询价 | 是 | 商品详情主按钮 |
| `/compute/orders` | 我的租赁订单 | 是 | 我的 / 资产 |
| `/compute/orders/:orderId` | 订单与交付详情 | 是 | 订单列表 |
| `/compute/hosting` | 设备托管首页 | 部分 | 设备托管 |
| `/compute/hosting/apply` | 算力入驻/托管申请 | 是 | 设备托管主按钮 |
| `/compute/hosting/applications/:id` | 申请详情 | 是 | 申请记录 |
| `/compute/devices` | 我的设备 | 是 | 设备托管 / 我的 |
| `/compute/devices/:deviceId` | 设备详情与工单 | 是 | 设备列表 |
| `/compute/news` | 资讯 | 否 | 资讯 |
| `/compute/news/:slug` | 资讯详情 | 否 | 资讯列表 |
| `/compute/rankings` | 排行榜 | 否 | 排行榜 |
| `/compute/me` | 我的 | 是 | 我的 |
| `/compute/assets` | 我的资产 | 是 | 我的资产卡 |
| `/compute/referrals` | 邀请好友 | 是 | 邀请卡 |
| `/compute/coupons` | 优惠券 | 是 | 服务网格 |
| `/compute/addresses` | 地址管理 | 是 | 服务网格 |
| `/compute/verification` | 实名/企业认证状态 | 是 | 服务网格 |
| `/compute/support` | 在线客服与工单 | 是 | 服务网格 |

### 4.2 管理端路由

| 路由 | 职责 |
| --- | --- |
| `/admin/compute/dashboard` | 成交、库存、部署、设备异常和待办总览 |
| `/admin/compute/catalog` | 商品、SKU、镜像、价格、标签、素材与上下架 |
| `/admin/compute/inventory` | 库存池、预占、节点、机房和维护状态 |
| `/admin/compute/orders` | 订单、询价、支付、退款、部署与交付 |
| `/admin/compute/hosting` | 托管/入驻申请、现场核验、报价和合同状态 |
| `/admin/compute/devices` | 托管设备、运行监控摘要、异常和退场 |
| `/admin/compute/tickets` | 售后与运维工单 |
| `/admin/compute/settlements` | 收益结算与发票；未接入时 capability 隐藏 |
| `/admin/compute/content` | Banner、资讯、排行规则和服务入口 |
| `/admin/compute/audit` | 高风险操作审计，只读 |

### 4.3 导航规则

- 移动端底栏固定五项，安全区内边距使用 `env(safe-area-inset-bottom)`。
- 商品详情、表单、订单详情使用顶部返回，不显示底栏，减少误触。
- Desktop/Web 宽屏使用 224px 左侧模块导航；内容区最大宽度 1200px。
- 浏览器后退、Android 原生返回、iOS 左缘返回依次退回页面栈；只有根页再次返回才退出算力模块。
- 刷新或冷启动必须根据 URL 恢复当前页；不得依赖仅存于组件内的 overlay 状态。

---

## 5. 全局页面框架

### 5.1 移动端（基准 390 × 844）

```text
┌──────────────────────────┐
│ 状态栏 / 安全区             │
│ 页面标题        通知  设置   │  52px
├──────────────────────────┤
│                          │
│ 可滚动页面内容              │
│                          │
├──────────────────────────┤
│ 首页 托管 资讯 排行榜 我的   │  56px + safe area
└──────────────────────────┘
```

- 页面背景 `--compute-canvas`，内容左右间距 12px。
- 一级卡片圆角 12px，二级控件 8px，按钮 8px；不要混用胶囊和直角体系。
- 顶部标题栏滚动后保持吸顶；内容不得藏在状态栏或 Dynamic Island 下。
- 表单焦点出现软键盘时，当前字段与错误信息必须仍可见；主按钮不可被键盘永久遮挡。

### 5.2 宽屏

```text
┌──────────┬───────────────────────────────────┐
│ COD      │ 算力市场 / 当前页       通知 账户  │
│ 首页     ├───────────────────────────────────┤
│ 算力     │                                   │
│ 托管     │  1200px 内的两/三栏响应式内容       │
│ 订单     │                                   │
│ 我的     │                                   │
│ 返回COD  │                                   │
└──────────┴───────────────────────────────────┘
```

- 不能把移动端 390px 页面简单居中放大。
- 商品列表：`>= 1180px` 三列，`768–1179px` 两列，`< 768px` 单列。
- 商品详情：宽屏为左侧信息/右侧购买卡；移动端恢复单列和底部吸附 CTA。

---

## 6. 页面级设计规范

### 6.1 首页 / 热门算力

内容顺序固定：

1. 轻量 Banner：当前可用卡时、进行中订单、异常设备三者最多展示两项；游客展示一句价值说明和登录入口。
2. 快捷入口：`找算力 / 托管设备 / 我的订单 / 在线客服`，最多四个。
3. “热门算力卡”标题、说明“精选高性能计算资源”和筛选按钮。
4. 商品瀑布流/列表。
5. 底部导航。

无真实 Banner 配置时直接省略 Banner，不使用占位轮播。

### 6.2 商品卡 `ComputeOfferCard`

移动端结构必须与参考卡一致：

```text
┌────────────────────────────────┐
│ 16:7 GPU 主图               热租 │
├────────────────────────────────┤
│ RTX 5090 / 32 GB               │
│ ¥64.60/日              原价 ¥68 │
│ [生成式AI] [高性能计算]          │
│ CPU 驱动版本       RAM 内存       │
│ SYS 系统盘         CUDA 版本      │
│ [8卡可租]              查看详情 > │
└────────────────────────────────┘
```

- 主图宽度 100%，`aspect-ratio: 16/7`，`object-fit: contain`；纯色或弱渐变背景，不能裁掉 GPU 主体。
- 标题 16/22、600；价格数字 22/28、700；单位 11/16。
- 价格带使用 `--compute-accent-soft`，原价只在真实折扣存在时展示并加删除线。
- 规格为 2 × 2，不超过 CPU、RAM、系统盘、CUDA 四项；驱动版本放 CPU 副文案。
- 库存标签来自后端：`充足 / 紧张 / 售罄 / 询价`，不直接输出精确库存给游客。
- 卡片整体可点，内部“查看详情”与卡片同一意图，不新增第二个不同跳转。

### 6.3 筛选页/抽屉

筛选项：

- GPU 系列与型号；显存档位；用途（训练/推理/AIGC/渲染/科研）。
- 交付形态（容器/虚拟机/裸金属）；区域；CUDA；价格周期。
- 库存状态；排序（综合、价格升/降、显存、热度）。

移动端使用底部抽屉，宽屏使用左侧筛选栏。筛选条件必须写入 URL query，刷新和分享后保持。重置后立即刷新结果；无结果时给出“清除筛选”，不推荐不存在的商品。

### 6.4 商品详情

顺序与参考保持一致：

1. 顶部返回 + “商品详情”。
2. 商品摘要：图片、型号、显存、可租状态。
3. 硬件配置：CPU/内存、硬盘、驱动/CUDA、网络/区域、交付形态。
4. 选择镜像：框架、框架版本、Python、CUDA；整行单选。
5. 选择周期：时/天/月，仅显示 SKU 支持项。
6. 选择数量：减号、数量、加号；受库存、最小量和最大量约束。
7. 开始时间/时长：即时商品必填，询价商品可填期望时间。
8. 费用明细：资源价、存储/公网附加项、优惠、合计和需要的 COD 卡时。
9. 底部主按钮。

主按钮语义由 `purchaseMode` 决定：

- `instant`：`立即购买`，前提是库存预占、支付和交付均已接通。
- `reservation`：`预占并确认`，进入 15 分钟库存预占和结算页。
- `quote`：`提交租赁需求`，明确提示“人工核验库存后报价”。
- 当商品状态或库存为 `sold_out`：禁用并显示 `当前无库存`。

### 6.5 确认订单

- 顶部展示商品/镜像/区域/数量/周期/开始时间摘要。
- 联系信息默认来自统一账户，可按订单修改但不反写账户。
- 结算优先级：优惠券 → COD 卡时 → 钱包/已接入支付渠道。
- 用户必须看见人民币总额、实际抵扣卡时、剩余应付和退款规则。
- 创建订单、支付、接受报价都使用独立 idempotency key。
- 提交前服务端重新计算价格；客户端金额仅作预览。

### 6.6 我的订单与订单详情

订单列表分为 `全部 / 待确认 / 交付中 / 使用中 / 已完成`。每项展示订单号后 8 位、GPU、数量、周期、金额、状态和更新时间。

详情包含：状态时间线、配置快照、价格快照、交付凭据摘要、联系人、合同/条款版本、工单入口与允许的操作。SSH 密钥、口令等秘密不在普通 JSON 响应或页面日志中返回；凭据通过短期一次性领取流程提供。

### 6.7 设备托管首页

- 顶部价值说明不超过两行。
- 四项状态汇总：待审核、部署中、运行中、待处理。
- 主入口：`申请设备托管`；次入口：`我的设备`、`申请记录`、`托管说明`。
- 托管流程横向/纵向步骤：提交资料 → 商务审核 → 现场/远程验机 → 报价与合同 → 入场部署 → 运行 → 退场。
- 明确第三方责任边界；若 COD 后续成为合同主体，应通过配置替换责任文案和合同流程，不能只改前端字样。

### 6.8 托管申请

拆成四步，不使用一页超长表单：

1. 主体与联系方式：个人/企业、认证状态、联系人、电话、所在城市。
2. 设备清单：品牌型号、GPU 型号、数量、序列号后四位、整机规格、产权证明状态。
3. 机房需求：U 数、功耗、网络、周期、可进场时间、运维/SLA、结算偏好。
4. 确认提交：资料摘要、责任边界、隐私说明和幂等提交。

支持草稿保存。用户返回上一步不丢数据；敏感附件必须先获取短期上传凭据，不通过控制面 JSON 上传大文件。

### 6.9 我的设备

顶部四状态与参考页一致：`待审核 / 部署中 / 运行中 / 待处理`。点击状态进入已筛选列表。

设备卡展示：设备名、GPU/卡数、机房区域（必要时模糊）、当前状态、最近心跳、近 24 小时可用率、待处理事项。没有真实监控接入时隐藏利用率和温度，不使用假折线图。

设备详情包含：

- 基础资料与验收记录。
- 部署与状态时间线。
- GPU/节点运行摘要；监控由专用 metrics API 返回聚合数据。
- 收益/费用摘要；无真实结算时隐藏。
- 工单、维护、退场申请。

### 6.10 资讯

- 只承担内容，不伪装成系统通知。
- 列表包含封面、标题、摘要、发布时间和分类；详情支持分享链接。
- 管理端可草稿、预览、定时发布和下架。
- 内容 HTML 必须服务端清洗，禁止直接渲染未过滤富文本。

### 6.11 排行榜

排行维度必须在页面说明：统计周期、指标、更新时间、是否匿名。

- 可选维度：设备有效运行时长、可用率、真实结算收益、服务质量。
- 默认匿名显示“用户 13****34”；用户主动同意才展示昵称。
- 管理员测试数据、退款订单、作弊或异常设备必须剔除。
- 没有可验证数据时服务端返回 `enabled:false`，底栏不显示该入口。

### 6.12 “我的”首页

页面顺序与参考页一致：

1. 头像、昵称/脱敏手机号、通知、设置。
2. 两列卡：`我的资产` 与 `邀请好友`。
3. `我的设备` 四状态卡：待审核、部署中、运行中、待处理。
4. 服务网格：实名认证、线下采购、优惠券、地址管理、算力入驻、在线客服、人工客服。
5. COD 品牌签名和五栏底部导航。

每个入口必须有实际页面或根据 capability 隐藏，禁止空壳按钮。

### 6.13 我的资产

“资产”必须拆清，不能用一个余额混合：

- 钱包余额（CNY）。
- COD 可用卡时（额度单位）。
- 托管结算：待结算、可结算、已结算；仅在真实结算系统接入时出现。
- 运行中的租赁资源数量。
- 明细账：充值、卡时包、租赁扣费、退款、托管结算、优惠。

申请、询价、被拒绝的托管记录不计入资产。

### 6.14 邀请好友

- 展示邀请码、邀请链接、复制/系统分享、规则和邀请记录。
- 奖励状态：待满足、待入账、已入账、已失效。
- 奖励入账必须由服务端根据被邀请人的真实条件触发，客户端不能自行领取。

### 6.15 管理端操作台

管理端不照搬移动端卡片，而采用高密度三段式工作台：左侧筛选/队列、中间列表、右侧详情抽屉。1280px 以下详情改为独立页面。

- Dashboard：今日新订单、待报价、待部署、运行实例、异常设备、即将到期预占和待处理工单；每个数字必须可下钻。
- 商品：草稿/已上架/已暂停/售罄，管理 SKU、镜像、价格周期、素材、标签和公开库存文案；发布前展示预览与字段校验。
- 库存：按 SKU/节点/机房查看可用、预占、已分配、维护；人工调整必须填写原因并保留前后值。
- 订单：按状态、用户、GPU、区域、时间筛选；详情展示不可变价格快照、支付/报价事件、交付状态和工单。
- 托管：展示主体、联系方式、设备清单、场地参数、附件状态和责任边界；每次推进写明下一步和责任方。
- 设备：按四个用户状态加维护/离线筛选；只展示真实监控摘要，允许创建维护事件和待用户处理事项。
- 内容：管理 Banner、资讯和服务入口；没有已发布内容时用户端隐藏对应区块。

管理员写操作使用二次确认，但确认框必须明确对象、当前状态、目标状态和影响，不使用笼统的“是否确认”。永久删除商品、订单、设备和审计记录不提供 UI；只允许归档或关闭。

---

## 7. 视觉设计系统

### 7.1 Token

所有新样式限定在 `.compute-app` 下，禁止污染现有 COD 全局选择器。

```css
.compute-app {
  --compute-accent: #177777;
  --compute-accent-hover: #0f6666;
  --compute-accent-soft: #e9f8f7;
  --compute-canvas: #f5f7f7;
  --compute-surface: #ffffff;
  --compute-surface-subtle: #f7fbfb;
  --compute-text: #172033;
  --compute-text-secondary: #5f6f72;
  --compute-border: #d9e4e4;
  --compute-success: #16835d;
  --compute-warning: #a56600;
  --compute-danger: #b42318;
  --compute-price: #e5484d;
  --compute-radius-card: 12px;
  --compute-radius-control: 8px;
  --compute-shadow-card: 0 2px 12px rgba(23, 119, 119, .08);
}
```

深色模式不是首版阻塞项，但若支持，必须复用 COD `data-color-mode` 并提供完整 token，不能反转图片或只改背景。

### 7.2 字体

- 复用 COD 的 `Work Sans + Noto Sans SC`，数字价格使用 `DM Mono` 或系统等宽数字。
- 页面标题 20/28、700；区块标题 17/24、700；卡片标题 16/22、600；正文 14/22；辅助 12/18。
- 不使用全大写英文眉题堆叠；“COD COMPUTE”最多出现在首页一次。

### 7.3 间距、尺寸与断点

- 基础间距只用 4、8、12、16、24、32、40px；卡片内边距 12–16px，区块间距 16–24px。
- 移动端输入框和主按钮高度至少 48px，普通点击目标至少 44 × 44px；宽屏控件可降到 40px。
- 顶部栏 52px；移动端底栏 56px 加安全区；吸附购买区内容高度不超过 76px。
- 断点：`<768px` 移动、`768–1179px` 平板/窄桌面、`>=1180px` 宽桌面。
- 文本、图标、边框和按钮需满足 WCAG AA；不能仅靠颜色表达库存、订单或设备状态。

### 7.4 图标与图片

- 继续使用项目已有 `@phosphor-icons/react`，统一 regular/duotone，不混入另一图标库。
- GPU 图片主对象占画面 76%–90%，透明或干净背景，WebP/AVIF，移动端单张建议小于 180KB。
- 每张商品图在 `apps/web/public/compute/assets-manifest.json` 登记来源、授权、作者/厂商和更新时间。
- 不提交奇点算力截图或 Logo 作为产品素材。

### 7.5 动效

- 页面转场 180ms；底部抽屉 220ms；按钮按下 `translateY(1px)`。
- 商品图片、价格和库存不做无限循环动画。
- 遵守 `prefers-reduced-motion`；骨架屏不使用高频闪烁。

---

## 8. 组件目录与职责

建议目录；同事应在这里完成绝大多数开发：

```text
apps/web/src/compute-market/
├── ComputeApp.tsx
├── compute-market.css
├── routes.ts
├── api.ts
├── types.ts                  # 仅 UI 派生类型，领域类型来自 contracts
├── capabilities.ts
├── pages/
│   ├── HomePage.tsx
│   ├── OffersPage.tsx
│   ├── OfferDetailPage.tsx
│   ├── CheckoutPage.tsx
│   ├── OrdersPage.tsx
│   ├── OrderDetailPage.tsx
│   ├── HostingPage.tsx
│   ├── HostingApplyPage.tsx
│   ├── DevicesPage.tsx
│   ├── DeviceDetailPage.tsx
│   ├── NewsPage.tsx
│   ├── RankingsPage.tsx
│   ├── ProfilePage.tsx
│   ├── AssetsPage.tsx
│   └── ReferralsPage.tsx
├── components/
│   ├── ComputeShell.tsx
│   ├── ComputeBottomNav.tsx
│   ├── ComputeSideNav.tsx
│   ├── OfferCard.tsx
│   ├── OfferFilters.tsx
│   ├── SpecGrid.tsx
│   ├── PriceBreakdown.tsx
│   ├── StatusTimeline.tsx
│   ├── DeviceStatusSummary.tsx
│   ├── EmptyState.tsx
│   └── ErrorState.tsx
├── hooks/
└── __tests__/

packages/contracts/src/compute-market-v2.ts
services/control-plane/src/compute-market-v2/
├── catalog.ts
├── orders.ts
├── hosting.ts
├── devices.ts
├── settlements.ts
└── validation.ts
```

组件约束：

- 页面组件不直接调用全局 `fetch`，统一经过本模块 `api.ts`。
- 金额和卡时格式化使用共享纯函数，禁止在 JSX 中散落除法和 `toFixed`。
- 所有 mutation 均接收 `AbortSignal` 和 idempotency key。
- 列表的 loading/empty/error/partial 状态由页面显式渲染。
- `App.tsx` 只负责 lazy mount、传入 session 和退出回调，不承载 V2 业务 JSX。

---

## 9. 领域模型

### 9.1 必须区分的两个“卡时”

- `resourceCardHoursMilli`：真实 GPU 使用量，`GPU 卡数 × 小时 × 1000`。
- `creditCardHoursMilli`：COD 账户额度。换算固定为 `1 COD 卡时 = ¥1.002`。

两者名称、字段和账本不能混用。例如 H100 的真实资源单价可以是 ¥18.80/卡时，这不代表一份 COD 额度卡时能购买一份 H100 资源卡时。

金额计算使用整数：

- 人民币存 `amountCnyMilli`（千分之一元）。
- `1 COD 卡时 = 1002 amountCnyMilli`。
- 抵扣所需 `creditCardHoursMilli = ceil(amountCnyMilli × 1000 / 1002)`。
- 最终展示人民币保留两位；服务端决定舍入，客户端不得自行修改订单金额。

### 9.2 核心实体

```ts
type ComputePurchaseMode = 'instant' | 'reservation' | 'quote';
type ComputeOfferStatus = 'draft' | 'published' | 'paused' | 'sold_out' | 'archived';
type ComputeOrderStatus =
  | 'draft' | 'reserved' | 'pending_quote' | 'quoted'
  | 'pending_payment' | 'paid' | 'provisioning' | 'running'
  | 'action_required' | 'completed' | 'cancelled'
  | 'refund_pending' | 'refunded';
type HostingApplicationStatus =
  | 'draft' | 'submitted' | 'reviewing' | 'site_survey'
  | 'quoted' | 'contract_pending' | 'inbound_pending'
  | 'deploying' | 'running' | 'action_required'
  | 'offboarding' | 'completed' | 'rejected' | 'cancelled';
type HostedDeviceStatus =
  | 'pending_review' | 'deploying' | 'running'
  | 'action_required' | 'maintenance' | 'offline' | 'retired';

interface ComputeOfferV2 {
  id: string;
  slug: string;
  title: string;
  status: ComputeOfferStatus;
  purchaseMode: ComputePurchaseMode;
  providerName: string;
  regionLabel: string;
  gpu: { model: string; memoryGb: number; countPerUnit: number };
  specs: ComputeHardwareSpecs;
  tags: string[];
  media: Array<{ id: string; url: string; alt: string }>;
  skus: ComputeSkuV2[];
  availability: { level: 'ready' | 'limited' | 'sold_out' | 'quote'; label: string };
  updatedAt: string;
}

interface ComputeSkuV2 {
  id: string;
  offerId: string;
  deliveryMode: 'container' | 'virtual_machine' | 'bare_metal';
  period: 'hour' | 'day' | 'month';
  minimumUnits: number;
  maximumUnits: number | null;
  priceCnyMilli: number | null;
  compareAtPriceCnyMilli: number | null;
  imageOptions: ComputeImageOption[];
  inventoryRevision: number;
}

interface ComputeQuoteV2 {
  amountCnyMilli: number;
  creditCardHoursMilli: number;
  validUntil: string;
  termsVersion: string;
  terms: string;
  createdAt: string;
}

interface ComputeOrderV2 {
  id: string;
  userId: string;
  skuSnapshot: Record<string, unknown>;
  quantity: number;
  durationUnits: number;
  resourceCardHoursMilli: number;
  subtotalCnyMilli: number;
  discountCnyMilli: number;
  totalCnyMilli: number;
  creditCardHoursMilli: number;
  status: ComputeOrderStatus;
  reservationExpiresAt: string | null;
  quote: ComputeQuoteV2 | null;
  createdAt: string;
  updatedAt: string;
}
```

其他实体：`InventoryPool`、`InventoryReservation`、`HostingApplication`、`HostedDevice`、`ComputeTicket`、`ComputeSettlement`、`ComputeCoupon`、`ReferralRecord`、`ComputeContentEntry`。每个状态变化必须追加事件，不靠覆盖一列状态解释历史。

---

## 10. API 契约

新功能统一在 `/api/compute/v2`，V1 接口在迁移期保持只读/兼容，不直接改响应结构。

### 10.1 公开/用户 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/compute/v2/capabilities` | 返回可见模块和即时购买/排行/结算等开关 |
| GET | `/api/compute/v2/home` | Banner、快捷入口、热门商品和内容摘要 |
| GET | `/api/compute/v2/offers` | 游标分页与筛选，不返回精确库存 |
| GET | `/api/compute/v2/offers/:id` | 商品、SKU、镜像和可售状态 |
| POST | `/api/compute/v2/reservations` | 原子预占库存，必须幂等 |
| POST | `/api/compute/v2/orders` | 创建订单/询价，服务端重算金额 |
| GET | `/api/compute/v2/orders` | 仅本人订单 |
| GET | `/api/compute/v2/orders/:id` | 仅本人详情 |
| PATCH | `/api/compute/v2/orders/:id/quote-decision` | 本人接受/拒绝有效报价 |
| POST | `/api/compute/v2/orders/:id/cancel` | 按状态允许取消 |
| GET/POST | `/api/compute/v2/hosting/applications` | 本人托管申请列表/创建 |
| GET/PATCH | `/api/compute/v2/hosting/applications/:id` | 本人详情/草稿更新 |
| GET | `/api/compute/v2/devices` | 本人设备与状态汇总 |
| GET | `/api/compute/v2/devices/:id` | 本人设备详情 |
| POST | `/api/compute/v2/devices/:id/tickets` | 创建本人设备工单 |
| GET | `/api/compute/v2/assets/summary` | 钱包、卡时和已开放结算摘要 |
| GET | `/api/compute/v2/assets/ledger` | 游标分页明细 |
| GET | `/api/compute/v2/referrals` | 邀请码、规则和记录 |
| GET | `/api/compute/v2/news` | 已发布资讯 |
| GET | `/api/compute/v2/rankings` | capability 开启时返回匿名排行 |

### 10.2 管理 API

统一前缀 `/api/admin/compute/v2`，资源包括 `offers`、`skus`、`inventory`、`orders`、`hosting-applications`、`devices`、`tickets`、`settlements`、`content`。所有写操作要求：

- 管理员权限。
- `expectedRevision` 或 `If-Match` 乐观并发控制。
- idempotency key。
- 操作原因；高风险操作原因不得为空。
- 写入不含秘密和完整个人信息的审计摘要。

### 10.3 通用响应与错误

```ts
interface ApiPage<T> { items: T[]; nextCursor: string | null }
interface ApiError {
  error: string;
  code: string;
  requestId: string;
  fieldErrors?: Record<string, string>;
  retryable?: boolean;
}
```

前端根据稳定 `code` 映射中文文案，不显示原始数据库、支付方或供应商错误。

---

## 11. 状态机

### 11.1 租赁订单

```text
即时：draft -> reserved -> pending_payment -> paid -> provisioning -> running -> completed
询价：draft -> pending_quote -> quoted --用户接受--> pending_payment -> paid -> provisioning
                                      \--用户拒绝----------------------------> cancelled
异常：paid/provisioning/running -> action_required -> 原状态或 cancelled/refund_pending
退款：paid/provisioning -> refund_pending -> refunded
```

- 库存预占有明确过期时间，过期释放由服务端任务处理。
- 管理员不能代用户接受报价。
- `running` 必须有真实交付事件；不能只靠管理员手点。
- 支付成功、退款成功以服务端签名回调和幂等处理为准。

### 11.2 托管申请与设备

```text
draft -> submitted -> reviewing -> site_survey -> quoted -> contract_pending
      -> inbound_pending -> deploying -> running -> action_required -> running
      -> offboarding -> completed

reviewing/site_survey/quoted -> rejected 或 cancelled
```

- 申请与设备是两个实体；完成验收后才创建 `HostedDevice`。
- `running` 设备才计入“我的设备/运行中”和资产汇总。
- 异常需包含用户可执行的下一步、责任方和 SLA 时间，不只显示红色状态。

---

## 12. 加载、空、错误、离线与权限状态

每个列表/详情必须完成以下状态：

- 首次加载：与最终卡片同形的骨架屏，不使用全屏转圈。
- 刷新：保留旧数据并显示局部刷新状态。
- 空数据：说明为何为空，并给唯一主操作。
- 无筛选结果：显示当前条件与“清除筛选”。
- 部分失败：首页某个区块失败不拖垮整页。
- 断网：保留最后成功的公开商品缓存并标注“离线数据”；禁止下单和提交。
- 401：记录当前 URL，登录成功后恢复；表单草稿保留。
- 403：明确无权限，不伪装 404；涉及跨用户资源时服务端仍可按安全策略返回 404。
- 409：提示数据已变化并刷新价格/状态，不能自动覆盖。
- 库存变化：确认页重新报价，让用户明确确认新金额。

---

## 13. 安全、隐私与合规

- 订单、设备、申请、附件和地址均校验 tenant + owner，不能依赖前端过滤。
- 联系方式在管理员列表脱敏；复制完整联系方式属于审计事件。
- 产权证明、合同和身份证明使用私有对象存储、短期签名 URL、类型/大小校验与恶意文件扫描。
- 商品富文本、资讯和运营配置服务端清洗，禁止任意 HTML/脚本。
- 即时购买、支付、退款、优惠券、邀请奖励均需服务端幂等。
- 精确库存、机房地址、设备序列号、登录凭据不进入公开响应、分析事件和客户端日志。
- 排行榜默认匿名且允许用户退出。
- 第三方托管必须展示合同主体、设备保管、保险、SLA、赔付、结算和退场边界。
- 融资/分期不作为 V2 顶级入口；只有具备合规合作方与完整披露后由 capability 开启。

---

## 14. 数据分析事件

事件名使用 `compute.v2.*`：

- `module_opened`、`offer_impression`、`offer_opened`、`filter_applied`。
- `checkout_started`、`reservation_created`、`order_created`、`quote_decided`。
- `hosting_started`、`hosting_draft_saved`、`hosting_submitted`。
- `device_opened`、`ticket_created`、`referral_shared`。

属性只包含商品 ID、SKU ID、状态、入口、筛选枚举和耗时；不发送姓名、电话、地址、设备序列号、合同正文或任意自由文本。

关键漏斗：商品曝光 → 详情 → 结算 → 订单；托管首页 → 开始申请 → 提交 → 审核通过 → 运行。业务指标必须区分即时购买和人工询价。

---

## 15. V1 迁移策略

当前 V1 的 `/api/compute/offers` 与 `/api/compute/requests` 保留，直到 V2 完成数据迁移和全端回归。

映射规则：

- `rental` 请求迁移为 `purchaseMode=quote` 的 V2 询价订单。
- `hosting` 请求迁移为托管申请。
- `supply` 请求迁移为算力入驻申请，不直接生成设备。
- `installment` 保留为历史咨询；未有合规能力时不出现在 V2 导航。
- V1 `approved/deploying/running/completed` 可映射到 V2 事件时间线；无法证明的字段标为 `source:legacy`，不得伪造验收/支付事件。
- 迁移脚本必须可重复执行、输出数量校验和冲突报告，不删除 V1 原始数据。

切换顺序：

1. V2 API 与管理端在 capability 后上线。
2. 内测账号进入 V2；普通用户仍使用 V1。
3. 校验订单/申请数量和权限后扩大灰度。
4. 全量切换入口；V1 只读 30 天。
5. 确认无回滚需求后再移除 V1 UI，数据长期保留。

---

## 16. 同事开发与低冲突合并契约

### 16.1 分支

- 从最新目标分支创建 `feature/compute-market-v2`。
- 不在同事分支混入聊天、桌宠、认证、任务板或部署修改。
- 每个提交只做一层：contracts → API/存储 → 用户 UI → 管理 UI → 接线/迁移。

### 16.2 文件所有权

同事可独立修改：

- `apps/web/src/compute-market/**`
- `services/control-plane/src/compute-market-v2/**`
- `packages/contracts/src/compute-market-v2.ts`
- `apps/web/public/compute/**`
- 对应测试和本规范

需要合并负责人协调的热点文件：

- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/api.ts`
- `services/control-plane/src/server.ts`
- `services/control-plane/src/database.ts`
- `packages/contracts/src/index.ts`

热点文件原则上只接受 import、route mount、接口注册或一行 re-export。若同事需要在热点文件写大量业务代码，应先拆回模块目录。

### 16.3 推荐接线接口

```ts
interface ComputeAppProps {
  session: { token: string; account: AccountSummary } | null;
  initialPath: string;
  platform: 'web' | 'desktop' | 'mobile';
  onRequireLogin(returnTo: string): void;
  onExit(): void;
  onOpenCodTask?(input: { title: string; prompt: string }): void;
}
```

COD 工作区与算力模块只通过这个边界通信。算力模块不得读取任务页面的内部 React state。

### 16.4 推荐提交顺序

1. `feat(contracts): add compute market v2 contracts`
2. `feat(control-plane): add compute catalog and order APIs`
3. `feat(control-plane): add hosting device lifecycle`
4. `feat(web): add compute market v2 shell and catalog`
5. `feat(web): add checkout orders and assets`
6. `feat(web): add hosting devices and profile`
7. `feat(admin): add compute operations console`
8. `test(compute): cover permissions lifecycle and responsive flows`
9. `feat(app): connect compute market v2 behind capability`

避免一个几万行提交，便于逐层审计和回滚。

### 16.5 开发里程碑

| 里程碑 | 可见结果 | 合并门槛 |
| --- | --- | --- |
| M0 基础 | contracts、迁移骨架、capability、空路由壳 | 类型检查、跨租户测试、无生产入口 |
| M1 商品 | 首页、筛选、商品卡、商品详情、管理商品/库存 | 参考结构对齐；真实 API；五端浏览通过 |
| M2 交易 | 预占/询价、订单、报价确认、资产扣减、管理订单 | 幂等、并发库存、金额换算、权限与回滚通过 |
| M3 托管 | 四步申请、申请详情、设备四状态、管理托管/设备 | 申请与设备分离；附件安全；完整状态机通过 |
| M4 个人中心 | 我的、资产、邀请、服务入口、资讯/排行 capability | 无空壳入口；隐私与匿名规则通过 |
| M5 切换 | V1 数据迁移、灰度、五端回归、旧弹窗只读/下线 | 数量对账、可回滚、CI 与手测矩阵通过 |

M1 可以先供内部浏览，但不得以“算力市场已完成”对外发布；至少完成 M3 和相应管理端闭环才具备首版产品完整性。

---

## 17. 测试与验收

### 17.1 自动化最低要求

- 领域校验、金额/卡时换算、状态机和幂等单元测试。
- 用户归属、管理员权限、跨租户、报价过期、库存竞争和重复回调 API 测试。
- 商品列表/详情/筛选/确认订单/托管表单/设备状态组件测试。
- V1 → V2 迁移测试；重复运行结果一致。
- axe 或等价无障碍检查；关键页面无严重问题。

### 17.2 五端手动矩阵

| 场景 | Web | macOS | Windows | Android | iOS |
| --- | --- | --- | --- | --- | --- |
| 游客浏览与筛选 | 必测 | 必测 | 必测 | 必测 | 必测 |
| 登录后恢复当前详情/表单 | 必测 | 必测 | 必测 | 必测 | 必测 |
| 商品详情选择镜像/周期/数量 | 必测 | 必测 | 必测 | 必测 | 必测 |
| 下单/询价防重复提交 | 必测 | 必测 | 必测 | 必测 | 必测 |
| 托管四步表单与草稿 | 必测 | 必测 | 必测 | 必测 | 必测 |
| 我的设备四状态 | 必测 | 必测 | 必测 | 必测 | 必测 |
| 刷新、返回、冷启动、断网 | 必测 | 必测 | 必测 | 必测 | 必测 |
| 管理端完整处理 | 必测 | 必测 | 必测 | 响应式只读检查 | 响应式只读检查 |

移动端至少覆盖 360 × 800、390 × 844、430 × 932；桌面覆盖 1280 × 720、1440 × 900、1920 × 1080。检查 200% 文本缩放、键盘操作、深色模式（若开放）和安全区。

### 17.3 产品验收清单

- [ ] 算力市场不再以 Modal 作为最终容器。
- [ ] 五栏结构、商品卡、详情和“我的”与参考信息架构逐项对应。
- [ ] 所有可见入口都有完整页面和可回退路径。
- [ ] 商品、价格、库存、排行和设备状态均来自 API。
- [ ] 即时购买能力不完整时自动降级为询价，而不是假购买。
- [ ] 生成订单前服务端重算价格并验证库存 revision。
- [ ] 普通用户无法读取/修改他人订单、申请、设备和资产。
- [ ] 管理员不能代用户接受报价。
- [ ] 设备只有验收后才进入“我的设备/资产”。
- [ ] `resourceCardHoursMilli` 与 `creditCardHoursMilli` 未混用。
- [ ] 1 COD 卡时 = ¥1.002 的换算只有一个共享实现。
- [ ] 旧 V1 数据可查看，迁移可重复、可审计、可回滚。
- [ ] Android/iOS 返回、键盘、刷新和冷启动通过。
- [ ] 商品素材有来源与授权记录。
- [ ] CI 的 typecheck、lint、test、build 和安全审计全部通过。

---

## 18. 交付定义（Definition of Done）

模块只有同时满足以下条件才算“做完”：

1. 用户可以完成浏览 → 详情 → 下单/询价 → 确认 → 查看订单的闭环。
2. 设备方可以完成申请 → 审核 → 部署 → 查看运行/异常 → 发起工单或退场的闭环。
3. 管理员能处理每个用户可见状态，且每次高风险变更可审计。
4. 钱包、COD 卡时、资源用量、人民币金额和托管结算口径互不混淆。
5. 所有可见数据都是真实后端数据；未接入能力被隐藏或诚实降级。
6. 五端完成自动化与手动验收，旧算力弹窗可安全下线。

---

## 19. 参考依据

- 用户提供的三张奇点算力界面参考：热门算力卡列表、商品详情、“我的/资产/设备”页。
- 奇点算力公开 App Store 页面说明其核心范围包括 GPU 算力租赁、设备托管和云端运维：<https://apps.apple.com/cn/app/id6758072405>
- COD 当前 V1 业务与责任边界：[COMPUTE_MARKET_LIFECYCLE.md](./COMPUTE_MARKET_LIFECYCLE.md)
- 当前实现入口：`apps/web/src/App.tsx` 的 `ComputeMarket`，仅作为迁移来源，不作为 V2 组件基础。

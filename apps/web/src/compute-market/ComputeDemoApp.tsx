import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft } from "@phosphor-icons/react/ArrowLeft";
import { Bell } from "@phosphor-icons/react/Bell";
import { Buildings } from "@phosphor-icons/react/Buildings";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { ChartBar } from "@phosphor-icons/react/ChartBar";
import { Check } from "@phosphor-icons/react/Check";
import { Clock } from "@phosphor-icons/react/Clock";
import { Cpu } from "@phosphor-icons/react/Cpu";
import { HardDrives } from "@phosphor-icons/react/HardDrives";
import { Headset } from "@phosphor-icons/react/Headset";
import { House } from "@phosphor-icons/react/House";
import { Lightning } from "@phosphor-icons/react/Lightning";
import { MapPin } from "@phosphor-icons/react/MapPin";
import { Newspaper } from "@phosphor-icons/react/Newspaper";
import { Package } from "@phosphor-icons/react/Package";
import { Ranking } from "@phosphor-icons/react/Ranking";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { SlidersHorizontal } from "@phosphor-icons/react/SlidersHorizontal";
import { UserCircle } from "@phosphor-icons/react/UserCircle";
import { Wallet } from "@phosphor-icons/react/Wallet";
import { Wrench } from "@phosphor-icons/react/Wrench";
import { X } from "@phosphor-icons/react/X";
import type { CodSession, ComputeOffer } from "../api";
import {
  computeDemoNews,
  computeOperationsDemo,
  computeDemoProducts,
  computeDemoRanking,
  type ComputeDemoProduct,
} from "./compute-demo-data";
import "./compute-demo.css";

type ComputeTab = "home" | "hosting" | "news" | "ranking" | "mine";
type MineResourceView = "orders" | "devices" | "hosting" | "assets" | "verification" | "support" | "help" | "purchase" | "ledger";
type MineOrderStatus = "all" | "pending" | "running" | "delivery" | "completed";

const mineResourceViews = new Set<MineResourceView>(["orders", "devices", "hosting", "assets", "verification", "support", "help", "purchase", "ledger"]);
const mineOrderStatuses = new Set<MineOrderStatus>(["all", "pending", "running", "delivery", "completed"]);

export interface ComputeMarketAppProps {
  session: CodSession | null;
  balanceCardHours: string | null;
  initialPath: string;
  platform: "web" | "desktop" | "mobile";
  offers?: ComputeOffer[];
  onRequireLogin(returnTo: string): void;
  onOpenAccount?(): void;
  onOpenSupport?(): void;
  onExit(): void;
}

interface MarketOrder {
  id: string;
  status: Exclude<MineOrderStatus, "all">;
  resource: string;
  meta: string;
  amount: string;
  label: string;
}
const navItems: Array<{
  id: ComputeTab;
  label: string;
  icon: typeof House;
}> = [
  { id: "home", label: "首页", icon: House },
  { id: "hosting", label: "设备托管", icon: Buildings },
  { id: "news", label: "资讯", icon: Newspaper },
  { id: "ranking", label: "排行榜", icon: Ranking },
  { id: "mine", label: "我的资源", icon: UserCircle },
];

function readComputeRoute(path: string) {
  const url = new URL(path, window.location.origin);
  const tab = url.searchParams.get("tab") as ComputeTab | null;
  const view = url.searchParams.get("view");
  const orderStatus = url.searchParams.get("status") as MineOrderStatus | null;
  return {
    tab: navItems.some((item) => item.id === tab) ? (tab as ComputeTab) : "home",
    productId: url.searchParams.get("offer"),
    operations: view === "operations",
    mineView: mineResourceViews.has(view as MineResourceView) ? (view as MineResourceView) : null,
    orderStatus: mineOrderStatuses.has(orderStatus as MineOrderStatus) ? (orderStatus as MineOrderStatus) : "all",
  };
}

function toDemoProduct(offer: ComputeOffer, index: number): ComputeDemoProduct {
  const fallback = computeDemoProducts[index % computeDemoProducts.length];
  return {
    ...fallback,
    id: offer.id,
    title: offer.title,
    gpuModel: offer.gpuModel,
    gpuMemory: `${offer.gpuMemoryGb}GB 显存`,
    price:
      offer.priceCents == null
        ? fallback.price
        : Number((offer.priceCents / 100).toFixed(1)),
    badge:
      offer.availability === "ready"
        ? "可立即交付"
        : offer.availability === "limited"
          ? "库存紧张"
          : "价格已公开",
    region: offer.region,
    availability:
      offer.inventoryCards == null
        ? offer.delivery
        : `现货 ${offer.inventoryCards} 卡 · ${offer.delivery}`,
    tags: offer.tags.length ? offer.tags.slice(0, 3) : fallback.tags,
    specs: offer.specs
      ? {
          cpu: `${offer.specs.cpuModel} · ${offer.specs.cpuCores} 核`,
          memory: `${offer.specs.memoryGb}GB`,
          system: "Ubuntu 22.04",
          cuda: `CUDA ${offer.specs.cudaMaxVersion}`,
        }
      : fallback.specs,
    images: offer.images?.length
      ? offer.images.map((image) => ({
          id: image.id,
          name: image.name,
          detail: `Python ${image.pythonVersion} · CUDA ${image.cudaVersion}`,
        }))
      : fallback.images,
  };
}

function SectionTitle({
  title,
  description,
  action,
  onAction,
}: {
  title: string;
  description?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <header className="compute-v2-section-title">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action && onAction && (
        <button type="button" onClick={onAction}>
          {action} <CaretRight />
        </button>
      )}
    </header>
  );
}

function MarketModal({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="compute-v2-modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="compute-v2-modal" role="dialog" aria-modal="true" aria-labelledby="compute-modal-title">
        <header>
          <div>
            <h2 id="compute-modal-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label={`关闭${title}`}><X /></button>
        </header>
        <div className="compute-v2-modal-body">{children}</div>
      </section>
    </div>
  );
}

function RecordDetail({ title, meta, value }: MineResourceRow) {
  return (
    <div className="compute-v2-record-detail">
      <dl>
        <div><dt>项目</dt><dd>{title}</dd></div>
        <div><dt>详细信息</dt><dd>{meta}</dd></div>
        <div><dt>当前状态</dt><dd>{value}</dd></div>
      </dl>
      <p>如需变更配置或补充资料，可通过专属客服继续跟进。</p>
    </div>
  );
}

function ProductCard({
  product,
  onOpen,
}: {
  product: ComputeDemoProduct;
  onOpen: () => void;
}) {
  return (
    <article className="compute-v2-product-card">
      <button
        className={`compute-v2-product-image ${product.imageTone}`}
        type="button"
        onClick={onOpen}
        aria-label={`查看 ${product.title}`}
      >
        <img src={product.image} alt="" />
        <span>{product.badge}</span>
      </button>
      <div className="compute-v2-product-body">
        <header>
          <div>
            <h3>{product.gpuModel}</h3>
            <p>{product.gpuMemory}</p>
          </div>
          <strong>
            {product.price.toFixed(1)} <small>参考卡时/小时</small>
          </strong>
        </header>
        <div className="compute-v2-tags">
          {product.tags.map((tag) => <span key={tag}>{tag}</span>)}
        </div>
        <dl className="compute-v2-spec-grid">
          <div><dt>CPU</dt><dd>{product.specs.cpu}</dd></div>
          <div><dt>内存</dt><dd>{product.specs.memory}</dd></div>
          <div><dt>系统</dt><dd>{product.specs.system}</dd></div>
          <div><dt>环境</dt><dd>{product.specs.cuda}</dd></div>
        </dl>
        <footer>
          <span><MapPin /> {product.region}</span>
          <button type="button" onClick={onOpen}>查看详情 <CaretRight /></button>
        </footer>
        <p className="compute-v2-availability"><i />{product.availability}</p>
      </div>
    </article>
  );
}

function HomePage({
  session,
  balanceCardHours,
  products,
  onOpenProduct,
  onNavigate,
  onOpenOperations,
  onOpenResource,
  onRequireLogin,
}: {
  session: CodSession | null;
  balanceCardHours: string | null;
  products: ComputeDemoProduct[];
  onOpenProduct: (id: string) => void;
  onNavigate: (tab: ComputeTab) => void;
  onOpenOperations: () => void;
  onOpenResource: (view: MineResourceView, status?: MineOrderStatus) => void;
  onRequireLogin: () => void;
}) {
  const [filter, setFilter] = useState("全部");
  const filters = ["全部", "B300", "H200", "H100", "L40S", "消费级"];
  const visibleProducts = products.filter((product) => {
    if (filter === "全部") return true;
    if (filter === "消费级") return product.gpuModel.includes("4090") || product.gpuModel.includes("5090");
    return product.gpuModel.includes(filter);
  });
  const quickEntries = [
    { label: "找算力", detail: "按模型筛选", icon: Cpu, action: () => document.getElementById("compute-products")?.scrollIntoView({ behavior: "smooth" }) },
    { label: "托管设备", detail: "接入资源池", icon: Buildings, action: () => onNavigate("hosting") },
    { label: "我的订单", detail: "跟进交付", icon: Package, action: () => onOpenResource("orders", "all") },
    { label: "经营看板", detail: "查看公开数据", icon: ChartBar, action: onOpenOperations },
  ];
  return (
    <>
      <section className="compute-v2-hero">
        <div>
          <span>COD COMPUTE</span>
          <h1>让每一次训练，都用上合适的算力</h1>
          <p>覆盖训练、推理与图形创作场景，按卡时灵活配置。</p>
          <div className="compute-v2-region-list">
            <span>华北</span><span>华东</span><span>西南</span><span>华南</span>
          </div>
        </div>
        <img src="/compute/gpu-h200.svg" alt="H200 算力卡产品图" />
      </section>

      <section className="compute-v2-notices" aria-label="账户提醒">
        {session ? <button type="button" onClick={() => onOpenResource("assets")}><Wallet /><div><small>可用卡时</small><strong>{balanceCardHours}</strong><span>账户余额与权益已同步</span></div><CaretRight /></button> : <button type="button" onClick={onRequireLogin}><Wallet /><div><small>新用户注册权益</small><strong>注册后领取</strong><span>登录后显示卡时余额与明细</span></div><CaretRight /></button>}
        <button type="button" onClick={() => onOpenResource("orders", "running")}><Clock /><div><small>运行中的订单</small><strong>3 个实例</strong><span>今日预计消耗 82.4 卡时</span></div><CaretRight /></button>
      </section>

      <section className="compute-v2-quick" aria-label="快捷入口">
        {quickEntries.map((entry) => {
          const Icon = entry.icon;
          return <button type="button" onClick={entry.action} key={entry.label}><i><Icon /></i><strong>{entry.label}</strong><small>{entry.detail}</small></button>;
        })}
      </section>

      <section className="compute-v2-catalog" id="compute-products">
        <SectionTitle title="热门算力卡" description="参考公开云平台行情换算的市场卡时价" action="全部资源" onAction={() => setFilter("全部")} />
        <div className="compute-v2-filters" aria-label="筛选算力卡">
          <SlidersHorizontal />
          {filters.map((item) => <button type="button" className={filter === item ? "active" : ""} onClick={() => setFilter(item)} key={item}>{item}</button>)}
        </div>
        <div className="compute-v2-product-list">
          {visibleProducts.map((product) => <ProductCard product={product} onOpen={() => onOpenProduct(product.id)} key={product.id} />)}
        </div>
      </section>
    </>
  );
}

function HostingPage({
  session,
  onRequireLogin,
  onOpenResource,
}: {
  session: CodSession | null;
  onRequireLogin: () => void;
  onOpenResource: (view: MineResourceView) => void;
}) {
  const [dialog, setDialog] = useState<"apply" | "plan" | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const submitApplication = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) {
      onRequireLogin();
      return;
    }
    setSubmitted(true);
  };
  return (
    <div className="compute-v2-page-stack">
      <section className="compute-v2-page-banner hosting">
        <div><span>设备托管</span><h1>闲置设备，接入 COD 算力资源池</h1><p>标准化验收、运行监控与收益结算，托管状态随时可查。</p><button type="button" onClick={() => { setSubmitted(false); setDialog("apply"); }}>开始托管申请</button></div>
        <Buildings />
      </section>
      <section className="compute-v2-status-grid">
        <article><small>已托管设备</small><strong>12</strong><span>8 台运行中</span></article>
        <article><small>本月预计卡时</small><strong>6,840</strong><span>较上月 +12.6%</span></article>
        <article><small>待处理事项</small><strong>2</strong><span>1 台待验收</span></article>
        <article><small>在线率</small><strong>99.6%</strong><span>近 30 日</span></article>
      </section>
      <section className="compute-v2-host-card">
        <img src="/compute/gpu-h200.svg" alt="H200 托管设备产品图" />
        <div><span>重点资源计划</span><h2>H200 / H100 设备托管</h2><p>支持整机、机柜级接入；验收通过后进入资源池，运行数据和结算记录全程可追踪。</p><ul><li><Check /> 设备信息核验</li><li><Check /> 机房环境验收</li><li><Check /> 上线与持续监控</li></ul><button type="button" onClick={() => setDialog("plan")}>查看托管方案 <CaretRight /></button></div>
      </section>
      <section className="compute-v2-process"><SectionTitle title="托管流程" description="四步完成设备接入" /><ol><li><b>01</b><strong>提交资料</strong><span>设备、机房和网络信息</span></li><li><b>02</b><strong>方案评估</strong><span>核验卡况与交付条件</span></li><li><b>03</b><strong>验收接入</strong><span>完成联调并进入资源池</span></li><li><b>04</b><strong>运行结算</strong><span>查看状态与卡时收益</span></li></ol></section>
      {dialog === "plan" && <MarketModal title="设备托管方案" description="从设备核验到收益结算的完整接入方案" onClose={() => setDialog(null)}><div className="compute-v2-plan-grid"><article><strong>整机托管</strong><p>适合 4–8 卡服务器，提供上架、网络联调、监控和故障响应。</p><span>预计 3–5 个工作日接入</span></article><article><strong>集群托管</strong><p>适合 16 卡以上资源池，支持专属网络、调度策略和批量运维。</p><span>预计 5–10 个工作日接入</span></article><article><strong>联合运营</strong><p>按实际运行卡时结算，经营数据、设备状态和收益明细可追踪。</p><span>按月生成结算单</span></article></div><div className="compute-v2-modal-actions"><button type="button" className="secondary" onClick={() => setDialog(null)}>稍后再看</button><button type="button" onClick={() => { setSubmitted(false); setDialog("apply"); }}>提交托管申请</button></div></MarketModal>}
      {dialog === "apply" && <MarketModal title={submitted ? "申请已提交" : "提交托管申请"} description={submitted ? "我们会在 1 个工作日内联系并确认接入条件" : "填写设备和机房信息，获取可执行的接入方案"} onClose={() => setDialog(null)}>{submitted ? <div className="compute-v2-success"><i><Check /></i><h3>托管申请已进入资料核验</h3><p>申请编号 HT-0814-026，可在“我的资源—托管申请”查看后续进度。</p><div className="compute-v2-modal-actions"><button type="button" className="secondary" onClick={() => setDialog(null)}>完成</button><button type="button" onClick={() => { setDialog(null); onOpenResource("hosting"); }}>查看申请进度</button></div></div> : <form className="compute-v2-form" onSubmit={submitApplication}><label><span>联系人</span><input name="contact" required placeholder="请输入联系人姓名" defaultValue={session?.account.displayName ?? ""} /></label><label><span>联系电话</span><input name="phone" required inputMode="tel" pattern="1[3-9][0-9]{9}" placeholder="请输入 11 位手机号" /></label><label><span>设备型号</span><select name="model" defaultValue="H200"><option>H200</option><option>H100</option><option>L40S</option><option>RTX 5090</option><option>RTX 4090</option><option>其他型号</option></select></label><label><span>GPU 数量</span><input name="quantity" required min="1" max="512" type="number" defaultValue="8" /></label><label className="wide"><span>设备所在城市</span><input name="city" required placeholder="例如：成都" /></label><label className="wide"><span>补充说明</span><textarea name="note" rows={3} placeholder="可填写机房、网络、期望接入时间等信息" /></label><div className="compute-v2-modal-actions wide"><button type="button" className="secondary" onClick={() => setDialog(null)}>取消</button><button type="submit">提交申请</button></div></form>}</MarketModal>}
    </div>
  );
}

const newsDetails = [
  ["需求判断", "先确认任务是训练、推理还是图形生成，再用显存容量、并行规模和运行时长反推资源。", "交付建议", "生产任务优先选择库存明确、网络和镜像已验证的资源池。"],
  ["成本拆解", "卡时费用之外，还要关注镜像准备、数据传输和闲置等待时间。", "优化建议", "短任务按小时、稳定任务按日、持续服务按月配置更容易控制预算。"],
  ["环境准备", "提前确定 CUDA、框架版本、模型权重和数据位置，可显著缩短部署时间。", "验收建议", "首轮运行先完成显存、通信、磁盘和网络四项检查。"],
  ["场景拆解", "渲染任务适合按队列切分并行执行，优先选择显存充足、镜像成熟的消费级 GPU。", "效率建议", "把素材同步、插件校验和批量任务编排前置，可减少资源等待和空转。"],
];

function NewsPage() {
  const [selected, setSelected] = useState<number | null>(null);
  const item = selected == null ? null : computeDemoNews[selected];
  return <div className="compute-v2-page-stack"><section className="compute-v2-page-banner news"><div><span>算力资讯</span><h1>看懂算力供需，做出更稳的资源决策</h1><p>产品动态、行业观察与技术实践，每周持续更新。</p></div><Newspaper /></section><section className="compute-v2-news"><SectionTitle title="最新内容" description="算力资源与交付实践" />{computeDemoNews.map((news, index) => <button type="button" className="compute-v2-news-item" onClick={() => setSelected(index)} key={news.title}><div className={`compute-v2-news-cover cover-${index + 1}`}><span>{news.category}</span><ChartBar /></div><div><span>{news.category} · {news.date}</span><h2>{news.title}</h2><p>聚焦真实业务场景，拆解资源选择、交付与成本控制中的关键问题。</p><small>{news.read}阅读 <CaretRight /></small></div></button>)}</section>{item && <MarketModal title={item.title} description={`${item.category} · ${item.date} · ${item.read}阅读`} onClose={() => setSelected(null)}><div className="compute-v2-article-detail"><p>算力资源的选择不只取决于单卡性能，还需要把业务类型、交付周期、运行环境和总成本放到同一张表里判断。</p><dl>{newsDetails[selected ?? 0].map((text, index) => index % 2 === 0 ? <dt key={text}>{text}</dt> : <dd key={text}>{text}</dd>)}</dl><p>COD 算力市场已把公开价格、交付状态和资源规格集中展示，可从首页直接筛选并配置订单。</p></div><div className="compute-v2-modal-actions"><button type="button" onClick={() => setSelected(null)}>返回资讯列表</button></div></MarketModal>}</div>;
}

function RankingPage({ onOpenProducts }: { onOpenProducts: () => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const item = selected == null ? null : computeDemoRanking[selected];
  return <div className="compute-v2-page-stack"><section className="compute-v2-page-banner ranking"><div><span>资源排行榜</span><h1>按稳定性与交付表现发现优质资源</h1><p>综合资源可用率、交付速度与服务质量，帮助用户快速比较资源池。</p></div><Ranking /></section><section className="compute-v2-ranking"><SectionTitle title="本周资源榜" description="综合可用率、交付速度与服务评分" /><div className="compute-v2-ranking-head"><span>排名 / 资源池</span><span>可用率</span><span>综合分</span></div>{computeDemoRanking.map((rank, index) => <button type="button" className="compute-v2-ranking-row" onClick={() => setSelected(index)} key={rank.rank}><b>{rank.rank}</b><div><strong>{rank.name}</strong><small>{rank.model}</small></div><span>{rank.availability}</span><em>{rank.score}</em></button>)}</section>{item && <MarketModal title={item.name} description={`${item.model} · 本周综合排名第 ${item.rank}`} onClose={() => setSelected(null)}><div className="compute-v2-ranking-detail"><div><small>资源可用率</small><strong>{item.availability}</strong></div><div><small>综合评分</small><strong>{item.score}</strong></div><div><small>平均交付</small><strong>{Number(item.rank) <= 2 ? "2.8 小时" : "4.2 小时"}</strong></div></div><div className="compute-v2-record-detail"><p>该资源池已完成硬件、网络与运行环境核验，支持标准镜像快速交付，并提供运行监控与服务跟进。</p></div><div className="compute-v2-modal-actions"><button type="button" className="secondary" onClick={() => setSelected(null)}>关闭</button><button type="button" onClick={() => { setSelected(null); onOpenProducts(); }}>查看可用资源</button></div></MarketModal>}</div>;
}

const mineOrderCounts: Record<Exclude<MineOrderStatus, "all">, number> = { pending: 2, running: 3, delivery: 1, completed: 16 };
const mineOrderLabels: Record<MineOrderStatus, string> = { all: "全部订单", pending: "待确认订单", running: "运行中订单", delivery: "待交付订单", completed: "已完成订单" };
const mineOrders: MarketOrder[] = [
  { id: "COD-0814-031", status: "running" as const, resource: "H200 SXM 2 卡", meta: "成都 A 区, 剩余 31 小时", amount: "2,496.0 卡时", label: "运行中" },
  { id: "COD-0814-028", status: "running" as const, resource: "L40S 8 卡", meta: "贵阳 B 区, 剩余 18 小时", amount: "1,478.4 卡时", label: "运行中" },
  { id: "COD-0813-097", status: "running" as const, resource: "RTX 5090 4 卡", meta: "杭州 C 区, 剩余 42 小时", amount: "1,344.0 卡时", label: "运行中" },
  { id: "COD-0814-036", status: "pending" as const, resource: "B300 SXM 4 卡", meta: "华北资源池, 等待配置确认", amount: "4,224.0 卡时", label: "待确认" },
  { id: "COD-0814-034", status: "pending" as const, resource: "H100 SXM 8 卡", meta: "华东资源池, 等待镜像确认", amount: "3,840.0 卡时", label: "待确认" },
  { id: "COD-0813-088", status: "delivery" as const, resource: "A800 PCIe 16 卡", meta: "西南资源池, 环境部署中", amount: "4,608.0 卡时", label: "待交付" },
  { id: "COD-0812-072", status: "completed" as const, resource: "RTX 4090 8 卡", meta: "华南 D 区, 已运行 36 小时", amount: "1,382.4 卡时", label: "已完成" },
  { id: "COD-0811-061", status: "completed" as const, resource: "H100 SXM 2 卡", meta: "成都 A 区, 已运行 24 小时", amount: "960.0 卡时", label: "已完成" },
];

interface MineResourceRow {
  title: string;
  meta: string;
  value: string;
  tone?: "active" | "warning" | "neutral";
}

function mineResourceContent(view: Exclude<MineResourceView, "orders">, balanceCardHours: string | null) {
  const assetMetrics: Array<[string, string]> = balanceCardHours
    ? [["可用卡时", balanceCardHours], ["交易冻结", "320.0"], ["本月消耗", "4,862.4"]]
    : [["可用卡时", "注册后领取"], ["账户状态", "未登录"], ["资产明细", "登录后查看"]];
  const assetRows: MineResourceRow[] = balanceCardHours
    ? [{ title: "账户余额已同步", meta: "余额与注册权益已同步至当前账户", value: `${balanceCardHours} 卡时`, tone: "active" }, { title: "H200 订单冻结", meta: "COD-0814-031, 运行中", value: "-2,496.0 卡时", tone: "warning" }, { title: "运行结算退回", meta: "COD-0812-072, 提前 2 小时结束", value: "+76.8 卡时", tone: "active" }]
    : [{ title: "新用户注册权益", meta: "完成注册并登录后自动到账", value: "待领取", tone: "neutral" }];
  const ledgerMetrics: Array<[string, string]> = balanceCardHours
    ? [["可用卡时", balanceCardHours], ["本月获得", "1,286.5"], ["本月消耗", "4,862.4"]]
    : [["可用卡时", "注册后领取"], ["流水范围", "近 30 日"], ["账户状态", "未登录"]];
  const ledgerRows: MineResourceRow[] = balanceCardHours
    ? [{ title: "账户权益到账", meta: "2026-08-14 09:18", value: "+1,286.5", tone: "active" }, { title: "H200 订单冻结", meta: "2026-08-14 10:42", value: "-2,496.0", tone: "warning" }, { title: "RTX 4090 运行扣减", meta: "2026-08-13 18:26", value: "-1,382.4", tone: "warning" }, { title: "提前结束退回", meta: "2026-08-13 18:29", value: "+76.8", tone: "active" }]
    : [{ title: "暂无账户明细", meta: "注册并登录后显示卡时发放、冻结和扣减记录", value: "未登录", tone: "neutral" }];
  const resources: Record<Exclude<MineResourceView, "orders">, { icon: typeof House; title: string; description: string; badge: string; metrics: Array<[string, string]>; rows: MineResourceRow[] }> = {
    devices: { icon: HardDrives, title: "我的设备", description: "查看已接入资源池的设备和当前运行状态。", badge: "12 台设备", metrics: [["运行中", "8 台"], ["待验收", "1 台"], ["平均在线率", "99.6%"]], rows: [{ title: "CD-GPU-021", meta: "H200 SXM 8 卡, 成都 A 区", value: "运行中", tone: "active" }, { title: "GY-GPU-016", meta: "L40S 16 卡, 贵阳 B 区", value: "运行中", tone: "active" }, { title: "HZ-GPU-009", meta: "H100 SXM 8 卡, 杭州 C 区", value: "维护中", tone: "warning" }, { title: "WL-GPU-007", meta: "RTX 4090 8 卡, 乌兰察布", value: "待验收", tone: "neutral" }] },
    hosting: { icon: Buildings, title: "托管申请", description: "集中跟进资料核验、设备验收和资源池接入。", badge: "4 条申请", metrics: [["运行中", "2 条"], ["待处理", "1 条"], ["本月收益", "6,840 卡时"]], rows: [{ title: "H200 整机托管", meta: "8 卡整机, 成都智算中心", value: "已接入", tone: "active" }, { title: "L40S 集群托管", meta: "16 卡集群, 贵阳数据中心", value: "运行中", tone: "active" }, { title: "H100 服务器托管", meta: "8 卡整机, 杭州资源区", value: "待验收", tone: "warning" }, { title: "RTX 4090 工作站", meta: "8 卡节点, 乌兰察布", value: "资料核验", tone: "neutral" }] },
    assets: { icon: Wallet, title: "资产账户", description: "查看卡时余额、冻结金额和近期资产变化。", badge: balanceCardHours ? "账户已同步" : "注册后可用", metrics: assetMetrics, rows: assetRows },
    verification: { icon: ShieldCheck, title: "实名认证", description: "查看账户认证、企业信息和安全状态。", badge: "认证完成", metrics: [["身份认证", "已完成"], ["企业认证", "已完成"], ["账户安全", "正常"]], rows: [{ title: "个人身份认证", meta: "身份信息已通过核验", value: "已完成", tone: "active" }, { title: "企业主体认证", meta: "成都贤酷吉步科技有限公司", value: "已完成", tone: "active" }, { title: "联系人认证", meta: "业务联系人和手机号已核验", value: "已完成", tone: "active" }, { title: "交易安全检查", meta: "最近检查 2026-08-14", value: "正常", tone: "active" }] },
    support: { icon: Headset, title: "专属客服", description: "跟进资源配置、部署和售后问题。", badge: "服务时间 09:00-18:00", metrics: [["当前工单", "2 单"], ["平均响应", "8 分钟"], ["服务评价", "4.9"]], rows: [{ title: "H200 镜像环境确认", meta: "工单 CS-0814-019, 技术支持", value: "处理中", tone: "active" }, { title: "托管设备网络核验", meta: "工单 CS-0813-041, 交付支持", value: "待回复", tone: "warning" }, { title: "卡时结算说明", meta: "工单 CS-0812-028, 账户支持", value: "已解决", tone: "neutral" }] },
    help: { icon: Wrench, title: "帮助中心", description: "查看算力购买、运行、托管和结算指引。", badge: "6 个主题", metrics: [["新手指南", "12 篇"], ["运行与镜像", "18 篇"], ["托管与结算", "15 篇"]], rows: [{ title: "如何选择合适的 GPU", meta: "按模型规模、显存和任务时长进行比较", value: "选型指南" }, { title: "卡时如何计算", meta: "了解资源价格、数量和运行时长的关系", value: "计费说明" }, { title: "镜像和环境怎么选", meta: "PyTorch、vLLM 和 ComfyUI 环境说明", value: "运行指南" }, { title: "设备托管流程", meta: "从资料提交到验收接入的完整流程", value: "托管指南" }] },
    purchase: { icon: Wallet, title: "购买卡时", description: "选择卡时包后用于算力租赁和运行结算。", badge: "即时到账", metrics: [["当前余额", balanceCardHours ?? "注册后领取"], ["有效期", "长期有效"], ["到账方式", "账户余额"]], rows: [{ title: "轻量卡时包", meta: "适合开发测试和短时推理", value: "50 卡时" }, { title: "标准卡时包", meta: "适合模型微调和批量推理", value: "200 卡时" }, { title: "团队卡时包", meta: "适合多卡训练和团队任务", value: "500 卡时" }] },
    ledger: { icon: Wallet, title: "卡时明细", description: "查看卡时发放、冻结、扣减和退回记录。", badge: "近 30 日", metrics: ledgerMetrics, rows: ledgerRows },
  };
  return resources[view];
}

function MineResourceDetail({
  view,
  orderStatus,
  balanceCardHours,
  orders,
  orderCounts,
  session,
  onBack,
  onRequireLogin,
  onOpenAccount,
  onOpenSupport,
}: {
  view: MineResourceView;
  orderStatus: MineOrderStatus;
  balanceCardHours: string | null;
  orders: MarketOrder[];
  orderCounts: Record<Exclude<MineOrderStatus, "all">, number>;
  session: CodSession | null;
  onBack: () => void;
  onRequireLogin: () => void;
  onOpenAccount: () => void;
  onOpenSupport: () => void;
}) {
  const [selected, setSelected] = useState<MineResourceRow | MarketOrder | null>(null);
  if (view === "orders") {
    const rows = orderStatus === "all" ? orders : orders.filter((order) => order.status === orderStatus);
    const total = orderStatus === "all" ? Object.values(orderCounts).reduce((sum, count) => sum + count, 0) : orderCounts[orderStatus];
    const selectedOrder = selected && "id" in selected ? selected : null;
    return <div className="compute-v2-resource-detail"><header className="compute-v2-detail-head"><button type="button" onClick={onBack}><ArrowLeft /> 返回我的资源</button><div><small>订单中心</small><h1>{mineOrderLabels[orderStatus]}</h1></div><span>共 {total} 单</span></header><section className="compute-v2-resource-hero"><i><Package weight="fill" /></i><div><small>算力订单</small><h2>从确认到交付，全程可追踪</h2><p>当前列表展示近期订单，状态和资源信息保持同步。</p></div><div className="compute-v2-resource-metrics"><span><small>待确认</small><strong>{orderCounts.pending}</strong></span><span><small>运行中</small><strong>{orderCounts.running}</strong></span><span><small>待交付</small><strong>{orderCounts.delivery}</strong></span></div></section><section className="compute-v2-resource-panel"><header><div><h2>{mineOrderLabels[orderStatus]}</h2><p>显示近期记录，共 {total} 单</p></div><span>{rows.length} 条记录</span></header><div className="compute-v2-resource-list">{rows.map((order) => <button type="button" onClick={() => setSelected(order)} key={order.id}><div><small>{order.id}</small><strong>{order.resource}</strong><p>{order.meta}</p></div><b>{order.amount}</b><span className={`tone-${order.status === "running" ? "active" : order.status === "pending" || order.status === "delivery" ? "warning" : "neutral"}`}>{order.label}</span><CaretRight /></button>)}</div></section>{selectedOrder && <MarketModal title={`订单 ${selectedOrder.id}`} description="订单状态和资源配置" onClose={() => setSelected(null)}><RecordDetail title={selectedOrder.resource} meta={selectedOrder.meta} value={`${selectedOrder.label} · ${selectedOrder.amount}`} /><div className="compute-v2-modal-actions"><button type="button" className="secondary" onClick={() => setSelected(null)}>关闭</button><button type="button" onClick={() => { setSelected(null); onOpenSupport(); }}>联系服务支持</button></div></MarketModal>}</div>;
  }
  const content = mineResourceContent(view, balanceCardHours);
  const Icon = content.icon;
  const selectedRow = selected && !("id" in selected) ? selected : null;
  const openRecord = (row: MineResourceRow) => {
    if (view === "purchase") {
      if (!session) onRequireLogin(); else onOpenAccount();
      return;
    }
    setSelected(row);
  };
  const action = view === "support" ? { label: "继续联系客服", run: onOpenSupport } : view === "assets" || view === "ledger" ? { label: "打开账户中心", run: session ? onOpenAccount : onRequireLogin } : null;
  return <div className="compute-v2-resource-detail"><header className="compute-v2-detail-head"><button type="button" onClick={onBack}><ArrowLeft /> 返回我的资源</button><div><small>我的资源</small><h1>{content.title}</h1></div><span>{content.badge}</span></header><section className="compute-v2-resource-hero"><i><Icon weight="fill" /></i><div><small>COD 算力服务</small><h2>{content.title}</h2><p>{content.description}</p></div><div className="compute-v2-resource-metrics">{content.metrics.map(([label, value]) => <span key={label}><small>{label}</small><strong>{value}</strong></span>)}</div></section><section className="compute-v2-resource-panel"><header><div><h2>详细信息</h2><p>{content.description}</p></div><span>{content.rows.length} 条记录</span></header><div className="compute-v2-resource-list">{content.rows.map((row) => <button type="button" onClick={() => openRecord(row)} key={row.title}><div><strong>{row.title}</strong><p>{row.meta}</p></div><b>{row.value}</b>{row.tone && <span className={`tone-${row.tone}`}>{row.tone === "active" ? "正常" : row.tone === "warning" ? "待处理" : "已记录"}</span>}<CaretRight /></button>)}</div></section>{selectedRow && <MarketModal title={selectedRow.title} description={content.title} onClose={() => setSelected(null)}><RecordDetail {...selectedRow} />{action && <div className="compute-v2-modal-actions"><button type="button" className="secondary" onClick={() => setSelected(null)}>关闭</button><button type="button" onClick={() => { setSelected(null); action.run(); }}>{action.label}</button></div>}</MarketModal>}</div>;
}

function MinePage({ session, balanceCardHours, orderCounts, onRequireLogin, onOpenOperations, onOpenResource }: { session: CodSession | null; balanceCardHours: string | null; orderCounts: Record<Exclude<MineOrderStatus, "all">, number>; onRequireLogin: () => void; onOpenOperations: () => void; onOpenResource: (view: MineResourceView, status?: MineOrderStatus) => void }) {
  const services: Array<{ icon: typeof House; label: string; detail: string; view: MineResourceView }> = [{icon:HardDrives,label:"我的设备",detail:"12 台设备",view:"devices"},{icon:Buildings,label:"托管申请",detail:"查看接入进度",view:"hosting"},{icon:Wallet,label:"资产账户",detail:"卡时与流水",view:"assets"},{icon:ShieldCheck,label:"实名认证",detail:"已完成",view:"verification"},{icon:Headset,label:"专属客服",detail:"工作日 09:00-18:00",view:"support"},{icon:Wrench,label:"帮助中心",detail:"使用指南与问题",view:"help"}];
  return <div className="compute-v2-page-stack"><section className="compute-v2-profile"><div className="compute-v2-avatar"><UserCircle weight="fill" /></div><div><small>{session ? "已连接 COD 账户" : "访客账户"}</small><h1>{session?.account.displayName ?? "COD 算力市场"}</h1><p>{session ? "账户、卡时与算力订单统一管理" : "登录后查看新用户权益、余额与个人订单"}</p></div>{!session && <button type="button" onClick={onRequireLogin}>注册或登录</button>}</section>{session && <section className="compute-v2-wallet"><header><span><Wallet /> 可用卡时</span></header><strong>{balanceCardHours} <small>卡时</small></strong><p>账户余额与注册权益已同步</p><div><button type="button" onClick={() => onOpenResource("purchase")}>购买卡时</button><button type="button" onClick={() => onOpenResource("ledger")}>卡时明细</button></div></section>}<section className="compute-v2-operations-entry"><div><span><ChartBar /></span><div><small>公开数据</small><h2>经营看板</h2><p>集中查看区域供给、利用率、订单管线与近期交付。</p></div></div><button type="button" onClick={onOpenOperations}>打开经营看板 <CaretRight /></button></section><section className="compute-v2-orders"><SectionTitle title="我的订单" action="全部订单" onAction={() => onOpenResource("orders", "all")} /><div><button type="button" onClick={() => onOpenResource("orders", "pending")}><Clock /><strong>待确认</strong><span>{orderCounts.pending}</span></button><button type="button" onClick={() => onOpenResource("orders", "running")}><Lightning /><strong>运行中</strong><span>{orderCounts.running}</span></button><button type="button" onClick={() => onOpenResource("orders", "delivery")}><Package /><strong>待交付</strong><span>{orderCounts.delivery}</span></button><button type="button" onClick={() => onOpenResource("orders", "completed")}><Check /><strong>已完成</strong><span>{orderCounts.completed}</span></button></div></section><section className="compute-v2-services"><SectionTitle title="常用服务" />{services.map((item) => { const Icon=item.icon; return <button type="button" onClick={() => onOpenResource(item.view)} key={item.label}><Icon /><span><strong>{item.label}</strong><small>{item.detail}</small></span><CaretRight /></button>; })}</section></div>;
}

function OperationsValue({ value }: { value: string }) {
  if (!value.endsWith("%")) return value;
  return <>{value.slice(0, -1)}<span className="compute-v2-percent-sign">%</span></>;
}

function OperationsDashboard({ onBack }: { onBack: () => void }) {
  const pipelineTotal = computeOperationsDemo.pipeline.reduce((total, item) => total + item.value, 0);
  return (
    <div className="compute-v2-operations">
      <header className="compute-v2-operations-head">
        <button type="button" onClick={onBack}><ArrowLeft /> 返回算力市场</button>
        <div><small>COD 算力市场</small><strong>经营看板</strong></div>
        <span>公开数据</span>
      </header>
      <section className="compute-v2-operations-hero">
        <div><span>COD COMPUTE MARKET</span><h1>算力供需与经营概览</h1><p>把区域供给、成交进度与交付状态集中到一个可追踪的交易工作台。</p></div>
        <aside><strong>经营数据</strong><span>{computeOperationsDemo.period}</span></aside>
      </section>
      <section className="compute-v2-operations-metrics" aria-label="经营核心指标">
        {computeOperationsDemo.metrics.map((item) => <article key={item.label}><span>{item.label}</span><strong><OperationsValue value={item.value} /></strong><small>{item.detail}</small></article>)}
      </section>
      <div className="compute-v2-operations-grid">
        <section className="compute-v2-operations-panel compute-v2-region-panel">
          <header><div><h2>区域供给</h2><p>可调度资源与利用率</p></div><span>{computeOperationsDemo.regions.length} 个区域</span></header>
          <div className="compute-v2-table-scroll">
            <table><thead><tr><th>区域</th><th>主力资源</th><th>可用卡数</th><th>利用率</th></tr></thead><tbody>{computeOperationsDemo.regions.map((region) => <tr key={region.name}><th scope="row">{region.name}</th><td>{region.resource}</td><td>{region.cards}</td><td><strong><OperationsValue value={region.utilization} /></strong></td></tr>)}</tbody></table>
          </div>
        </section>
        <section className="compute-v2-operations-panel compute-v2-pipeline-panel">
          <header><div><h2>订单管线</h2><p>从需求核验到资源交付</p></div><span>{pipelineTotal} 单</span></header>
          <div>{computeOperationsDemo.pipeline.map((item) => <article className={`tone-${item.tone}`} key={item.label}><span>{item.label}</span><strong>{item.value}</strong></article>)}</div>
        </section>
      </div>
      <section className="compute-v2-operations-panel compute-v2-deals-panel">
        <header><div><h2>近期成交与交付</h2><p>展示客户、资源规模与当前状态</p></div><span>成交记录</span></header>
        <div className="compute-v2-table-scroll">
          <table><thead><tr><th>客户</th><th>资源</th><th>规模</th><th>金额</th><th>状态</th></tr></thead><tbody>{computeOperationsDemo.deals.map((deal) => <tr key={deal.customer}><th scope="row">{deal.customer}</th><td>{deal.resource}</td><td>{deal.scale}</td><td><strong>{deal.amount}</strong></td><td><span className={`status-${deal.tone}`}>{deal.status}</span></td></tr>)}</tbody></table>
        </div>
      </section>
    </div>
  );
}

function ProductDetail({
  product,
  session,
  onBack,
  onRequireLogin,
  onCreateOrder,
  onViewOrders,
}: {
  product: ComputeDemoProduct;
  session: CodSession | null;
  onBack: () => void;
  onRequireLogin: () => void;
  onCreateOrder: (order: Omit<MarketOrder, "id">) => MarketOrder;
  onViewOrders: () => void;
}) {
  const [imageId, setImageId] = useState(product.images[0]?.id ?? "");
  const [period, setPeriod] = useState("按日");
  const [quantity, setQuantity] = useState(1);
  const [hours, setHours] = useState(24);
  const [submittedOrder, setSubmittedOrder] = useState<MarketOrder | null>(null);
  const total = product.price * quantity * hours;
  const selectPeriod = (nextPeriod: string) => {
    setPeriod(nextPeriod);
    setHours(nextPeriod === "按小时" ? 1 : nextPeriod === "按月" ? 720 : 24);
  };
  const submitOrder = () => {
    if (!session) { onRequireLogin(); return; }
    if (submittedOrder) return;
    const image = product.images.find((item) => item.id === imageId);
    const order = onCreateOrder({
      status: "pending",
      resource: `${product.gpuModel.replace("NVIDIA ", "")} ${quantity} 卡`,
      meta: `${product.region}, ${image?.name ?? "标准镜像"} · ${period} ${hours} 小时`,
      amount: `${total.toFixed(1)} 卡时`,
      label: "待确认",
    });
    setSubmittedOrder(order);
  };
  return <div className="compute-v2-detail"><header className="compute-v2-detail-head"><button type="button" onClick={onBack}><ArrowLeft /> 返回</button><div><small>{product.region}</small><h1>{product.title}</h1></div><span>公开价格</span></header><div className="compute-v2-detail-grid"><section className="compute-v2-detail-summary"><img src={product.image} alt={`${product.gpuModel} 产品图`} /><div className="compute-v2-detail-title"><div><span>{product.badge}</span><h2>{product.gpuModel}</h2><p>{product.gpuMemory} · {product.availability}</p></div><strong>{product.price.toFixed(1)}<small> 卡时/小时</small></strong></div><dl className="compute-v2-detail-specs"><div><dt>CPU</dt><dd>{product.specs.cpu}</dd></div><div><dt>内存</dt><dd>{product.specs.memory}</dd></div><div><dt>系统</dt><dd>{product.specs.system}</dd></div><div><dt>环境</dt><dd>{product.specs.cuda}</dd></div></dl><div className="compute-v2-detail-assurance"><span><ShieldCheck /> 资源验真</span><span><Lightning /> 快速交付</span><span><Headset /> 服务支持</span></div></section><section className="compute-v2-config"><header><h2>配置订单</h2><span>选择镜像、周期与数量</span></header><fieldset><legend>租用周期</legend><div className="compute-v2-choice-row">{["按小时","按日","按月"].map((item) => <button type="button" className={period === item ? "active" : ""} onClick={() => { selectPeriod(item); setSubmittedOrder(null); }} key={item}>{item}</button>)}</div></fieldset><fieldset><legend>运行镜像</legend><div className="compute-v2-image-options">{product.images.map((image) => <button type="button" className={imageId === image.id ? "active" : ""} onClick={() => { setImageId(image.id); setSubmittedOrder(null); }} key={image.id}><strong>{image.name}</strong><small>{image.detail}</small>{imageId === image.id && <Check />}</button>)}</div></fieldset><div className="compute-v2-number-row"><label><span>GPU 数量</span><div><button type="button" aria-label="减少 GPU 数量" onClick={() => { setQuantity(Math.max(1, quantity - 1)); setSubmittedOrder(null); }}>−</button><strong>{quantity} 卡</strong><button type="button" aria-label="增加 GPU 数量" onClick={() => { setQuantity(Math.min(8, quantity + 1)); setSubmittedOrder(null); }}>＋</button></div></label><label><span>租用时长</span><div><button type="button" aria-label="减少租用时长" onClick={() => { setHours(Math.max(1, hours - 1)); setSubmittedOrder(null); }}>−</button><strong>{hours} 小时</strong><button type="button" aria-label="增加租用时长" onClick={() => { setHours(Math.min(2160, hours + 1)); setSubmittedOrder(null); }}>＋</button></div></label></div><div className="compute-v2-cost"><span>预计消耗<small>{product.price.toFixed(1)} × {quantity} 卡 × {hours} 小时</small></span><strong>{total.toFixed(1)} <small>卡时</small></strong></div><button className="compute-v2-submit" type="button" onClick={submitOrder}>{submittedOrder ? "订单已提交" : "确认配置并提交"}</button>{submittedOrder && <div className="compute-v2-feedback" role="status"><span><Check /> 订单已提交，编号 {submittedOrder.id}</span><button type="button" onClick={onViewOrders}>查看订单 <CaretRight /></button></div>}</section></div><footer className="compute-v2-detail-sticky"><span><small>预计消耗</small><strong>{total.toFixed(1)} 卡时</strong></span><button type="button" onClick={submitOrder}>{submittedOrder ? "已提交" : "提交订单"}</button></footer></div>;
}

function scrollComputeToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
  document.querySelector<HTMLElement>(".compute-v2-shell")?.scrollTo?.({ top: 0, behavior: "smooth" });
}

export function ComputeMarketApp({ session, balanceCardHours, initialPath, platform, offers = [], onRequireLogin, onOpenAccount, onOpenSupport, onExit }: ComputeMarketAppProps) {
  const initialRoute = readComputeRoute(initialPath);
  const [tab, setTab] = useState<ComputeTab>(initialRoute.tab);
  const [productId, setProductId] = useState<string | null>(initialRoute.productId);
  const [operations, setOperations] = useState(initialRoute.operations);
  const [mineView, setMineView] = useState<MineResourceView | null>(initialRoute.mineView);
  const [orderStatus, setOrderStatus] = useState<MineOrderStatus>(initialRoute.orderStatus);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [createdOrders, setCreatedOrders] = useState<MarketOrder[]>([]);
  const products = useMemo(() => offers.length ? offers.map(toDemoProduct) : computeDemoProducts, [offers]);
  const selectedProduct = products.find((product) => product.id === productId) ?? null;
  const orders = useMemo(() => [...createdOrders, ...mineOrders], [createdOrders]);
  const orderCounts = useMemo(() => ({ ...mineOrderCounts, pending: mineOrderCounts.pending + createdOrders.length }), [createdOrders.length]);

  useEffect(() => {
    const handlePopState = () => {
      const route = readComputeRoute(window.location.href);
      setTab(route.tab);
      setProductId(route.productId);
      setOperations(route.operations);
      setMineView(route.mineView);
      setOrderStatus(route.orderStatus);
      setNotificationsOpen(false);
      scrollComputeToTop();
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = (nextTab: ComputeTab, nextProductId: string | null = null) => {
    const url = new URL("/compute", window.location.origin);
    if (nextTab !== "home") url.searchParams.set("tab", nextTab);
    if (nextProductId) url.searchParams.set("offer", nextProductId);
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setTab(nextTab);
    setProductId(nextProductId);
    setOperations(false);
    setMineView(null);
    setOrderStatus("all");
    setNotificationsOpen(false);
    scrollComputeToTop();
  };

  const openOperations = () => {
    const url = new URL("/compute", window.location.origin);
    url.searchParams.set("tab", "mine");
    url.searchParams.set("view", "operations");
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setTab("mine");
    setProductId(null);
    setOperations(true);
    setMineView(null);
    setOrderStatus("all");
    setNotificationsOpen(false);
    scrollComputeToTop();
  };

  const openMineResource = (view: MineResourceView, status: MineOrderStatus = "all") => {
    const url = new URL("/compute", window.location.origin);
    url.searchParams.set("tab", "mine");
    url.searchParams.set("view", view);
    if (view === "orders" && status !== "all") url.searchParams.set("status", status);
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setTab("mine");
    setProductId(null);
    setOperations(false);
    setMineView(view);
    setOrderStatus(status);
    setNotificationsOpen(false);
    scrollComputeToTop();
  };

  const openAccount = () => {
    if (onOpenAccount) onOpenAccount();
    else navigate("mine");
  };

  const openSupport = () => {
    if (onOpenSupport) onOpenSupport();
    else openMineResource("support");
  };

  const createMarketOrder = (draft: Omit<MarketOrder, "id">) => {
    const order = { ...draft, id: `COD-NEW-${String(createdOrders.length + 1).padStart(3, "0")}` };
    setCreatedOrders((current) => [order, ...current]);
    return order;
  };

  return (
    <div className="compute-market-app" data-platform={platform}>
      <aside className="compute-v2-sidebar">
        <button className="compute-v2-brand" type="button" onClick={() => navigate("home")}><i><Lightning weight="fill" /></i><span><strong>COD</strong><small>算力市场</small></span></button>
        <nav aria-label="算力市场主导航">{navItems.map((item) => { const Icon=item.icon; return <button type="button" className={tab === item.id && !productId && !operations && !mineView ? "active" : ""} onClick={() => navigate(item.id)} key={item.id}><Icon weight={tab === item.id && !operations ? "fill" : "regular"} /><span>{item.label}</span></button>; })}</nav>
        <button className={`compute-v2-operations-nav${operations ? " active" : ""}`} type="button" onClick={openOperations}><ChartBar weight={operations ? "fill" : "regular"} /><span><strong>经营看板</strong><small>公开经营数据</small></span></button>
        {session && <section><small>可用卡时</small><strong>{balanceCardHours}</strong></section>}
        <button className="compute-v2-exit" type="button" onClick={onExit}><ArrowLeft /> 返回 COD 工作区</button>
      </aside>
      <div className="compute-v2-shell">
        <header className="compute-v2-topbar"><button className="compute-v2-mobile-brand" type="button" onClick={() => navigate("home")}><Lightning weight="fill" /><strong>COD 算力</strong></button><div><button type="button" aria-label="通知" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(true)}><Bell /></button>{session ? <button type="button" className="compute-v2-user" onClick={openAccount}><UserCircle weight="fill" /> {session.account.displayName}</button> : <button type="button" className="compute-v2-login" onClick={() => onRequireLogin(window.location.href)}>注册或登录</button>}</div></header>
        <main className="compute-v2-main">{operations ? <OperationsDashboard onBack={() => navigate("home")} /> : mineView ? <MineResourceDetail view={mineView} orderStatus={orderStatus} balanceCardHours={balanceCardHours} orders={orders} orderCounts={orderCounts} session={session} onBack={() => navigate("mine")} onRequireLogin={() => onRequireLogin(window.location.href)} onOpenAccount={openAccount} onOpenSupport={openSupport} /> : selectedProduct ? <ProductDetail product={selectedProduct} session={session} onBack={() => navigate("home")} onRequireLogin={() => onRequireLogin(window.location.href)} onCreateOrder={createMarketOrder} onViewOrders={() => openMineResource("orders", "pending")} /> : tab === "home" ? <HomePage session={session} balanceCardHours={balanceCardHours} products={products} onOpenProduct={(id) => navigate("home", id)} onNavigate={(nextTab) => navigate(nextTab)} onOpenOperations={openOperations} onOpenResource={openMineResource} onRequireLogin={() => onRequireLogin(window.location.href)} /> : tab === "hosting" ? <HostingPage session={session} onRequireLogin={() => onRequireLogin(window.location.href)} onOpenResource={openMineResource} /> : tab === "news" ? <NewsPage /> : tab === "ranking" ? <RankingPage onOpenProducts={() => navigate("home")} /> : <MinePage session={session} balanceCardHours={balanceCardHours} orderCounts={orderCounts} onRequireLogin={() => onRequireLogin(window.location.href)} onOpenOperations={openOperations} onOpenResource={openMineResource} />}</main>
        {!selectedProduct && !operations && !mineView && <nav className="compute-v2-bottom-nav" aria-label="算力市场底部导航">{navItems.map((item) => { const Icon=item.icon; return <button type="button" className={tab === item.id ? "active" : ""} onClick={() => navigate(item.id)} key={item.id}><Icon weight={tab === item.id ? "fill" : "regular"} /><span>{item.label}</span></button>; })}</nav>}
        {notificationsOpen && <MarketModal title="消息通知" description="资源、订单与平台动态" onClose={() => setNotificationsOpen(false)}><div className="compute-v2-notification-list"><button type="button" onClick={() => openMineResource("orders", "running")}><i><Lightning /></i><span><strong>3 个实例正在运行</strong><small>资源状态正常，今日预计消耗 82.4 卡时</small></span><CaretRight /></button><button type="button" onClick={() => openMineResource("hosting")}><i><Buildings /></i><span><strong>托管资料待补充</strong><small>H100 服务器托管申请等待验收信息</small></span><CaretRight /></button><button type="button" onClick={() => navigate("news")}><i><Newspaper /></i><span><strong>华东 B 区新增资源</strong><small>H100 资源池已开放配置</small></span><CaretRight /></button></div></MarketModal>}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
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

export interface ComputeDemoAppProps {
  session: CodSession | null;
  initialPath: string;
  platform: "web" | "desktop" | "mobile";
  offers?: ComputeOffer[];
  onRequireLogin(returnTo: string): void;
  onExit(): void;
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
  return {
    tab: navItems.some((item) => item.id === tab) ? (tab as ComputeTab) : "home",
    productId: url.searchParams.get("offer"),
    operations: url.searchParams.get("view") === "operations",
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
          : "人工询价",
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
}: {
  title: string;
  description?: string;
  action?: string;
}) {
  return (
    <header className="compute-v2-section-title">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action && (
        <button type="button">
          {action} <CaretRight />
        </button>
      )}
    </header>
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
            {product.price.toFixed(1)} <small>卡时/天起</small>
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
  products,
  onOpenProduct,
  onNavigate,
}: {
  products: ComputeDemoProduct[];
  onOpenProduct: (id: string) => void;
  onNavigate: (tab: ComputeTab) => void;
}) {
  const [filter, setFilter] = useState("全部");
  const filters = ["全部", "H200", "H100", "A800", "消费级"];
  const visibleProducts = products.filter((product) => {
    if (filter === "全部") return true;
    if (filter === "消费级") return product.gpuModel.includes("4090");
    return product.gpuModel.includes(filter);
  });
  const quickEntries = [
    { label: "找算力", detail: "按模型筛选", icon: Cpu, action: () => document.getElementById("compute-products")?.scrollIntoView({ behavior: "smooth" }) },
    { label: "托管设备", detail: "接入资源池", icon: Buildings, action: () => onNavigate("hosting") },
    { label: "我的订单", detail: "跟进交付", icon: Package, action: () => onNavigate("mine") },
    { label: "在线客服", detail: "方案咨询", icon: Headset, action: () => undefined },
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
        <img src="/compute/gpu-h200.svg" alt="H200 算力卡演示图" />
      </section>

      <section className="compute-v2-notices" aria-label="账户提醒">
        <article><Wallet /><div><small>可用卡时</small><strong>1,286.5</strong><span>可支持约 39 天 H200 单卡任务</span></div><CaretRight /></article>
        <article><Clock /><div><small>运行中的订单</small><strong>3 个实例</strong><span>今日预计消耗 82.4 卡时</span></div><CaretRight /></article>
      </section>

      <section className="compute-v2-quick" aria-label="快捷入口">
        {quickEntries.map((entry) => {
          const Icon = entry.icon;
          return <button type="button" onClick={entry.action} key={entry.label}><i><Icon /></i><strong>{entry.label}</strong><small>{entry.detail}</small></button>;
        })}
      </section>

      <section className="compute-v2-catalog" id="compute-products">
        <SectionTitle title="热门算力卡" description="根据近期交付速度与可用库存推荐" action="全部资源" />
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

function HostingPage() {
  return (
    <div className="compute-v2-page-stack">
      <section className="compute-v2-page-banner hosting">
        <div><span>设备托管</span><h1>闲置设备，接入 COD 算力资源池</h1><p>标准化验收、运行监控与收益结算，托管状态随时可查。</p><button type="button">开始托管申请</button></div>
        <Buildings />
      </section>
      <section className="compute-v2-status-grid">
        <article><small>已托管设备</small><strong>12</strong><span>8 台运行中</span></article>
        <article><small>本月预计卡时</small><strong>6,840</strong><span>较上月 +12.6%</span></article>
        <article><small>待处理事项</small><strong>2</strong><span>1 台待验收</span></article>
        <article><small>在线率</small><strong>99.6%</strong><span>近 30 日</span></article>
      </section>
      <section className="compute-v2-host-card">
        <img src="/compute/gpu-h200.svg" alt="H200 托管设备演示图" />
        <div><span>重点资源计划</span><h2>H200 / H100 设备托管</h2><p>支持整机、机柜级接入；验收通过后进入资源池，运行数据和结算记录全程可追踪。</p><ul><li><Check /> 设备信息核验</li><li><Check /> 机房环境验收</li><li><Check /> 上线与持续监控</li></ul><button type="button">查看托管方案 <CaretRight /></button></div>
      </section>
      <section className="compute-v2-process"><SectionTitle title="托管流程" description="四步完成设备接入" /><ol><li><b>01</b><strong>提交资料</strong><span>设备、机房和网络信息</span></li><li><b>02</b><strong>方案评估</strong><span>核验卡况与交付条件</span></li><li><b>03</b><strong>验收接入</strong><span>完成联调并进入资源池</span></li><li><b>04</b><strong>运行结算</strong><span>查看状态与卡时收益</span></li></ol></section>
    </div>
  );
}

function NewsPage() {
  return <div className="compute-v2-page-stack"><section className="compute-v2-page-banner news"><div><span>算力资讯</span><h1>看懂算力供需，做出更稳的资源决策</h1><p>产品动态、行业观察与技术实践，每周持续更新。</p></div><Newspaper /></section><section className="compute-v2-news"><SectionTitle title="最新内容" description="演示文章 · 暂不跳转外部链接" />{computeDemoNews.map((item, index) => <article key={item.title}><div className={`compute-v2-news-cover cover-${index + 1}`}><span>{item.category}</span><ChartBar /></div><div><span>{item.category} · {item.date}</span><h2>{item.title}</h2><p>聚焦真实业务场景，拆解资源选择、交付与成本控制中的关键问题。</p><small>{item.read}阅读 <CaretRight /></small></div></article>)}</section></div>;
}

function RankingPage() {
  return <div className="compute-v2-page-stack"><section className="compute-v2-page-banner ranking"><div><span>资源排行榜</span><h1>按稳定性与交付表现发现优质资源</h1><p>当前为老板展示用样例数据，正式指标需由真实监控数据生成。</p></div><Ranking /></section><section className="compute-v2-ranking"><SectionTitle title="本周资源榜" description="综合可用率、交付速度与服务评分" /><div className="compute-v2-ranking-head"><span>排名 / 资源池</span><span>可用率</span><span>综合分</span></div>{computeDemoRanking.map((item) => <article key={item.rank}><b>{item.rank}</b><div><strong>{item.name}</strong><small>{item.model}</small></div><span>{item.availability}</span><em>{item.score}</em></article>)}</section></div>;
}

function MinePage({ session, onRequireLogin, onOpenOperations }: { session: CodSession | null; onRequireLogin: () => void; onOpenOperations: () => void }) {
  return <div className="compute-v2-page-stack"><section className="compute-v2-profile"><div className="compute-v2-avatar"><UserCircle weight="fill" /></div><div><small>{session ? "已连接 COD 账户" : "演示访客"}</small><h1>{session?.account.displayName ?? "算力体验账号"}</h1><p>{session ? "账户、卡时与算力订单统一管理" : "登录后可同步真实卡时与订单"}</p></div>{!session && <button type="button" onClick={onRequireLogin}>登录 COD</button>}</section><section className="compute-v2-wallet"><header><span><Wallet /> 可用卡时</span><small>演示数据</small></header><strong>1,286.5 <small>卡时</small></strong><p>预计可支持 H200 单卡连续运行约 39 天</p><div><button type="button">购买卡时</button><button type="button">卡时明细</button></div></section><section className="compute-v2-operations-entry"><div><span><ChartBar /></span><div><small>管理视角</small><h2>经营看板</h2><p>集中查看区域供给、利用率、订单管线与近期交付。</p></div></div><button type="button" onClick={onOpenOperations}>打开经营看板 <CaretRight /></button></section><section className="compute-v2-orders"><SectionTitle title="我的订单" action="全部订单" /><div><button type="button"><Clock /><strong>待确认</strong><span>2</span></button><button type="button"><Lightning /><strong>运行中</strong><span>3</span></button><button type="button"><Package /><strong>待交付</strong><span>1</span></button><button type="button"><Check /><strong>已完成</strong><span>16</span></button></div></section><section className="compute-v2-services"><SectionTitle title="常用服务" />{[{icon:HardDrives,label:"我的设备",detail:"12 台设备"},{icon:Buildings,label:"托管申请",detail:"查看接入进度"},{icon:Wallet,label:"资产账户",detail:"卡时与流水"},{icon:ShieldCheck,label:"实名认证",detail:"已完成"},{icon:Headset,label:"专属客服",detail:"工作日 09:00-18:00"},{icon:Wrench,label:"帮助中心",detail:"使用指南与问题"}].map((item) => { const Icon=item.icon; return <button type="button" key={item.label}><Icon /><span><strong>{item.label}</strong><small>{item.detail}</small></span><CaretRight /></button>; })}</section></div>;
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
        <button type="button" onClick={onBack}><ArrowLeft /> 返回我的资源</button>
        <div><small>COD 算力市场</small><strong>经营看板</strong></div>
        <span>演示数据</span>
      </header>
      <section className="compute-v2-operations-hero">
        <div><span>COD COMPUTE MARKET</span><h1>算力供需与经营概览</h1><p>把区域供给、成交进度与交付状态集中到一个可追踪的交易工作台。</p></div>
        <aside><strong>演示数据</strong><span>{computeOperationsDemo.period}</span></aside>
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
        <header><div><h2>近期成交与交付</h2><p>展示客户、资源规模与当前状态</p></div><span>业务样例</span></header>
        <div className="compute-v2-table-scroll">
          <table><thead><tr><th>客户</th><th>资源</th><th>规模</th><th>金额</th><th>状态</th></tr></thead><tbody>{computeOperationsDemo.deals.map((deal) => <tr key={deal.customer}><th scope="row">{deal.customer}</th><td>{deal.resource}</td><td>{deal.scale}</td><td><strong>{deal.amount}</strong></td><td><span className={`status-${deal.tone}`}>{deal.status}</span></td></tr>)}</tbody></table>
        </div>
      </section>
    </div>
  );
}

function ProductDetail({ product, onBack }: { product: ComputeDemoProduct; onBack: () => void }) {
  const [imageId, setImageId] = useState(product.images[0]?.id ?? "");
  const [period, setPeriod] = useState("按日");
  const [quantity, setQuantity] = useState(1);
  const [days, setDays] = useState(7);
  const [feedback, setFeedback] = useState("");
  const total = product.price * quantity * days;
  return <div className="compute-v2-detail"><header className="compute-v2-detail-head"><button type="button" onClick={onBack}><ArrowLeft /> 返回</button><div><small>{product.region}</small><h1>{product.title}</h1></div><span>演示数据</span></header><div className="compute-v2-detail-grid"><section className="compute-v2-detail-summary"><img src={product.image} alt={`${product.gpuModel} 演示产品图`} /><div className="compute-v2-detail-title"><div><span>{product.badge}</span><h2>{product.gpuModel}</h2><p>{product.gpuMemory} · {product.availability}</p></div><strong>{product.price.toFixed(1)}<small> 卡时/天起</small></strong></div><dl className="compute-v2-detail-specs"><div><dt>CPU</dt><dd>{product.specs.cpu}</dd></div><div><dt>内存</dt><dd>{product.specs.memory}</dd></div><div><dt>系统</dt><dd>{product.specs.system}</dd></div><div><dt>环境</dt><dd>{product.specs.cuda}</dd></div></dl><div className="compute-v2-detail-assurance"><span><ShieldCheck /> 资源验真</span><span><Lightning /> 快速交付</span><span><Headset /> 服务支持</span></div></section><section className="compute-v2-config"><header><h2>配置订单</h2><span>选择镜像、周期与数量</span></header><fieldset><legend>运行镜像</legend><div className="compute-v2-image-options">{product.images.map((image) => <button type="button" className={imageId === image.id ? "active" : ""} onClick={() => setImageId(image.id)} key={image.id}><strong>{image.name}</strong><small>{image.detail}</small>{imageId === image.id && <Check />}</button>)}</div></fieldset><fieldset><legend>租用周期</legend><div className="compute-v2-choice-row">{["按日","按周","按月"].map((item) => <button type="button" className={period === item ? "active" : ""} onClick={() => setPeriod(item)} key={item}>{item}</button>)}</div></fieldset><div className="compute-v2-number-row"><label><span>GPU 数量</span><div><button type="button" onClick={() => setQuantity(Math.max(1, quantity - 1))}>−</button><strong>{quantity} 卡</strong><button type="button" onClick={() => setQuantity(Math.min(8, quantity + 1))}>＋</button></div></label><label><span>租用天数</span><div><button type="button" onClick={() => setDays(Math.max(1, days - 1))}>−</button><strong>{days} 天</strong><button type="button" onClick={() => setDays(Math.min(90, days + 1))}>＋</button></div></label></div><div className="compute-v2-cost"><span>预计消耗<small>{product.price.toFixed(1)} × {quantity} 卡 × {days} 天</small></span><strong>{total.toFixed(1)} <small>卡时</small></strong></div><button className="compute-v2-submit" type="button" onClick={() => setFeedback("演示订单已生成，不会提交真实交易。")}>确认配置并提交</button>{feedback && <p className="compute-v2-feedback" role="status"><Check /> {feedback}</p>}</section></div><footer className="compute-v2-detail-sticky"><span><small>预计消耗</small><strong>{total.toFixed(1)} 卡时</strong></span><button type="button" onClick={() => setFeedback("演示订单已生成，不会提交真实交易。")}>提交演示订单</button></footer></div>;
}

function scrollComputeToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
  document.querySelector<HTMLElement>(".compute-v2-shell")?.scrollTo?.({ top: 0, behavior: "smooth" });
}

export function ComputeDemoApp({ session, initialPath, platform, offers = [], onRequireLogin, onExit }: ComputeDemoAppProps) {
  const initialRoute = readComputeRoute(initialPath);
  const [tab, setTab] = useState<ComputeTab>(initialRoute.tab);
  const [productId, setProductId] = useState<string | null>(initialRoute.productId);
  const [operations, setOperations] = useState(initialRoute.operations);
  const products = useMemo(() => offers.length ? offers.map(toDemoProduct) : computeDemoProducts, [offers]);
  const selectedProduct = products.find((product) => product.id === productId) ?? null;

  useEffect(() => {
    const handlePopState = () => {
      const route = readComputeRoute(window.location.href);
      setTab(route.tab);
      setProductId(route.productId);
      setOperations(route.operations);
      scrollComputeToTop();
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = (nextTab: ComputeTab, nextProductId: string | null = null) => {
    const url = new URL("/compute", window.location.origin);
    url.searchParams.set("demo", "1");
    if (nextTab !== "home") url.searchParams.set("tab", nextTab);
    if (nextProductId) url.searchParams.set("offer", nextProductId);
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setTab(nextTab);
    setProductId(nextProductId);
    setOperations(false);
    scrollComputeToTop();
  };

  const openOperations = () => {
    const url = new URL("/compute", window.location.origin);
    url.searchParams.set("demo", "1");
    url.searchParams.set("tab", "mine");
    url.searchParams.set("view", "operations");
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
    setTab("mine");
    setProductId(null);
    setOperations(true);
    scrollComputeToTop();
  };

  return (
    <div className="compute-demo-app" data-platform={platform}>
      <aside className="compute-v2-sidebar">
        <button className="compute-v2-brand" type="button" onClick={() => navigate("home")}><i><Lightning weight="fill" /></i><span><strong>COD</strong><small>算力市场</small></span></button>
        <nav aria-label="算力市场主导航">{navItems.map((item) => { const Icon=item.icon; return <button type="button" className={tab === item.id && !productId && !operations ? "active" : ""} onClick={() => navigate(item.id)} key={item.id}><Icon weight={tab === item.id && !operations ? "fill" : "regular"} /><span>{item.label}</span></button>; })}</nav>
        <button className={`compute-v2-operations-nav${operations ? " active" : ""}`} type="button" onClick={openOperations}><ChartBar weight={operations ? "fill" : "regular"} /><span><strong>经营看板</strong><small>管理视角</small></span></button>
        <section><small>可用卡时</small><strong>1,286.5</strong></section>
        <button className="compute-v2-exit" type="button" onClick={onExit}><ArrowLeft /> 返回 COD 工作区</button>
      </aside>
      <div className="compute-v2-shell">
        <header className="compute-v2-topbar"><button className="compute-v2-mobile-brand" type="button" onClick={() => navigate("home")}><Lightning weight="fill" /><strong>COD 算力</strong></button><div><span>演示数据</span><button type="button" aria-label="通知"><Bell /></button>{session ? <button type="button" className="compute-v2-user"><UserCircle weight="fill" /> {session.account.displayName}</button> : <button type="button" className="compute-v2-login" onClick={() => onRequireLogin(window.location.href)}>登录</button>}</div></header>
        <main className="compute-v2-main">{operations ? <OperationsDashboard onBack={() => navigate("mine")} /> : selectedProduct ? <ProductDetail product={selectedProduct} onBack={() => navigate("home")} /> : tab === "home" ? <HomePage products={products} onOpenProduct={(id) => navigate("home", id)} onNavigate={(nextTab) => navigate(nextTab)} /> : tab === "hosting" ? <HostingPage /> : tab === "news" ? <NewsPage /> : tab === "ranking" ? <RankingPage /> : <MinePage session={session} onRequireLogin={() => onRequireLogin(window.location.href)} onOpenOperations={openOperations} />}</main>
        {!selectedProduct && !operations && <nav className="compute-v2-bottom-nav" aria-label="算力市场底部导航">{navItems.map((item) => { const Icon=item.icon; return <button type="button" className={tab === item.id ? "active" : ""} onClick={() => navigate(item.id)} key={item.id}><Icon weight={tab === item.id ? "fill" : "regular"} /><span>{item.label}</span></button>; })}</nav>}
      </div>
    </div>
  );
}

export interface ComputeDemoProduct {
  id: string;
  title: string;
  gpuModel: string;
  gpuMemory: string;
  price: number;
  image: string;
  imageTone: "jade" | "blue" | "graphite";
  badge: string;
  region: string;
  availability: string;
  tags: string[];
  specs: {
    cpu: string;
    memory: string;
    system: string;
    cuda: string;
  };
  images: Array<{ id: string; name: string; detail: string }>;
}

export const computeDemoProducts: ComputeDemoProduct[] = [
  {
    id: "b300-sxm-288",
    title: "B300 SXM 超大显存训练卡",
    gpuModel: "NVIDIA B300 SXM",
    gpuMemory: "288GB HBM3e",
    price: 44.0,
    image: "/compute/gpu-h200.svg",
    imageTone: "jade",
    badge: "旗舰算力",
    region: "华北 A 区",
    availability: "现货 16 卡 · 支持集群交付",
    tags: ["超大模型训练", "Blackwell", "高速互联"],
    specs: {
      cpu: "Intel 8573C · 64 核",
      memory: "768GB DDR5",
      system: "Ubuntu 24.04",
      cuda: "CUDA 13.0",
    },
    images: [
      { id: "pytorch", name: "PyTorch 2.8", detail: "Python 3.12 · CUDA 13.0" },
      { id: "vllm", name: "vLLM 0.10", detail: "推理环境 · CUDA 13.0" },
    ],
  },
  {
    id: "h200-sxm-141",
    title: "H200 SXM 高性能训练卡",
    gpuModel: "NVIDIA H200 SXM",
    gpuMemory: "141GB HBM3e",
    price: 26.0,
    image: "/compute/gpu-h200.svg",
    imageTone: "jade",
    badge: "热门",
    region: "华北 A 区",
    availability: "现货 24 卡 · 最快 10 分钟交付",
    tags: ["大模型训练", "NVLink", "高速存储"],
    specs: {
      cpu: "Intel 8468 · 48 核",
      memory: "512GB DDR5",
      system: "Ubuntu 22.04",
      cuda: "CUDA 12.4",
    },
    images: [
      { id: "pytorch", name: "PyTorch 2.5", detail: "Python 3.11 · CUDA 12.4" },
      { id: "vllm", name: "vLLM 0.7", detail: "推理环境 · CUDA 12.4" },
      { id: "blank", name: "纯净镜像", detail: "Ubuntu 22.04 · CUDA 12.4" },
    ],
  },
  {
    id: "h100-sxm-80",
    title: "H100 SXM 专享实例",
    gpuModel: "NVIDIA H100 SXM",
    gpuMemory: "80GB HBM3",
    price: 20.0,
    image: "/compute/gpu-h100.svg",
    imageTone: "blue",
    badge: "稳定供给",
    region: "华东 B 区",
    availability: "现货 36 卡 · 支持按日续租",
    tags: ["模型微调", "专享实例", "100Gb 网络"],
    specs: {
      cpu: "AMD EPYC 9654 · 48 核",
      memory: "384GB DDR5",
      system: "Ubuntu 22.04",
      cuda: "CUDA 12.2",
    },
    images: [
      { id: "pytorch", name: "PyTorch 2.4", detail: "Python 3.10 · CUDA 12.2" },
      { id: "tensorflow", name: "TensorFlow 2.17", detail: "Python 3.10 · CUDA 12.2" },
    ],
  },
  {
    id: "a800-pcie-80",
    title: "A800 PCIe 推理实例",
    gpuModel: "NVIDIA A800 PCIe",
    gpuMemory: "80GB HBM2e",
    price: 12.0,
    image: "/compute/gpu-a800.svg",
    imageTone: "graphite",
    badge: "性价比",
    region: "西南 C 区",
    availability: "现货 52 卡 · 支持弹性扩容",
    tags: ["在线推理", "弹性扩容", "按量计费"],
    specs: {
      cpu: "Intel 8358 · 32 核",
      memory: "256GB DDR4",
      system: "Ubuntu 20.04",
      cuda: "CUDA 11.8",
    },
    images: [
      { id: "vllm", name: "vLLM 0.6", detail: "Python 3.10 · CUDA 11.8" },
      { id: "blank", name: "纯净镜像", detail: "Ubuntu 20.04 · CUDA 11.8" },
    ],
  },
  {
    id: "4090-24",
    title: "RTX 4090 创作与开发卡",
    gpuModel: "NVIDIA RTX 4090",
    gpuMemory: "24GB GDDR6X",
    price: 4.8,
    image: "/compute/gpu-4090.svg",
    imageTone: "jade",
    badge: "开发首选",
    region: "华南 D 区",
    availability: "现货 68 卡 · 5 分钟快速开机",
    tags: ["模型开发", "图像生成", "快速开机"],
    specs: {
      cpu: "AMD 7950X · 16 核",
      memory: "128GB DDR5",
      system: "Ubuntu 22.04",
      cuda: "CUDA 12.1",
    },
    images: [
      { id: "comfy", name: "ComfyUI", detail: "常用插件预装 · CUDA 12.1" },
      { id: "pytorch", name: "PyTorch 2.3", detail: "Python 3.10 · CUDA 12.1" },
    ],
  },
  {
    id: "l40s-48",
    title: "L40S 推理与生成式 AI 实例",
    gpuModel: "NVIDIA L40S",
    gpuMemory: "48GB GDDR6",
    price: 7.7,
    image: "/compute/gpu-a800.svg",
    imageTone: "blue",
    badge: "推理推荐",
    region: "西南 C 区",
    availability: "现货 44 卡 · 支持弹性扩容",
    tags: ["生成式 AI", "模型推理", "专业渲染"],
    specs: {
      cpu: "AMD EPYC 9454 · 32 核",
      memory: "256GB DDR5",
      system: "Ubuntu 22.04",
      cuda: "CUDA 12.8",
    },
    images: [
      { id: "vllm", name: "vLLM 0.9", detail: "Python 3.11 · CUDA 12.8" },
      { id: "comfy", name: "ComfyUI", detail: "常用插件预装 · CUDA 12.8" },
    ],
  },
  {
    id: "rtx-5090-32",
    title: "RTX 5090 创作与推理实例",
    gpuModel: "NVIDIA RTX 5090",
    gpuMemory: "32GB GDDR7",
    price: 7.0,
    image: "/compute/gpu-4090.svg",
    imageTone: "graphite",
    badge: "创作旗舰",
    region: "华南 D 区",
    availability: "现货 38 卡 · 5 分钟快速开机",
    tags: ["图像生成", "视频渲染", "模型推理"],
    specs: {
      cpu: "AMD 9950X · 16 核",
      memory: "128GB DDR5",
      system: "Ubuntu 24.04",
      cuda: "CUDA 12.8",
    },
    images: [
      { id: "comfy", name: "ComfyUI", detail: "视频与图像工作流 · CUDA 12.8" },
      { id: "pytorch", name: "PyTorch 2.7", detail: "Python 3.11 · CUDA 12.8" },
    ],
  },
];

export const computeDemoNews = [
  { category: "行业", title: "从训练到推理：企业如何规划弹性 GPU 资源", date: "08-12", read: "6 分钟" },
  { category: "平台", title: "COD 华东 B 区新增 H100 资源池", date: "08-09", read: "3 分钟" },
  { category: "技术", title: "大模型多机训练的网络与存储配置清单", date: "08-05", read: "8 分钟" },
  { category: "案例", title: "动画工作室如何把渲染等待时间缩短 62%", date: "07-28", read: "5 分钟" },
];

export const computeDemoRanking = [
  { rank: 1, name: "华北智算一号", model: "H200 SXM", availability: "99.98%", score: 98.6 },
  { rank: 2, name: "长三角训练集群", model: "H100 SXM", availability: "99.96%", score: 97.8 },
  { rank: 3, name: "西南推理中心", model: "A800 PCIe", availability: "99.91%", score: 96.9 },
  { rank: 4, name: "大湾区创作云", model: "RTX 4090", availability: "99.87%", score: 95.4 },
];

export const computeOperationsDemo = {
  period: "2026 年 8 月经营数据",
  metrics: [
    { label: "可调度 GPU", value: "184", detail: "覆盖 4 个资源区域" },
    { label: "资源利用率", value: "76.4%", detail: "较上周提升 3.8%" },
    { label: "本月成交额", value: "¥286,400", detail: "已确认与交付中订单" },
    { label: "交付中订单", value: "7", detail: "平均交付用时 5.6 小时" },
  ],
  regions: [
    { name: "成都", resource: "H100 / H200", cards: 56, utilization: "81.2%" },
    { name: "贵阳", resource: "L40S / A800", cards: 48, utilization: "74.8%" },
    { name: "乌兰察布", resource: "RTX 4090", cards: 40, utilization: "69.5%" },
    { name: "杭州", resource: "H100 / L20", cards: 40, utilization: "77.1%" },
  ],
  pipeline: [
    { label: "待需求核验", value: 12, tone: "cool" },
    { label: "资源匹配中", value: 8, tone: "active" },
    { label: "等待客户确认", value: 5, tone: "warning" },
    { label: "部署与交付", value: 7, tone: "active" },
  ],
  deals: [
    { customer: "澄海模型实验室", resource: "H100 SXM 8 卡", scale: "2,400 卡时", amount: "¥45,120", status: "已确认", tone: "confirmed" },
    { customer: "山岚视觉科技", resource: "L40S 16 卡", scale: "7,200 卡时", amount: "¥46,080", status: "部署中", tone: "deploying" },
    { customer: "云杉智能制造", resource: "RTX 4090 8 卡", scale: "1,440 卡时", amount: "¥8,496", status: "运行中", tone: "running" },
  ],
} as const;

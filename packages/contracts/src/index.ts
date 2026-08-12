export type TaskStatus = 'draft' | 'running' | 'waiting' | 'complete' | 'failed' | 'cancelled';

export interface CodTask {
  id: string;
  title: string;
  project: string;
  status: TaskStatus;
  updatedAt: string;
}

export interface WorkspaceFile {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  depth: number;
}

export interface TerminalResult {
  command: string;
  output: string;
  exitCode: number | null;
}

export interface AccountSummary {
  userId: string;
  displayName: string;
  balanceCents: number;
  currency: 'CNY';
  plan: 'developer' | 'team';
  role: 'member' | 'admin';
  billingExempt: boolean;
}

export interface UsageEvent {
  idempotencyKey: string;
  taskId: string;
  sourceId: string;
  upstreamSourceId?: string;
  paymentDirection: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  commissionRateBps?: number;
  commissionCents?: number;
}

export type ComputeRequestKind = 'rental' | 'supply' | 'installment' | 'hosting';

export type ComputeRequestStatus =
  | 'submitted'
  | 'contacting'
  | 'quoted'
  | 'approved'
  | 'deploying'
  | 'running'
  | 'action_required'
  | 'completed'
  | 'closed';

export type ComputeFulfillmentMode = 'manual-confirmation' | 'third-party-manual-match';

export interface ComputeQuote {
  amountCents: number;
  currency: 'CNY';
  cardHoursMilli: number | null;
  validUntil: string;
  terms: string;
  createdAt: string;
}

export interface ComputeQuoteInput {
  amountCents: number;
  cardHoursMilli?: number | null;
  validUntil: string;
  terms: string;
}

export type ComputeQuoteDecision = 'accepted' | 'declined';

export interface ComputeImageOption {
  id: string;
  name: string;
  frameworkVersion: string;
  pythonVersion: string;
  cudaVersion: string;
}

export interface ComputeHardwareSpecs {
  cpuModel: string;
  cpuCores: number;
  memoryGb: number;
  systemDiskGb: number;
  dataDiskGb: number;
  expandableDataDiskGb: number;
  driverVersion: string;
  cudaMaxVersion: string;
}

export interface ComputeOffer {
  id: string;
  title: string;
  gpuModel: string;
  gpuMemoryGb: number;
  gpuCount: number;
  region: string;
  provider: string;
  priceCents: number | null;
  priceUnit: 'card-hour' | 'server-hour' | 'month' | 'quote';
  minimumUnits: number;
  delivery: string;
  network: string;
  availability: 'ready' | 'limited' | 'quote';
  inventoryCards: number | null;
  verified: boolean;
  tags: string[];
  specs: ComputeHardwareSpecs;
  images: ComputeImageOption[];
  supportedPeriods: Array<'hour' | 'day' | 'month'>;
  fulfillmentMode: ComputeFulfillmentMode;
}

/**
 * A manually reviewed compute-market request. Hosting requests describe
 * hardware that the customer wants an independent provider to host; they do
 * not represent acceptance, custody, financing, or a service commitment by
 * COD.
 */
export interface ComputeRequestInput {
  kind: ComputeRequestKind;
  offerId?: string | null;
  imageId?: string | null;
  company: string;
  contactName: string;
  contactPhone: string;
  city: string;
  gpuModel: string;
  quantity: number;
  durationHours?: number | null;
  termMonths?: number | null;
  requirements: string;
  hostingPeriodMonths?: number | null;
  rackUnits?: number | null;
  powerKilowatts?: number | null;
  networkMbps?: number | null;
  availabilityNotes?: string | null;
  settlementPreference?: string | null;
  hostingRequirements?: string | null;
}

export interface ComputeRequest extends ComputeRequestInput {
  id: string;
  email: string;
  offerId: string | null;
  imageId: string | null;
  durationHours: number | null;
  termMonths: number | null;
  hostingPeriodMonths: number | null;
  rackUnits: number | null;
  powerKilowatts: number | null;
  networkMbps: number | null;
  availabilityNotes: string | null;
  settlementPreference: string | null;
  hostingRequirements: string | null;
  fulfillmentMode: ComputeFulfillmentMode;
  quote: ComputeQuote | null;
  quoteDecision: ComputeQuoteDecision | null;
  quoteDecisionAt: string | null;
  status: ComputeRequestStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AdminComputeRequestSummary {
  id: string;
  kind: ComputeRequestKind;
  company: string;
  gpuModel: string;
  quantity: number;
  status: ComputeRequestStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AdminComputeRequestPage {
  items: AdminComputeRequestSummary[];
  nextCursor: string | null;
}

export interface DeviceRecord {
  id: string;
  name: string;
  platform: 'macos' | 'windows' | 'linux' | 'web' | 'mobile';
  status: 'online' | 'offline';
  lastSeenAt: string;
}

export interface KnowledgeHit {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  score: number;
}

export interface ProductManifest {
  id: string;
  name: string;
  launchUrl: string;
  embedUrl: string | null;
  allowedOrigins: string[];
  launchMode: 'external' | 'signed-sso';
}

export interface AgentGatewayConfig {
  token: string;
  sourceId: string;
  modelId: string;
  taskId: string;
  root: string;
  executionId: string;
  leaseToken: string;
}

export type DesktopPetStatusReason = 'ready' | 'not-installed' | 'integrity-failed' | 'unsupported';

export interface DesktopPetStatus {
  supported: boolean;
  installed: boolean;
  verified: boolean;
  running: boolean;
  version: string | null;
  publisherVerified: boolean;
  reason: DesktopPetStatusReason;
}

export interface DesktopPetLaunchConfig {
  token: string;
  sourceId: string;
  modelId: string;
}

export interface DesktopPetLaunchResult {
  status: DesktopPetStatus;
  started: boolean;
  focusedExisting: boolean;
}

export interface DesktopBridge {
  platform: string;
  controlPlaneUrl: string;
  selectProject(): Promise<string | null>;
  listFiles(root: string): Promise<WorkspaceFile[]>;
  readTextFile(root: string, relativePath: string): Promise<string>;
  gitDiff(root: string): Promise<string>;
  runCommand(root: string, command: string): Promise<TerminalResult>;
  getGooseAcpUrl(config: AgentGatewayConfig): Promise<string | null>;
  stopGoose(): Promise<void>;
  getTaskboardUrl?(): Promise<string | null>;
  getDesktopPetStatus?(): Promise<DesktopPetStatus>;
  launchDesktopPet?(config: DesktopPetLaunchConfig): Promise<DesktopPetLaunchResult>;
  stopDesktopPet?(): Promise<DesktopPetStatus>;
}

declare global {
  interface Window {
    codDesktop?: DesktopBridge;
  }
}

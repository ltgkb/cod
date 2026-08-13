export type ComputePurchaseMode = 'instant' | 'reservation' | 'quote';
export type ComputeOfferStatus = 'draft' | 'published' | 'paused' | 'sold_out' | 'archived';
export type ComputeAvailabilityLevel = 'ready' | 'limited' | 'sold_out' | 'quote';
export type ComputeDeliveryMode = 'container' | 'virtual_machine' | 'bare_metal';
// V2 rental SKUs are settled by the hour. Hosting contract terms remain month-based.
export type ComputePeriod = 'hour';

export type ComputeOrderStatus =
  | 'draft' | 'reserved' | 'pending_quote' | 'quoted'
  | 'pending_settlement' | 'settled' | 'provisioning' | 'running'
  | 'action_required' | 'completed' | 'cancelled'
  | 'refund_pending' | 'refunded';

export type HostingApplicationStatus =
  | 'draft' | 'submitted' | 'reviewing' | 'site_survey'
  | 'quoted' | 'contract_pending' | 'inbound_pending'
  | 'deploying' | 'running' | 'action_required'
  | 'offboarding' | 'completed' | 'rejected' | 'cancelled';

export type HostedDeviceStatus =
  | 'pending_review' | 'deploying' | 'running'
  | 'action_required' | 'maintenance' | 'offline' | 'retired';

export type ComputeAdminRole = 'compute_operator' | 'super_admin';

export interface ComputePrincipal {
  userId: string;
  tenantId: string;
  email: string;
  role: 'member' | 'device_provider' | ComputeAdminRole;
}

export interface ComputeApiPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ComputeApiError {
  error: string;
  code: string;
  requestId: string;
  fieldErrors?: Record<string, string>;
  retryable?: boolean;
}

export interface ComputeCapabilities {
  enabled: boolean;
  instantPurchase: boolean;
  reservationPurchase: boolean;
  hosting: boolean;
  devices: boolean;
  assets: boolean;
  cardHourTrades: boolean;
  referrals: boolean;
  news: boolean;
  rankings: boolean;
  hostedSettlements: boolean;
  admin: boolean;
  services: {
    verification: boolean;
    procurement: boolean;
    coupons: boolean;
    addresses: boolean;
    onlineSupport: boolean;
    humanSupport: boolean;
  };
}

export interface ComputeHardwareSpecs {
  cpuModel: string;
  cpuCores: number | null;
  ramGb: number;
  systemDiskGb: number;
  dataDiskGb: number | null;
  driverVersion: string;
  cudaVersion: string;
  networkLabel: string;
}

export interface ComputeImageOption {
  id: string;
  label: string;
  framework: string;
  frameworkVersion: string;
  pythonVersion: string;
  cudaVersion: string;
}

export interface ComputeSkuV2 {
  id: string;
  offerId: string;
  deliveryMode: ComputeDeliveryMode;
  period: ComputePeriod;
  minimumUnits: number;
  maximumUnits: number | null;
  priceCardHoursMilli: number | null;
  compareAtPriceCardHoursMilli: number | null;
  imageOptions: ComputeImageOption[];
  inventoryRevision: number;
}

export interface ComputeOfferMedia {
  id: string;
  url: string;
  alt: string;
}

export interface ComputeOfferV2 {
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
  media: ComputeOfferMedia[];
  skus: ComputeSkuV2[];
  availability: { level: ComputeAvailabilityLevel; label: string };
  updatedAt: string;
}

export interface ComputeOfferFilters {
  gpuSeries?: string;
  gpuModel?: string;
  memoryGb?: number;
  useCase?: string;
  deliveryMode?: ComputeDeliveryMode;
  region?: string;
  cuda?: string;
  period?: ComputePeriod;
  availability?: Exclude<ComputeAvailabilityLevel, 'quote'> | 'quote';
  sort?: 'relevance' | 'price_asc' | 'price_desc' | 'memory' | 'popular';
  cursor?: string;
}

export interface ComputeHomePayload {
  banner: null | {
    availableCardHoursMilli?: number;
    activeOrderCount?: number;
    actionRequiredDeviceCount?: number;
  };
  quickActions: Array<'offers' | 'hosting' | 'orders' | 'support'>;
  featuredOffers: ComputeOfferV2[];
  news: ComputeNewsEntry[];
}

export interface ComputeQuoteV2 {
  subtotalCardHoursMilli: number;
  discountCardHoursMilli: number;
  chargedCardHoursMilli: number;
  validUntil: string;
  termsVersion: string;
  terms: string;
  createdAt: string;
}

export interface ComputeStatusEvent<TStatus extends string = string> {
  id: string;
  status: TStatus;
  label: string;
  note: string | null;
  actor: 'system' | 'user' | 'operator';
  createdAt: string;
}

export interface ComputeOrderV2 {
  id: string;
  tenantId: string;
  userId: string;
  skuId: string;
  skuSnapshot: {
    offerId: string;
    offerTitle: string;
    gpuModel: string;
    gpuMemoryGb: number;
    regionLabel: string;
    deliveryMode: ComputeDeliveryMode;
    period: ComputePeriod;
    imageLabel: string;
    unitPriceCardHoursMilli: number | null;
    inventoryRevision: number;
  };
  quantity: number;
  /** Resource entitlement duration per rented unit. This is not a card-hour balance or amount. */
  availableDurationHours: number;
  startsAt: string | null;
  contact: { name: string; phone: string };
  /** Monetary amounts denominated in COD card-hours, stored at milli precision. */
  subtotalCardHoursMilli: number;
  discountCardHoursMilli: number;
  chargedCardHoursMilli: number;
  status: ComputeOrderStatus;
  reservationExpiresAt: string | null;
  quote: ComputeQuoteV2 | null;
  termsVersion: string;
  events: Array<ComputeStatusEvent<ComputeOrderStatus>>;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateComputeOrderInput {
  skuId: string;
  imageId: string;
  quantity: number;
  availableDurationHours: number;
  startsAt: string | null;
  inventoryRevision: number;
  contact: { name: string; phone: string };
  acceptedTermsVersion: string;
}

export interface InventoryReservation {
  id: string;
  tenantId: string;
  userId: string;
  skuId: string;
  quantity: number;
  inventoryRevision: number;
  status: 'active' | 'consumed' | 'released' | 'expired';
  expiresAt: string;
  createdAt: string;
}

export interface HostingDeviceInput {
  brand: string;
  model: string;
  gpuModel: string;
  gpuCount: number;
  serialLastFour: string;
  machineSpecs: string;
  ownershipProofStatus: 'ready' | 'pending';
}

export interface HostingApplicationDraft {
  subjectType: 'individual' | 'enterprise';
  verificationStatus: 'verified' | 'pending' | 'unverified';
  contactName: string;
  contactPhone: string;
  city: string;
  devices: HostingDeviceInput[];
  rackUnits: number | null;
  powerWatts: number | null;
  networkRequirement: string;
  hostingMonths: number | null;
  availableFrom: string | null;
  slaRequirement: string;
  settlementPreference: string;
  responsibilityAccepted: boolean;
  privacyAccepted: boolean;
}

export interface HostingApplicationV2 extends HostingApplicationDraft {
  id: string;
  tenantId: string;
  userId: string;
  status: HostingApplicationStatus;
  events: Array<ComputeStatusEvent<HostingApplicationStatus>>;
  nextAction: string | null;
  responsibleParty: 'user' | 'cod' | 'partner' | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface HostedDeviceV2 {
  id: string;
  tenantId: string;
  userId: string;
  hostingApplicationId: string;
  name: string;
  gpuModel: string;
  gpuCount: number;
  regionLabel: string;
  status: HostedDeviceStatus;
  lastHeartbeatAt: string | null;
  availability24hPercent: number | null;
  actionRequired: string | null;
  events: Array<ComputeStatusEvent<HostedDeviceStatus>>;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ComputeTicket {
  id: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  category: 'incident' | 'maintenance' | 'offboarding' | 'other';
  subject: string;
  description: string;
  status: 'open' | 'in_progress' | 'waiting_user' | 'resolved' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export interface ComputeAssetsSummary {
  availableCardHoursMilli: number;
  lockedCardHoursMilli: number;
  pendingHostedSettlementCardHoursMilli: number | null;
  availableHostedSettlementCardHoursMilli: number | null;
  settledHostedCardHoursMilli: number | null;
  runningResourceCount: number;
}

export type CardHourLedgerEntryType =
  | 'purchase' | 'reward' | 'rental_charge' | 'rental_refund'
  | 'hosting_settlement' | 'discount' | 'trade_lock' | 'trade_release' | 'trade_transfer';

export interface CardHourLedgerEntry {
  id: string;
  tenantId: string;
  userId: string;
  type: CardHourLedgerEntryType;
  availableDeltaCardHoursMilli: number;
  lockedDeltaCardHoursMilli: number;
  reference: string;
  createdAt: string;
}

export interface ReferralRecord {
  id: string;
  maskedInvitee: string;
  status: 'pending_condition' | 'pending_credit' | 'credited' | 'expired';
  rewardCardHoursMilli: number;
  createdAt: string;
}

export interface ComputeReferralPayload {
  inviteCode: string;
  inviteUrl: string;
  rule: string;
  records: ReferralRecord[];
}

export interface ComputeNewsEntry {
  id: string;
  slug: string;
  title: string;
  summary: string;
  coverUrl: string | null;
  category: string;
  sanitizedHtml: string;
  publishedAt: string;
}

export interface ComputeRankingEntry {
  rank: number;
  displayName: string;
  value: number;
  unit: string;
}

export interface ComputeRankingsPayload {
  enabled: boolean;
  metric: 'uptime_hours' | 'availability' | 'settled_card_hours' | 'service_quality';
  periodLabel: string;
  updatedAt: string;
  anonymous: boolean;
  entries: ComputeRankingEntry[];
}

export interface ComputeAdminDashboard {
  newOrders: number;
  pendingQuotes: number;
  pendingDeployments: number;
  runningInstances: number;
  actionRequiredDevices: number;
  expiringReservations: number;
  openTickets: number;
}

export interface ComputeAdminOfferRecord {
  offer: ComputeOfferV2;
  revision: number;
}

export interface ComputeInventoryPool {
  id: string;
  skuId: string;
  nodeLabel: string;
  facilityLabel: string;
  availableUnits: number;
  reservedUnits: number;
  allocatedUnits: number;
  maintenanceUnits: number;
  revision: number;
  updatedAt: string;
}

export interface ComputeContentRecord {
  entry: ComputeNewsEntry;
  status: 'draft' | 'scheduled' | 'published' | 'withdrawn';
  scheduledAt: string | null;
  revision: number;
}

export interface ComputeAuditEvent {
  id: string;
  tenantId: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: Record<string, string | number | boolean | null>;
  createdAt: string;
}

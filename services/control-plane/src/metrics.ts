const startedAt = Date.now();

interface MetricKey {
  method: string;
  route: string;
  status: number;
}

const requests = new Map<string, { key: MetricKey; count: number; durationSeconds: number }>();
let inflight = 0;
let usageReservationLeaseFailures = 0;
let usageReservationsReaped = 0;

function normalizedRoute(pathname: string): string {
  return pathname
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
    .replace(/\/api\/(devices|tasks)\/[^/]+/g, '/api/$1/:id');
}

const escapeLabel = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export function beginRequest(): () => void {
  inflight += 1;
  let finished = false;
  return () => {
    if (!finished) inflight = Math.max(0, inflight - 1);
    finished = true;
  };
}

export function recordRequest(method: string, pathname: string, status: number, durationSeconds: number): void {
  const key = { method, route: normalizedRoute(pathname), status };
  const serialized = JSON.stringify(key);
  const current = requests.get(serialized) ?? { key, count: 0, durationSeconds: 0 };
  current.count += 1;
  current.durationSeconds += durationSeconds;
  requests.set(serialized, current);
}

export function recordUsageReservationLeaseFailure(): void {
  usageReservationLeaseFailures += 1;
}

export function recordUsageReservationsReaped(count: number): void {
  if (Number.isSafeInteger(count) && count > 0) usageReservationsReaped += count;
}

export function renderMetrics(databaseReady: boolean): string {
  const lines = [
    '# HELP cod_process_uptime_seconds Control-plane process uptime.',
    '# TYPE cod_process_uptime_seconds gauge',
    `cod_process_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
    '# HELP cod_http_requests_inflight Current in-flight HTTP requests.',
    '# TYPE cod_http_requests_inflight gauge',
    `cod_http_requests_inflight ${inflight}`,
    '# HELP cod_database_ready Database readiness state.',
    '# TYPE cod_database_ready gauge',
    `cod_database_ready ${databaseReady ? 1 : 0}`,
    '# HELP cod_http_requests_total Completed HTTP requests.',
    '# TYPE cod_http_requests_total counter',
    '# HELP cod_usage_reservation_lease_failures_total Usage calls aborted after reservation lease renewal failed.',
    '# TYPE cod_usage_reservation_lease_failures_total counter',
    `cod_usage_reservation_lease_failures_total ${usageReservationLeaseFailures}`,
    '# HELP cod_usage_reservations_reaped_total Expired usage reservations released and refunded.',
    '# TYPE cod_usage_reservations_reaped_total counter',
    `cod_usage_reservations_reaped_total ${usageReservationsReaped}`,
  ];
  for (const metric of requests.values()) {
    const labels = `method="${escapeLabel(metric.key.method)}",route="${escapeLabel(metric.key.route)}",status="${metric.key.status}"`;
    lines.push(`cod_http_requests_total{${labels}} ${metric.count}`);
    lines.push(`cod_http_request_duration_seconds_sum{${labels}} ${metric.durationSeconds.toFixed(6)}`);
    lines.push(`cod_http_request_duration_seconds_count{${labels}} ${metric.count}`);
  }
  return `${lines.join('\n')}\n`;
}

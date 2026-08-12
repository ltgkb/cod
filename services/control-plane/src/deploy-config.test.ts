import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('production proxy privacy', () => {
  it('logs administrator compute routes without URL arguments', () => {
    const httpConfig = readFileSync(new URL('../../../deploy/nginx-http.conf', import.meta.url), 'utf8');
    const serverConfig = readFileSync(new URL('../../../deploy/cod.nginx.conf', import.meta.url), 'utf8');
    const format = httpConfig.match(/log_format\s+cod_no_args\s+([\s\S]*?);/)?.[1] ?? '';
    const adminLocation = serverConfig.match(/location \^~ \/api\/admin\/compute\/requests\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? '';

    expect(format).toContain('$request_method $uri $server_protocol');
    expect(format).not.toMatch(/\$request(?:\s|['"])/);
    expect(format).not.toContain('$request_uri');
    expect(format).not.toContain('$args');
    expect(adminLocation).toContain('access_log /var/log/nginx/access.log cod_no_args;');
    expect(adminLocation).toContain('proxy_pass http://127.0.0.1:8787;');
  });
});

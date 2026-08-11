import assert from 'node:assert/strict';
import test from 'node:test';

import {
  controlPlanePort,
  resolveDesktopDevelopmentEndpoints,
  resolveDesktopDevelopmentProcessEnvironments,
} from '../../../scripts/desktop-dev-config.mjs';

test('desktop development defaults stay on separate loopback origins', () => {
  const { renderer, controlPlane } = resolveDesktopDevelopmentEndpoints();
  assert.equal(renderer.origin, 'http://127.0.0.1:5173');
  assert.equal(controlPlane.origin, 'http://127.0.0.1:8787');
  assert.equal(controlPlanePort(controlPlane), '8787');
});

test('desktop development accepts explicit loopback ports', () => {
  const { renderer, controlPlane } = resolveDesktopDevelopmentEndpoints({
    COD_DEV_SERVER_URL: 'http://localhost:15173',
    COD_DEV_CONTROL_PLANE_URL: 'http://127.0.0.1:18787',
  });
  assert.equal(renderer.origin, 'http://localhost:15173');
  assert.equal(controlPlane.origin, 'http://127.0.0.1:18787');
});

test('desktop development refuses remote, credentialed, and shared origins', () => {
  assert.throws(() => resolveDesktopDevelopmentEndpoints({ COD_DEV_CONTROL_PLANE_URL: 'https://cod.kai.com' }), /must use HTTP/);
  assert.throws(() => resolveDesktopDevelopmentEndpoints({ COD_DEV_CONTROL_PLANE_URL: 'http://192.0.2.1:8787' }), /loopback host/);
  assert.throws(() => resolveDesktopDevelopmentEndpoints({ COD_DEV_CONTROL_PLANE_URL: 'http://user:secret@127.0.0.1:8787' }), /without credentials/);
  assert.throws(() => resolveDesktopDevelopmentEndpoints({ COD_DEV_CONTROL_PLANE_URL: 'http://127.0.0.1:5173' }), /different origins/);
});

test('desktop development defaults to memory and removes inherited production secrets', () => {
  const { shared, controlPlane } = resolveDesktopDevelopmentProcessEnvironments({
    NODE_ENV: 'test',
    PATH: '/safe/bin',
    DATABASE_URL: 'postgresql://production.example/cod',
    COD_SESSION_SECRET: 'production-session-secret',
    COD_PAYMENT_WEBHOOK_SECRET: 'production-payment-secret',
    KAI_API_KEY: 'production-api-key',
    COD_DEV_DATABASE_URL: '',
  });

  assert.equal(shared.NODE_ENV, 'development');
  assert.equal(shared.PATH, '/safe/bin');
  assert.equal('DATABASE_URL' in shared, false);
  assert.equal('COD_SESSION_SECRET' in shared, false);
  assert.equal('COD_PAYMENT_WEBHOOK_SECRET' in shared, false);
  assert.equal('KAI_API_KEY' in shared, false);
  assert.equal('COD_DEV_DATABASE_URL' in shared, false);
  assert.equal('DATABASE_URL' in controlPlane, false);
  assert.equal(controlPlane.COD_SESSION_SECRET, 'cod-local-development-secret');
  assert.equal('COD_PAYMENT_WEBHOOK_SECRET' in controlPlane, false);
  assert.equal('KAI_API_KEY' in controlPlane, false);
});

test('desktop development maps only the explicit developer database into the control plane', () => {
  const { shared, controlPlane } = resolveDesktopDevelopmentProcessEnvironments({
    PATH: '/safe/bin',
    DATABASE_URL: 'postgresql://production.example/cod',
    COD_DEV_DATABASE_URL: 'postgresql://127.0.0.1/cod_development',
  });

  assert.equal('DATABASE_URL' in shared, false);
  assert.equal('COD_DEV_DATABASE_URL' in shared, false);
  assert.equal(controlPlane.DATABASE_URL, 'postgresql://127.0.0.1/cod_development');
  assert.equal('COD_DEV_DATABASE_URL' in controlPlane, false);
});

test('desktop development clears complete production integration groups without creating partial configurations', () => {
  const productionLikeEnvironment = {
    PATH: '/safe/bin',
    DATABASE_URL: 'postgresql://production.example/cod',
    COD_SESSION_SECRET: 'production-session-secret',
    COD_REGISTRATION_ENABLED: 'false',
    COD_ALLOWED_EMAIL_DOMAINS: 'production.example',
    COD_PAYMENT_PUBLIC_BASE_URL: 'https://cod.production.example',
    COD_PAYMENT_WEBHOOK_SECRET: 'production-payment-secret',
    COD_WECHAT_PAY_MCH_ID: 'production-merchant',
    COD_WECHAT_PAY_APP_ID: 'production-app',
    COD_WECHAT_PAY_SERIAL_NO: 'production-serial',
    COD_WECHAT_PAY_PRIVATE_KEY_PATH: '/production/wechat-private.pem',
    COD_WECHAT_PAY_API_V3_KEY: 'production-v3-key',
    COD_WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH: '/production/wechat-platform.pem',
    COD_WECHAT_PAY_PLATFORM_SERIAL_NO: 'production-platform-serial',
    COD_ALIPAY_APP_ID: 'production-alipay-app',
    COD_ALIPAY_SELLER_ID: 'production-alipay-seller',
    COD_ALIPAY_PRIVATE_KEY_PATH: '/production/alipay-private.pem',
    COD_ALIPAY_PUBLIC_KEY_PATH: '/production/alipay-public.pem',
    COD_ALIPAY_GATEWAY_URL: 'https://production-alipay.example',
    COD_FEISHU_VERIFICATION_TOKEN: 'production-feishu-verification',
    COD_FEISHU_ENCRYPT_KEY: 'production-feishu-encryption',
    COD_FEISHU_APP_ID: 'production-feishu-app',
    COD_FEISHU_APP_SECRET: 'production-feishu-secret',
    COD_FEISHU_BINDINGS_JSON: '{"production":"binding"}',
    COD_MODEL_SOURCES_JSON: '[{"id":"production"}]',
    KAI_API_KEY: 'production-model-key',
    KAI_AI_BASE_URL: 'https://production-ai.example/v1',
    KAI_AI_CATALOG_URL: 'https://production-ai.example/catalog',
    KAI_AI_STATUS_URL: 'https://production-ai.example/status',
    KAI_WIKI_BASE_URL: 'https://production-wiki.example',
    KAI_WIKI_SEARCH_ENDPOINT: 'https://production-wiki.example/search',
    KAI_WIKI_API_KEY: 'production-wiki-key',
    KAI_HONGKONG_BASE_URL: 'https://production-hongkong.example',
    KAI_HONGKONG_EMBED_ENABLED: 'true',
    KAI_HONGKONG_SSO_SECRET: 'production-hongkong-secret',
    COD_GOOSE_ACP_URL: 'wss://production-goose.example/acp',
    COD_GOOSE_ACP_TOKEN: 'production-goose-token',
    COD_GOOSE_BINARY: '/safe/local/goose',
    VITE_COD_CONTROL_PLANE_URL: 'https://cod.production.example',
    EXPO_PUBLIC_COD_CONTROL_PLANE_URL: 'https://cod.production.example',
    TOKEN_RETAIL_COMMISSION_RATE_BPS: '500',
    CHASE_COMMISSION_RATE_BPS: '500',
    GOOSE_SERVER__SECRET_KEY: 'production-goose-server-secret',
  };

  const { shared, controlPlane } = resolveDesktopDevelopmentProcessEnvironments(productionLikeEnvironment);
  for (const name of Object.keys(productionLikeEnvironment)) {
    if (name === 'PATH' || name === 'COD_GOOSE_BINARY') continue;
    assert.equal(name in shared, false, `${name} must not reach renderer or Electron development processes`);
    if (name !== 'COD_SESSION_SECRET') {
      assert.equal(name in controlPlane, false, `${name} must not reach the local control plane`);
    }
  }
  assert.equal(shared.PATH, '/safe/bin');
  assert.equal(shared.COD_GOOSE_BINARY, '/safe/local/goose');
  assert.equal(controlPlane.COD_GOOSE_BINARY, '/safe/local/goose');
  assert.equal(controlPlane.COD_SESSION_SECRET, 'cod-local-development-secret');
  assert.equal('DATABASE_URL' in controlPlane, false);
});

test('desktop development cannot be launched with a production environment', () => {
  assert.throws(
    () => resolveDesktopDevelopmentProcessEnvironments({ NODE_ENV: 'production' }),
    /cannot run with NODE_ENV=production/,
  );
});

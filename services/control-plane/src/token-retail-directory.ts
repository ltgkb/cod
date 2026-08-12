/**
 * Token 石油零售站目录。
 *
 * Source: https://team.kai.com/#oil
 * Snapshot: 2026-08-11
 *
 * These domains are display and attribution aliases. Model traffic continues
 * to use the shared ai.kai.com upstream configured by the control plane.
 */
const tokenRetailDirectorySnapshot = [
  '135.kai.com',
  'account.kai.com',
  'ander.kai.com',
  'api-mandow.kai.com',
  'arthur-token.kai.com',
  'azureai.kai.com',
  'chaimaa-token.kai.com',
  'chase.kai.com',
  'chen.kai.com',
  'cloud.kai.com',
  'cloudpay.kai.com',
  'compare.kai.com',
  'daniel.kai.com',
  'db.kai.com',
  'dubai.kai.com',
  'edu.kai.com',
  'ehenhugh.kai.com',
  'elara.kai.com',
  'elowen-token.kai.com',
  'eudora.kai.com',
  'evan.kai.com',
  'eyad-token.kai.com',
  'eyad.kai.com',
  'feng.kai.com',
  'fox.kai.com',
  'gangya.kai.com',
  'gangyas.kai.com',
  'haohan.kai.com',
  'hipaddi.kai.com',
  'hongkong.kai.com',
  'huorin.kai.com',
  'isabella.kai.com',
  'jack.kai.com',
  'jasper.kai.com',
  'jax.kai.com',
  'jiang.kai.com',
  'jidong.kai.com',
  'jie.kai.com',
  'junson.kai.com',
  'kai-federation.kai.com',
  'kali.kai.com',
  'kami.kai.com',
  'kcrf.kai.com',
  'ken.kai.com',
  'kevin.kai.com',
  'klaw.kai.com',
  'kod.kai.com',
  'ladder.kai.com',
  'leo.kai.com',
  'ling.kai.com',
  'london.kai.com',
  'mandowtoken.kai.com',
  'marcus.kai.com',
  'ming.kai.com',
  'nianhong.kai.com',
  'nie.kai.com',
  'nova.kai.com',
  'oceanai.kai.com',
  'oldcoin.kai.com',
  'openapi.kai.com',
  'paddi.kai.com',
  'pmai.kai.com',
  'pod-market.kai.com',
  'pod.kai.com',
  'pony-token.kai.com',
  'portal.kai.com',
  'pricescout.kai.com',
  'qiu.kai.com',
  'seven.kai.com',
  'simon-token.kai.com',
  'staging-pmai.kai.com',
  'starport.kai.com',
  'stats.kai.com',
  'steve.kai.com',
  'stevetoken.kai.com',
  'string.kai.com',
  'supplier.kai.com',
  'tokenmath.kai.com',
  'trade.kai.com',
  'u.kai.com',
  'white.kai.com',
  'xiaohao.kai.com',
  'yuan.kai.com',
  'yue.kai.com',
  'zachery-token.kai.com',
  'zmt.kai.com',
  'hashrate.kai.com',
  'authtest.kai.com',
] as const;

export const nonPublicTokenRetailDomains = ['staging-pmai.kai.com', 'authtest.kai.com'] as const;
const nonPublicTokenRetailDomainSet = new Set<string>(nonPublicTokenRetailDomains);

// Test and pre-production aliases remain documented in the upstream snapshot,
// but must never become selectable billing or attribution sources in COD.
export const tokenRetailDomains = tokenRetailDirectorySnapshot.filter((domain) => !nonPublicTokenRetailDomainSet.has(domain));

export function tokenRetailSourceId(domain: string): string {
  if (!/^[a-z0-9-]+\.kai\.com$/.test(domain)) throw new Error(`Invalid Token retail domain: ${domain}`);
  const sourceId = `${domain.slice(0, -'.kai.com'.length)}-kai`;
  if (!/^[a-z0-9-]{2,40}$/.test(sourceId)) throw new Error(`Invalid Token retail source id: ${sourceId}`);
  return sourceId;
}

import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const ALLOWLIST_PATH = 'security/npm-audit-allowlist.json';
const PINNED_REVIEW_EXPIRY = '2026-09-11';
const PINNED_PRODUCTION_WORKSPACES = ['@cod/control-plane', '@cod/web'];
const PINNED_MITIGATION_PATHS = [
  'apps/mobile/metro.config.js',
  'apps/mobile/scripts/metro-security.test.cjs',
];
const PINNED_MITIGATION_TEST = [
  'node',
  '--test',
  'apps/mobile/scripts/metro-security.test.cjs',
];
const PINNED_ADVISORIES = [
  {
    source: 1138808,
    ghsa: 'GHSA-w3rx-r6r6-pgpr',
    url: 'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr',
    package: 'image-size',
    severity: 'high',
    range: '<=2.0.2',
  },
  {
    source: 1138809,
    ghsa: 'GHSA-5p2g-fcmc-qvqq',
    url: 'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq',
    package: 'image-size',
    severity: 'high',
    range: '<=2.0.2',
  },
];
const DEPENDENCY_TYPES = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
];

export class AuditGateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditGateError';
  }
}

function fail(message) {
  throw new AuditGateError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertSameStrings(actual, expected, label) {
  const actualSorted = sortedStrings(actual);
  const expectedSorted = sortedStrings(expected);
  assert(
    JSON.stringify(actualSorted) === JSON.stringify(expectedSorted),
    `${label} changed (expected ${expectedSorted.join(', ') || 'none'}; received ${actualSorted.join(', ') || 'none'})`,
  );
}

function advisoryIdentity(advisory) {
  return `${advisory.source}:${advisory.url}`;
}

function assertAdvisoryMatches(actual, expected, label) {
  for (const field of ['source', 'url', 'severity', 'range']) {
    assert(actual[field] === expected[field], `${label} ${field} changed`);
  }
  assert(actual.name === expected.package, `${label} package name changed`);
  assert(actual.dependency === expected.package, `${label} dependency name changed`);
}

export function validateAllowlist(allowlist) {
  assert(isObject(allowlist), 'Audit allowlist must be a JSON object');
  assert(allowlist.schemaVersion === 1, 'Unsupported audit allowlist schemaVersion');
  assert(
    allowlist.reviewExpiresOn === PINNED_REVIEW_EXPIRY,
    `Audit exception review date must remain pinned to ${PINNED_REVIEW_EXPIRY}`,
  );
  assertSameStrings(
    allowlist.productionWorkspaces ?? [],
    PINNED_PRODUCTION_WORKSPACES,
    'Production workspace scope',
  );

  assert(Array.isArray(allowlist.allowedAdvisories), 'allowedAdvisories must be an array');
  assert(allowlist.allowedAdvisories.length === PINNED_ADVISORIES.length, 'Exactly two advisories may be allowed');
  const configuredByIdentity = new Map(
    allowlist.allowedAdvisories.map((advisory) => [advisoryIdentity(advisory), advisory]),
  );
  assert(configuredByIdentity.size === PINNED_ADVISORIES.length, 'Allowed advisories must be unique');
  for (const expected of PINNED_ADVISORIES) {
    const configured = configuredByIdentity.get(advisoryIdentity(expected));
    assert(configured, `Required advisory ${expected.ghsa} is missing`);
    assert(configured.ghsa === expected.ghsa, `Advisory ${expected.source} GHSA changed`);
    assertAdvisoryMatches(
      {
        ...configured,
        name: configured.package,
        dependency: configured.package,
      },
      expected,
      `Advisory ${expected.ghsa}`,
    );
  }

  assert(Array.isArray(allowlist.affectedPackages), 'affectedPackages must be an array');
  assert(allowlist.affectedPackages.length > 0, 'affectedPackages cannot be empty');
  const packageNames = new Set();
  const packagePaths = new Set();
  for (const entry of allowlist.affectedPackages) {
    assert(isObject(entry), 'Each affected package must be an object');
    assert(typeof entry.name === 'string' && entry.name.length > 0, 'Affected package name is missing');
    assert(typeof entry.nodePath === 'string' && entry.nodePath.startsWith('node_modules/'), `Invalid node path for ${entry.name}`);
    assert(typeof entry.version === 'string' && entry.version.length > 0, `Version is missing for ${entry.name}`);
    assert(typeof entry.isDirect === 'boolean', `isDirect is missing for ${entry.name}`);
    assert(!packageNames.has(entry.name), `Duplicate affected package ${entry.name}`);
    assert(!packagePaths.has(entry.nodePath), `Duplicate affected node path ${entry.nodePath}`);
    packageNames.add(entry.name);
    packagePaths.add(entry.nodePath);
  }
  assert(packageNames.has('image-size'), 'image-size must be an affected package');

  assert(isObject(allowlist.lockfile), 'lockfile policy is missing');
  assert(allowlist.lockfile.lockfileVersion === 3, 'Only lockfileVersion 3 is supported');
  assert(isObject(allowlist.lockfile.imageSize), 'image-size lock policy is missing');
  assert(Array.isArray(allowlist.lockfile.dependencyChain), 'dependencyChain must be an array');
  assert(allowlist.lockfile.dependencyChain.length > 0, 'dependencyChain cannot be empty');

  assert(Array.isArray(allowlist.mitigations), 'mitigations must be an array');
  assertSameStrings(
    allowlist.mitigations.map((mitigation) => mitigation.path),
    PINNED_MITIGATION_PATHS,
    'Mitigation file set',
  );
  for (const mitigation of allowlist.mitigations) {
    assert(/^[a-f0-9]{64}$/.test(mitigation.sha256 ?? ''), `Invalid SHA-256 for ${mitigation.path}`);
  }
  assert(
    JSON.stringify(allowlist.mitigationTest?.command ?? []) === JSON.stringify(PINNED_MITIGATION_TEST),
    'Mitigation test command changed',
  );
}

export function validateReviewExpiry(reviewExpiresOn, now = new Date()) {
  const today = now instanceof Date ? now.toISOString().slice(0, 10) : now;
  assert(/^\d{4}-\d{2}-\d{2}$/.test(today), 'Current audit date must use YYYY-MM-DD');
  assert(today <= reviewExpiresOn, `Audit exception expired on ${reviewExpiresOn}; remove or re-review it`);
}

function validateAuditReportShape(report, label) {
  assert(isObject(report), `${label} did not return a JSON object`);
  assert(report.auditReportVersion === 2, `${label} did not return npm audit report version 2`);
  assert(isObject(report.vulnerabilities), `${label} has no vulnerabilities map`);
}

export function validateProductionAudit(report) {
  validateAuditReportShape(report, 'Production workspace audit');
  const blocking = Object.entries(report.vulnerabilities)
    .filter(([, vulnerability]) => ['high', 'critical'].includes(vulnerability?.severity))
    .map(([name]) => name);
  const metadata = report.metadata?.vulnerabilities;
  if (metadata) {
    assert(
      Number(metadata.high ?? 0) === 0 && Number(metadata.critical ?? 0) === 0,
      'Production workspace audit metadata reports high or critical vulnerabilities',
    );
  }
  assert(blocking.length === 0, `Production control-plane/Web dependencies contain: ${blocking.join(', ')}`);
}

function reachesImageSize(name, vulnerabilities, visiting = new Set()) {
  if (name === 'image-size') return true;
  if (visiting.has(name)) return false;
  const vulnerability = vulnerabilities[name];
  if (!vulnerability) return false;
  const nextVisiting = new Set(visiting);
  nextVisiting.add(name);
  const references = vulnerability.via.filter((via) => typeof via === 'string');
  return references.some((reference) => reachesImageSize(reference, vulnerabilities, nextVisiting));
}

export function validateFullAudit(report, allowlist) {
  validateAuditReportShape(report, 'Full dependency audit');
  const expectedByName = new Map(allowlist.affectedPackages.map((entry) => [entry.name, entry]));
  assertSameStrings(
    Object.keys(report.vulnerabilities),
    expectedByName.keys(),
    'Full audit affected package set',
  );

  const advisoryOccurrences = [];
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    const expected = expectedByName.get(name);
    assert(isObject(vulnerability), `Audit entry ${name} is invalid`);
    assert(vulnerability.severity === 'high', `Audit severity changed for ${name}`);
    assert(vulnerability.isDirect === expected.isDirect, `Direct dependency status changed for ${name}`);
    assert(Array.isArray(vulnerability.nodes), `Audit nodes are missing for ${name}`);
    assertSameStrings(vulnerability.nodes, [expected.nodePath], `Audit nodes for ${name}`);
    assert(Array.isArray(vulnerability.via) && vulnerability.via.length > 0, `Audit provenance is missing for ${name}`);

    for (const via of vulnerability.via) {
      if (typeof via === 'string') {
        assert(expectedByName.has(via), `${name} is affected through unexpected package ${via}`);
      } else {
        assert(isObject(via), `${name} contains invalid advisory provenance`);
        advisoryOccurrences.push({ holder: name, advisory: via });
      }
    }
  }

  const imageSizeVia = report.vulnerabilities['image-size'].via;
  assert(imageSizeVia.every((via) => isObject(via)), 'image-size may only be affected directly by the two pinned advisories');
  assert(
    advisoryOccurrences.every(({ holder }) => holder === 'image-size'),
    'Direct advisory provenance appeared outside image-size',
  );
  assert(advisoryOccurrences.length === allowlist.allowedAdvisories.length, 'Direct advisory count changed');
  const configuredByIdentity = new Map(
    allowlist.allowedAdvisories.map((advisory) => [advisoryIdentity(advisory), advisory]),
  );
  const seenAdvisories = new Set();
  for (const { advisory } of advisoryOccurrences) {
    const identity = advisoryIdentity(advisory);
    const expected = configuredByIdentity.get(identity);
    assert(expected, `Unapproved advisory ${identity} is present`);
    assert(!seenAdvisories.has(identity), `Advisory ${identity} appeared more than once`);
    seenAdvisories.add(identity);
    assertAdvisoryMatches(advisory, expected, `Advisory ${expected.ghsa}`);
  }

  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    if (name === 'image-size') continue;
    const references = vulnerability.via.filter((via) => typeof via === 'string');
    assert(references.length === vulnerability.via.length, `${name} unexpectedly contains a direct advisory`);
    for (const reference of references) {
      assert(
        reachesImageSize(reference, report.vulnerabilities),
        `${name} has provenance that does not terminate at image-size: ${reference}`,
      );
    }
  }
}

export function validateLockfile(lockfile, allowlist) {
  assert(isObject(lockfile), 'package-lock.json must be a JSON object');
  assert(lockfile.lockfileVersion === allowlist.lockfile.lockfileVersion, 'package-lock.json version changed');
  assert(isObject(lockfile.packages), 'package-lock.json packages map is missing');

  for (const affected of allowlist.affectedPackages) {
    const locked = lockfile.packages[affected.nodePath];
    assert(isObject(locked), `Lock node ${affected.nodePath} is missing`);
    assert(locked.version === affected.version, `Locked version changed for ${affected.nodePath}`);
  }

  const imagePolicy = allowlist.lockfile.imageSize;
  const lockedImageSize = lockfile.packages[imagePolicy.nodePath];
  assert(isObject(lockedImageSize), `Lock node ${imagePolicy.nodePath} is missing`);
  assert(lockedImageSize.version === imagePolicy.version, 'image-size lock version changed');
  assert(lockedImageSize.integrity === imagePolicy.integrity, 'image-size lock integrity changed');

  const imageSizeNodes = Object.keys(lockfile.packages)
    .filter((nodePath) => nodePath === 'node_modules/image-size' || nodePath.endsWith('/node_modules/image-size'));
  assertSameStrings(imageSizeNodes, [imagePolicy.nodePath], 'Locked image-size node set');

  const imageSizeParents = [];
  for (const [nodePath, lockedPackage] of Object.entries(lockfile.packages)) {
    for (const dependencyType of DEPENDENCY_TYPES) {
      const specifier = lockedPackage?.[dependencyType]?.['image-size'];
      if (specifier !== undefined) imageSizeParents.push({ nodePath, dependencyType, specifier });
    }
  }
  const expectedParent = imagePolicy.onlyParent;
  assert(imageSizeParents.length === 1, 'image-size lock parent set changed');
  assert(imageSizeParents[0].nodePath === expectedParent.nodePath, 'image-size lock parent path changed');
  assert(imageSizeParents[0].dependencyType === expectedParent.dependencyType, 'image-size lock parent type changed');
  assert(imageSizeParents[0].specifier === expectedParent.specifier, 'image-size lock parent specifier changed');
  assert(expectedParent.dependencyName === 'image-size', 'Invalid configured image-size parent dependency name');

  for (const edge of allowlist.lockfile.dependencyChain) {
    const from = lockfile.packages[edge.fromPath];
    const to = lockfile.packages[edge.toPath];
    assert(isObject(from), `Dependency-chain source ${edge.fromPath} is missing`);
    assert(isObject(to), `Dependency-chain target ${edge.toPath} is missing`);
    assert(
      from[edge.dependencyType]?.[edge.dependencyName] === edge.specifier,
      `Dependency-chain edge ${edge.fromPath} -> ${edge.dependencyName} changed`,
    );
    assert(to.version === edge.toVersion, `Dependency-chain target version changed for ${edge.toPath}`);
  }
}

export function validateMitigationHashes(allowlist, mitigationHashes) {
  for (const mitigation of allowlist.mitigations) {
    assert(
      mitigationHashes[mitigation.path] === mitigation.sha256,
      `Mitigation file changed without allowlist review: ${mitigation.path}`,
    );
  }
}

export function validateAuditGate({
  allowlist,
  productionAudit,
  fullAudit,
  lockfile,
  mitigationHashes,
  now = new Date(),
}) {
  validateAllowlist(allowlist);
  validateReviewExpiry(allowlist.reviewExpiresOn, now);
  validateProductionAudit(productionAudit);
  validateFullAudit(fullAudit, allowlist);
  validateLockfile(lockfile, allowlist);
  validateMitigationHashes(allowlist, mitigationHashes);
}

async function readJson(filePath, label) {
  let source;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    fail(`Unable to read ${label}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`Unable to parse ${label}: ${error.message}`);
  }
}

async function readMitigationHashes(repositoryRoot, allowlist) {
  const canonicalRoot = await realpath(repositoryRoot);
  const hashes = {};
  for (const mitigation of allowlist.mitigations) {
    const absolutePath = path.resolve(repositoryRoot, mitigation.path);
    const canonicalPath = await realpath(absolutePath).catch(() => null);
    assert(canonicalPath, `Mitigation file is missing: ${mitigation.path}`);
    assert(
      canonicalPath.startsWith(`${canonicalRoot}${path.sep}`),
      `Mitigation file resolves outside the repository: ${mitigation.path}`,
    );
    const fileStat = await stat(canonicalPath);
    assert(fileStat.isFile(), `Mitigation path is not a file: ${mitigation.path}`);
    const contents = await readFile(canonicalPath);
    hashes[mitigation.path] = createHash('sha256').update(contents).digest('hex');
  }
  return hashes;
}

function parseAuditOutput(result, label) {
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  const stdout = result.stdout?.trim();
  if (!stdout) {
    const stderr = result.stderr?.trim().slice(0, 2000);
    fail(`${label} returned no JSON${stderr ? `: ${stderr}` : ''}`);
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    fail(`${label} returned invalid JSON`);
  }
  validateAuditReportShape(report, label);
  return report;
}

function runNpmAudit(repositoryRoot, args, label) {
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(executable, ['audit', ...args, '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, npm_config_fund: 'false', npm_config_update_notifier: 'false' },
  });
  return parseAuditOutput(result, label);
}

function runMitigationTest(repositoryRoot, command) {
  const [executable, ...args] = command;
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) fail(`Mitigation test could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(0, 4000);
    fail(`Mitigation test failed${output ? `:\n${output}` : ''}`);
  }
}

export async function runAuditGate(repositoryRoot = DEFAULT_REPOSITORY_ROOT) {
  const allowlist = await readJson(path.join(repositoryRoot, ALLOWLIST_PATH), ALLOWLIST_PATH);
  validateAllowlist(allowlist);
  validateReviewExpiry(allowlist.reviewExpiresOn);

  const productionAuditArgs = ['--omit=dev'];
  for (const workspace of allowlist.productionWorkspaces) {
    productionAuditArgs.push(`--workspace=${workspace}`);
  }
  const productionAudit = runNpmAudit(
    repositoryRoot,
    productionAuditArgs,
    'Production control-plane/Web audit',
  );
  const fullAudit = runNpmAudit(repositoryRoot, [], 'Full dependency audit');
  const lockfile = await readJson(path.join(repositoryRoot, 'package-lock.json'), 'package-lock.json');
  const mitigationHashes = await readMitigationHashes(repositoryRoot, allowlist);

  validateAuditGate({ allowlist, productionAudit, fullAudit, lockfile, mitigationHashes });
  runMitigationTest(repositoryRoot, allowlist.mitigationTest.command);

  console.log(
    `npm audit gate passed: production high/critical=0; full tree limited to ${allowlist.allowedAdvisories.map((item) => item.ghsa).join(', ')}; review by ${allowlist.reviewExpiresOn}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    await runAuditGate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`npm audit gate failed: ${message}`);
    process.exitCode = 1;
  }
}

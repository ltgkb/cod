import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AuditGateError,
  validateAuditGate,
  validateReviewExpiry,
} from './check-npm-audit.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowlist = JSON.parse(readFileSync(path.join(repositoryRoot, 'security/npm-audit-allowlist.json'), 'utf8'));
const lockfile = JSON.parse(readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
const mitigationHashes = Object.fromEntries(
  allowlist.mitigations.map((mitigation) => {
    const contents = readFileSync(path.join(repositoryRoot, mitigation.path));
    return [mitigation.path, createHash('sha256').update(contents).digest('hex')];
  }),
);

const viaGraph = {
  '@expo/cli': ['@expo/metro', '@expo/metro-config'],
  '@expo/metro': ['metro', 'metro-config', 'metro-transform-worker'],
  '@expo/metro-config': ['@expo/metro'],
  '@react-native/community-cli-plugin': ['metro', 'metro-config'],
  '@react-native/virtualized-lists': ['react-native'],
  expo: ['@expo/cli', '@expo/metro', '@expo/metro-config'],
  metro: ['image-size', 'metro-config', 'metro-transform-worker'],
  'metro-config': ['metro'],
  'metro-transform-worker': ['metro'],
  'react-native': ['@react-native/community-cli-plugin', '@react-native/virtualized-lists'],
};

function advisoryForAudit(entry) {
  return {
    source: entry.source,
    name: entry.package,
    dependency: entry.package,
    title: 'Pinned image-size denial-of-service advisory',
    url: entry.url,
    severity: entry.severity,
    cwe: ['CWE-835'],
    cvss: { score: 7.5 },
    range: entry.range,
  };
}

function makeFullAudit() {
  const vulnerabilities = {};
  for (const affected of allowlist.affectedPackages) {
    vulnerabilities[affected.name] = {
      name: affected.name,
      severity: 'high',
      isDirect: affected.isDirect,
      via: affected.name === 'image-size'
        ? allowlist.allowedAdvisories.map(advisoryForAudit)
        : [...viaGraph[affected.name]],
      effects: [],
      range: '*',
      nodes: [affected.nodePath],
      fixAvailable: false,
    };
  }
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: allowlist.affectedPackages.length,
        critical: 0,
        total: allowlist.affectedPackages.length,
      },
    },
  };
}

function makeProductionAudit() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
    },
  };
}

function makeInput() {
  return {
    allowlist: structuredClone(allowlist),
    productionAudit: makeProductionAudit(),
    fullAudit: makeFullAudit(),
    lockfile: structuredClone(lockfile),
    mitigationHashes: structuredClone(mitigationHashes),
    now: new Date('2026-09-11T12:00:00.000Z'),
  };
}

test('accepts the exact pinned audit graph, lock chain, and mitigations through the review date', () => {
  assert.doesNotThrow(() => validateAuditGate(makeInput()));
});

test('rejects a production high-severity vulnerability even when the mobile exception is valid', () => {
  const input = makeInput();
  input.productionAudit.vulnerabilities.pg = {
    severity: 'high',
    via: [],
    nodes: ['node_modules/pg'],
  };
  assert.throws(() => validateAuditGate(input), AuditGateError);
});

test('rejects every unrelated full-tree advisory regardless of severity', () => {
  const input = makeInput();
  input.fullAudit.vulnerabilities.unrelated = {
    severity: 'low',
    isDirect: false,
    via: [{ source: 9999999 }],
    nodes: ['node_modules/unrelated'],
  };
  assert.throws(() => validateAuditGate(input), /affected package set changed/);
});

test('rejects a changed advisory source or GHSA', () => {
  const input = makeInput();
  input.fullAudit.vulnerabilities['image-size'].via[0].source = 9999999;
  assert.throws(() => validateAuditGate(input), /Unapproved advisory/);
});

test('rejects an affected package at a different installed path', () => {
  const input = makeInput();
  input.fullAudit.vulnerabilities.metro.nodes = ['node_modules/expo/node_modules/metro'];
  assert.throws(() => validateAuditGate(input), /Audit nodes for metro changed/);
});

test('rejects a changed affected package version', () => {
  const input = makeInput();
  input.lockfile.packages['node_modules/metro'].version = '0.84.5';
  assert.throws(() => validateAuditGate(input), /Locked version changed/);
});

test('rejects a changed image-size tarball integrity', () => {
  const input = makeInput();
  input.lockfile.packages['node_modules/image-size'].integrity = 'sha512-not-approved';
  assert.throws(() => validateAuditGate(input), /integrity changed/);
});

test('rejects a new or changed image-size parent', () => {
  const input = makeInput();
  input.lockfile.packages['node_modules/metro'].dependencies['image-size'] = '^2.0.0';
  assert.throws(() => validateAuditGate(input), /parent specifier changed/);
});

test('rejects an allowlisted propagation edge that no longer terminates at image-size', () => {
  const input = makeInput();
  input.fullAudit.vulnerabilities['@expo/cli'].via = ['@expo/metro-config'];
  input.fullAudit.vulnerabilities['@expo/metro-config'].via = ['@expo/cli'];
  assert.throws(() => validateAuditGate(input), /does not terminate at image-size/);
});

test('rejects any unreviewed mitigation change', () => {
  const input = makeInput();
  input.mitigationHashes['apps/mobile/metro.config.js'] = '0'.repeat(64);
  assert.throws(() => validateAuditGate(input), /Mitigation file changed/);
});

test('fails closed after the fixed review expiry', () => {
  assert.throws(
    () => validateReviewExpiry(allowlist.reviewExpiresOn, '2026-09-12'),
    /expired on 2026-09-11/,
  );
});

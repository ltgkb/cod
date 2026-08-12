'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const config = require('../metro.config.js');
const { getAssetSize } = require('metro/private/Assets');

const disabledSamples = {
  heif: Buffer.from([0, 0, 0, 12, ...Buffer.from('ftypheic')]),
  icns: Buffer.from('icns'),
  jxl: Buffer.from([
    0, 0, 0, 12, ...Buffer.from('JXL '), 13, 10, 135, 10,
    0, 0, 0, 12, ...Buffer.from('ftypjxl '),
  ]),
  'jxl-stream': Buffer.from([0xff, 0x0a]),
};

test('Metro asset sizing rejects the unused high-risk image parsers before calculation', () => {
  for (const [type, input] of Object.entries(disabledSamples)) {
    assert.throws(
      () => getAssetSize('png', input, `malformed-${type}.png`),
      new RegExp(`disabled file type: ${type}`),
    );
  }
});

test('Metro still calculates supported PNG assets', () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  Buffer.from('IHDR').copy(png, 12);
  png.writeUInt32BE(2, 16);
  png.writeUInt32BE(3, 20);

  assert.deepEqual(getAssetSize('png', png, 'valid.png'), { width: 2, height: 3 });
});

test('disabled parser names are not direct Metro asset extensions', () => {
  for (const type of Object.keys(disabledSamples)) {
    assert.equal(config.resolver.assetExts.includes(type), false);
  }
});

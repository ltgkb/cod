'use strict';

const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { disableTypes: disableImageTypes } = require('image-size');
const { getDefaultConfig } = require('expo/metro-config');

const disabledImageTypes = Object.freeze(['heif', 'icns', 'jxl', 'jxl-stream']);

// COD does not ship these formats. Disable their parsers before Metro reads any
// project assets so malformed files cannot reach the vulnerable handlers.
disableImageTypes(disabledImageTypes);

const {
  assertExpoDevelopmentDomHtml,
  getMetroServerPort,
  transformExpoDomHtml,
} = require('./scripts/expo-dom-bootstrap.cjs');

const config = getDefaultConfig(__dirname);
const bootstrapPath = '/_cod/expo-dom-bootstrap';
const domSource = path.join(__dirname, 'src', 'CodWorkspace.dom.tsx');
const upstreamPath = `/_expo/@dom/CodWorkspace.dom.tsx?file=${encodeURIComponent(pathToFileURL(domSource).href)}`;
const controlPlaneUrl = process.env.EXPO_PUBLIC_COD_CONTROL_PLANE_URL ?? 'https://cod.kai.com';
const enhanceMiddleware = config.server?.enhanceMiddleware;

function serveBootstrapHtml(req, res, metroPort) {
  const host = req.headers.host;
  if (!host) {
    res.statusCode = 400;
    res.end('Missing Host header');
    return;
  }

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: metroPort,
    path: upstreamPath,
    method: 'GET',
    headers: {
      host,
      'user-agent': req.headers['user-agent'] ?? 'COD Expo DOM bootstrap',
    },
  }, (upstreamResponse) => {
    const chunks = [];
    upstreamResponse.on('data', (chunk) => chunks.push(chunk));
    upstreamResponse.on('end', () => {
      try {
        const source = Buffer.concat(chunks).toString('utf8');
        if (upstreamResponse.statusCode !== 200) {
          res.statusCode = upstreamResponse.statusCode ?? 502;
          res.end(source);
          return;
        }
        assertExpoDevelopmentDomHtml(source);
        const output = transformExpoDomHtml(source, controlPlaneUrl);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Length', Buffer.byteLength(output));
        res.end(output);
      } catch (error) {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      }
    });
  });

  upstream.on('error', (error) => {
    if (res.headersSent) return;
    res.statusCode = 502;
    res.end(`Unable to load Expo DOM entry: ${error.message}`);
  });
  req.on('aborted', () => upstream.destroy());
  upstream.end();
}

config.server = {
  ...config.server,
  enhanceMiddleware(metroMiddleware, server) {
    const nextMiddleware = enhanceMiddleware
      ? enhanceMiddleware(metroMiddleware, server)
      : metroMiddleware;
    return (req, res, next) => {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && requestUrl.pathname === bootstrapPath) {
        try {
          serveBootstrapHtml(req, res, getMetroServerPort(config));
        } catch (error) {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      nextMiddleware(req, res, next);
    };
  },
};

module.exports = config;

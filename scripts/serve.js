#!/usr/bin/env node
/**
 * Dependency-free static server for local development.
 *
 * ES modules can't be loaded over file://, so the app needs to be served.
 *   node scripts/serve.js [port]
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';

    // Resolve inside ROOT only — no path traversal.
    const target = path.resolve(ROOT, rel);
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let file = target;
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) {
      // Unknown path -> index.html, so #routes and OAuth redirects resolve.
      file = path.join(ROOT, 'index.html');
    } else if (stat.isDirectory()) {
      file = path.join(file, 'index.html');
    }

    const body = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500).end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
});

server.listen(PORT, () => {
  console.log(`WeightFun running at http://localhost:${PORT}`);
});

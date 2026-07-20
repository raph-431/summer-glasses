#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Local dev server. Same job as `python3 -m http.server`, with one difference
// that matters: it tells the browser never to cache. Without that, an edited
// ES module keeps loading from cache and you get errors describing code you
// no longer have ("does not provide an export named …") until a hard reload.
//
//   node serve.js [port]        default 8080  ->  http://127.0.0.1:8080/web/gift.html
// ---------------------------------------------------------------------------
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.argv[2]) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if(rel.endsWith('/')) rel += 'index.html';
  const file = path.join(root, rel);
  if(!file.startsWith(root)){                    // no climbing out of the project
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if(err){ res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found: ' + rel); }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store, must-revalidate',
      'pragma': 'no-cache',
      'expires': '0',
    });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`serving ${root}`);
  console.log(`  gift    http://127.0.0.1:${port}/web/gift.html`);
  console.log(`  redeem  http://127.0.0.1:${port}/web/redeem.html`);
  console.log(`  gallery http://127.0.0.1:${port}/web/`);
  console.log('nothing is cached — edit and refresh normally');
});

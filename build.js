#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BUILD — packages the piece for minting. Plain Node, no dependencies.
//
//   node build.js
//
// Produces in dist/:
//   summer-glasses.html   the whole piece as ONE self-contained file
//                         (haiku.js and the #legend div stripped) — open it
//                         directly in a browser to sanity-check a build
//   payload.b64           base64 of the gzipped single file — this is the
//                         byte string the contract stores in SSTORE2 chunks
//   bootstrap.html        the exact HTML a tokenURI emits (sample hash
//                         baked in) — what a marketplace iframe will load;
//                         the contract substitutes the real token hash for
//                         __TOKEN_HASH__ in bootstrap-template.html
//   bootstrap-template.html
//
// The bootstrap sets window.TOKEN_HASH, inflates the payload with the
// browser-native DecompressionStream, and document.write()s it. The window
// (and so TOKEN_HASH) survives document.open() — main.js reads it and goes
// into token mode. gzipSync writes no mtime, so builds are byte-reproducible.
// ---------------------------------------------------------------------------
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const root = __dirname;
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const inline = (html, src) => {
  const js = read(src);
  if(js.includes('</script')) throw new Error(src + ' contains "</script>" — cannot inline');
  const tag = `<script src="${src}"></script>`;
  if(!html.includes(tag)) throw new Error('tag not found for ' + src);
  return html.replace(tag, () => '<script>\n' + js + '</script>');
};

let html = read('index.html');
html = html.replace(/<script src="haiku\.js"><\/script>[^\n]*\n/, '');   // dev-only caption layer
html = html.replace(/<div id="legend"><\/div>\n/, '');                   // its (inert) mount point
html = html.replace(/\s*<button id="haikuBtn">.*?<\/button>[^\n]*\n/, '\n'); // its corner control
html = inline(html, 'shaders.js');
html = inline(html, 'main.js');

const gz  = zlib.gzipSync(Buffer.from(html), { level: 9 });
const b64 = gz.toString('base64');

const SAMPLE_HASH = '0x' + 'abc123def4567890'.repeat(4);
const bootstrapTemplate =
`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Summer Glass</title><style>html{background:#b9b6b3}</style></head><body><script>
window.TOKEN_HASH = "__TOKEN_HASH__";
(async () => {
  const b = Uint8Array.from(atob("${b64}"), c => c.charCodeAt(0));
  const t = await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  document.open(); document.write(t); document.close();
})();
</script></body></html>`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = (f, s) => { fs.writeFileSync(path.join(root, 'dist', f), s); };
out('summer-glasses.html', html);
out('payload.b64', b64);
out('bootstrap-template.html', bootstrapTemplate);
out('bootstrap.html', bootstrapTemplate.replace('__TOKEN_HASH__', SAMPLE_HASH));

// the contract stores the bootstrap as three wrapper parts around the two
// variable spans (token hash, payload): html = p1 ++ hash ++ p2 ++ payload ++ s
const iHash = bootstrapTemplate.indexOf('__TOKEN_HASH__');
const iPay  = bootstrapTemplate.indexOf(b64);
if(iHash < 0 || iPay < iHash) throw new Error('template markers out of order');
out('art-prefix1.txt', bootstrapTemplate.slice(0, iHash));
out('art-prefix2.txt', bootstrapTemplate.slice(iHash + '__TOKEN_HASH__'.length, iPay));
out('art-suffix.txt',  bootstrapTemplate.slice(iPay + b64.length));

const CHUNK = 24575;   // SSTORE2 max contract-code payload per chunk
const kb = n => (n/1024).toFixed(1) + ' KB';
console.log('single file :', kb(html.length));
console.log('gzipped     :', kb(gz.length));
console.log('base64      :', kb(b64.length), '->', Math.ceil(b64.length/CHUNK), 'SSTORE2 chunks');
console.log('bootstrap   :', kb(bootstrapTemplate.length), '(the data: URI a tokenURI returns)');

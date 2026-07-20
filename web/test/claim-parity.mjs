// Parity test: the browser claim-key module must agree byte-for-byte with
// foundry's cast (whose signatures the contract tests already accept).
//   node web/test/claim-parity.mjs
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
const require = createRequire(import.meta.url);
globalThis.keccak_256 = require('../vendor/sha3.js').keccak_256;

const { newClaimKey, addressOf, signDigest, encodeCode, decodeCode, bytesToHex }
  = await import('../lib/claim.js');

const cast = (...args) => execFileSync('cast', args, { encoding: 'utf8' }).trim();
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name); if(!ok) fails++; };

for(let i = 0; i < 5; i++){
  const priv = newClaimKey();
  const privHex = bytesToHex(priv);

  check(`address parity #${i}`, addressOf(priv) === cast('wallet', 'address', '--private-key', privHex));

  const digest = '0x' + Buffer.from(globalThis.keccak_256.arrayBuffer('digest-' + i)).toString('hex');
  const ours = await signDigest(priv, digest);
  const theirs = cast('wallet', 'sign', '--no-hash', '--private-key', privHex, digest);
  check(`signature parity #${i}`, ours === theirs);

  const code = encodeCode(priv);
  const back = decodeCode(code);
  check(`code round-trip #${i}`, back && bytesToHex(back) === privHex);
}

// tampered codes must be rejected, not silently accepted
const code = encodeCode(newClaimKey());
const tampered = code.slice(0, -1) + (code.at(-1) === 'x' ? 'y' : 'x');
check('tampered code rejected', decodeCode(tampered) === null);
check('garbage code rejected', decodeCode('not-a-code-0OIl') === null);

process.exit(fails ? 1 : 0);

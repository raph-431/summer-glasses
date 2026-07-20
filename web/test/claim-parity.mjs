// Parity test: the browser claim-key module must agree byte-for-byte with
// foundry's cast (whose signatures the contract tests already accept).
//   node web/test/claim-parity.mjs
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
const require = createRequire(import.meta.url);
globalThis.keccak_256 = require('../vendor/sha3.js').keccak_256;

const { newClaimKey, addressOf, signDigest, newCode, keyFromCode, encodeLegacyCode,
        decodeLegacyCode, badWords, bytesToHex } = await import('../lib/claim.js');

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

  // the word format: a code must always come back as the same key
  const code = newCode();
  const k1 = await keyFromCode(code), k2 = await keyFromCode(code);
  check(`word code is deterministic #${i}`, bytesToHex(k1) === bytesToHex(k2));
  check(`word code shape #${i}`, /^([a-z]+ ){5}\d{5}$/.test(code));
  const sloppy = code.toUpperCase().replace(/ /g, '-');
  check(`word code survives sloppy typing #${i}`,
        bytesToHex(await keyFromCode(sloppy)) === bytesToHex(k1));
  // old base58 codes must still work for gifts already sold
  const legacy = encodeLegacyCode(priv);
  check(`legacy code still decodes #${i}`,
        bytesToHex(await keyFromCode(legacy)) === privHex);
}

// nonsense must be refused, and misspellings named
check('garbage code rejected', await keyFromCode('not a code at all 12345') === null);
check('short code rejected', await keyFromCode('amber cicada glass') === null);
check('misspelled word is named', badWords('ambr cicada glass noon shade 40317').includes('ambr'));
const real = newCode();
check('a different code gives a different key',
      bytesToHex(await keyFromCode(real)) !== bytesToHex(await keyFromCode(newCode())));
// tampered legacy codes must still be rejected by their checksum
const lc = encodeLegacyCode(newClaimKey());
check('tampered legacy code rejected',
      decodeLegacyCode(lc.slice(0, -1) + (lc.at(-1) === 'x' ? 'y' : 'x')) === null);

process.exit(fails ? 1 : 0);

// A single-character OCR/typo slip in a code word (a card's "job" read as
// "iob") must still redeem — provided the fix is unambiguous. Proves the
// corrected code derives the SAME key as the intended one, that the fix is
// surfaced, and that genuinely ambiguous/unknown words are still refused.
//
//   node web/test/claim-ocr.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.keccak_256 = require('../vendor/sha3.js').keccak_256;
const { keyFromCode, badWords, readCode, bytesToHex } = await import('../lib/claim.js');
const { WORDS } = await import('../vendor/wordlist.js');

let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if(!ok) fails++; };

// sanity: "job" is a real BIP-39 word, "iob" is not
check("'job' is in the wordlist", WORDS.includes('job'));
check("'iob' is not in the wordlist", !WORDS.includes('iob'));

const original  = 'ability able about above job 12345';
const ocrSlip   = 'ability able about above iob 12345';   // j -> i

const kOrig = bytesToHex(await keyFromCode(original));
const kSlip = bytesToHex(await keyFromCode(ocrSlip));
check('slipped code still resolves to a key', kSlip !== null && kSlip !== 'null');
check('slipped code derives the SAME key as the original', kOrig === kSlip);

const rc = readCode(ocrSlip);
check('readCode reports a correction', rc && rc.corrected === true);
check('readCode shows the intended words', rc && rc.display === 'ability able about above job 12345');

// the original (unslipped) code is not reported as "corrected"
const rcOrig = readCode(original);
check('unslipped code is not flagged as corrected', rcOrig && rcOrig.corrected === false);

// hyphens (as in a #k= link) parse the same way
const linkForm = 'ability-able-about-above-iob-12345';
check('hyphenated slipped link resolves too', bytesToHex(await keyFromCode(linkForm)) === kOrig);

// a genuinely unknown / ambiguous word is still refused, and named
const nonsense = 'ability able about above zzzzzz 12345';
check('unrecoverable word yields no key', (await keyFromCode(nonsense)) === null);
check('unrecoverable word is named by badWords', badWords(nonsense).includes('zzzzzz'));

// an ambiguous slip (>1 candidate word one edit away) must NOT be silently
// "corrected" — better to ask than to guess wrong and derive a dead key.
// "cble" is one edit from both "able" and "cable".
const ambiguousToken = 'cble';
check("ambiguity fixture: 'able' and 'cable' both present",
  WORDS.includes('able') && WORDS.includes('cable') && !WORDS.includes(ambiguousToken));
const ambCode = `ability able about above ${ambiguousToken} 12345`;
check('ambiguous slip is not auto-corrected', (await keyFromCode(ambCode)) === null);
check('ambiguous slip is surfaced as a bad word', badWords(ambCode).includes(ambiguousToken));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

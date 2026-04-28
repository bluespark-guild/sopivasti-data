/**
 * Smoke test for resolveYouTubeChannel.
 *
 * Cases include channels where the previous regex-based extractor failed
 * (PBD/Valuetainment swap, MyronGainesX/FreshandFit swap). These are live
 * fetches against youtube.com — skip in CI if rate-limited.
 *
 * Usage: node scripts/lib/yt.test.mjs
 */

import { resolveYouTubeChannel } from './yt.mjs';

const cases = [
  // Previously swapped pairs
  ['@PBDPodcast', 'UCGX7nGXpz-CmO_Arg-cgJ7A'],
  ['@valuetainment', 'UCIHdDJ0tjn_3j-FS7s_X1kQ'],
  ['@MyronGainesX', 'UC4HttNRwamCTHVu_H6i-uvw'],
  ['@FreshandFitClips', 'UCWvOWoP13fXw1DlfKVRnZgw'],
  // Sanity: well-known channels
  ['@MrBeast', 'UCX6OQ3DkcsbYNE6H8uQQuVA'],
  ['@pokimane', 'UChXKjLEzAB1K7EZQey7Fm1Q'],
  ['@PirateSoftware', 'UCMnULQ6F6kLDAHxofDWIbrw'],
];

let pass = 0;
let fail = 0;

for (const [handle, expected] of cases) {
  process.stdout.write(`${handle.padEnd(22)} → `);
  const result = await resolveYouTubeChannel(handle);
  if (result.error) {
    console.log(`FAIL — ${result.error}`);
    fail++;
    continue;
  }
  const actual = result.channelId;
  if (actual === expected) {
    console.log(`OK (${actual})`);
    pass++;
  } else {
    console.log(`MISMATCH — got ${actual}, expected ${expected}`);
    fail++;
  }
}

console.log(`\n${pass} pass, ${fail} fail (${cases.length} total)`);
process.exit(fail === 0 ? 0 : 1);

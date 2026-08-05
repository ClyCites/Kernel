#!/usr/bin/env node
/**
 * Stage 7. Verify one record against the published Merkle root.
 *
 * This file deliberately imports nothing from the kernel. No repository, no
 * pool, no `merkle.ts`, no shared constant. It speaks HTTP to the public API
 * and to a Hedera mirror node, and it recomputes the root from first
 * principles with `node:crypto`.
 *
 * That is the whole point. If a third party cannot check the claim with the
 * documentation and a hash function, the tamper-evidence property does not
 * exist — it is a thing the kernel asserts about itself.
 *
 * Usage: node scripts/verify-external.mjs <base-url> <record-id> [subject]
 *
 * The subject is needed only because the proof route sits behind the ordinary
 * read check — a proof for a record you may not read would confirm it exists.
 * The roots route takes no subject at all, and that asymmetry is deliberate.
 */

import { createHash } from 'node:crypto';

const [, , baseUrl, recordId, subject] = process.argv;

if (!baseUrl || !recordId) {
  process.stderr.write('usage: verify-external.mjs <base-url> <record-id> [subject]\n');
  process.exit(2);
}

const base = baseUrl.replace(/\/$/, '');
const say = (text = '') => process.stdout.write(`${text}\n`);

/* The domain separation bytes. Taken from the published API documentation,
   not from the kernel's source — a verifier that shares constants with the
   thing it verifies is checking its own arithmetic. */
const LEAF = 0x00;
const NODE = 0x01;

const sha256 = (...parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const fromHex = (hex) => Buffer.from(hex, 'hex');
const toHex = (buffer) => buffer.toString('hex');

async function getJson(path, authenticated = false) {
  const response = await fetch(`${base}${path}`, {
    headers: authenticated && subject ? { 'x-clycites-subject': subject } : {},
  });
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

say('external verification — no database, no kernel imports');
say(`  api        ${base}`);
say(`  record     ${recordId}`);
say();

/* ── 1. Ask the public API for the proof ──────────────────────────────────── */

const proof = await getJson(`/v1/anchors/${recordId}/proof`, true);
say('1. the proof, from GET /v1/anchors/:id/proof');
say(`   batch date     ${proof.batch_date}`);
say(`   record digest  ${proof.record_digest}`);
say(`   salt           ${String(proof.salt).slice(0, 16)}…`);
say(`   leaf hash      ${proof.leaf_hash}`);
say(`   path length    ${proof.path.length}`);
say(`   record count   ${proof.record_count}`);
say();

/* ── 2. Recompute the leaf ──────────────────────────────────────────── */

/* The salt is why a published leaf is not a usable commitment on its own. An
   observer who guesses a record's contents cannot confirm the guess without
   it, which is what makes publishing hashes of personal data survivable. */

const leafComputed = toHex(
  sha256(Buffer.from([LEAF]), fromHex(proof.salt), fromHex(proof.record_digest)),
);

say('2. recompute the leaf: sha256(0x00 || salt || record_digest)');
say(`   computed       ${leafComputed}`);
say(`   published      ${proof.leaf_hash}`);
if (leafComputed !== proof.leaf_hash) {
  say('   MISMATCH — stop.');
  process.exit(1);
}
say('   match');
say();

/* ── 3. Walk the path to a root ───────────────────────────────────────────── */

let current = fromHex(leafComputed);

say('3. walk the path to a root');
for (const step of proof.path) {
  const sibling = fromHex(step.hash);
  current =
    step.side === 'left'
      ? sha256(Buffer.from([NODE]), sibling, current)
      : sha256(Buffer.from([NODE]), current, sibling);
  say(
    `   ${step.side.padEnd(5)} sibling ${step.hash.slice(0, 16)}…  ->  ` +
      `${toHex(current).slice(0, 16)}…`,
  );
}

const rootComputed = toHex(current);
say(`   computed root  ${rootComputed}`);
say();

/* ── 4. Compare against the published root ────────────────────────────────── */

/* Fetched separately, and without a subject header, so the root compared
   against is the one anybody can see rather than the one that happened to
   come back attached to our own proof. */

const { roots } = await getJson('/v1/anchors/roots');
const published = roots.find((entry) => entry.batch_date === proof.batch_date);

if (!published) {
  say(`4. NO PUBLIC ROOT FOR ${proof.batch_date}`);
  say();
  say('   The kernel computed a root over this batch and will show it to anyone');
  say('   holding a proof. It has not published it. GET /v1/anchors/roots — the');
  say('   one route on the whole API that needs no subject, and the only thing');
  say('   an outsider can check against — returns nothing for this date.');
  say();
  say('   So steps 1 to 3 proved the record is consistent with a root the kernel');
  say('   handed us in the same breath. That is not tamper evidence. A kernel');
  say('   that keeps its own root, shows you that root, and confirms your record');
  say('   is in it has told you nothing it could not have made up.');
  say();
  say('   Everything upstream of publication works and is proved above. The');
  say('   publication step is the one that is missing.');
  process.exit(3);
}

say('4. the published root, from GET /v1/anchors/roots (no subject header)');
say(`   merkle_root    ${published.merkle_root}`);
say(`   records        ${published.record_count}`);
say();

if (rootComputed !== published.merkle_root) {
  say('   ROOT MISMATCH — the record is not in this root.');
  process.exit(1);
}
say('   the record is in the published root.');
say();

/* ── 5. The part that makes it external ───────────────────────────────────── */

/* Steps 1 to 4 prove the record is in a root the kernel published. They do not
   prove the kernel published that root anywhere it cannot later change. Only
   the consensus timestamp on a public ledger does that, and it has to be read
   from a mirror node rather than from the kernel. */

if (!proof.topic_id || !proof.sequence_number) {
  say('5. NOT ANCHORED TO A LEDGER');
  say(
    `   network ${proof.network}, topic ${proof.topic_id ?? '(none)'}, ` +
      `sequence ${proof.sequence_number ?? '(none)'}`,
  );
  say('   The root exists and the proof checks out against it, but no topic id');
  say('   and no sequence number were published — so this run proves internal');
  say('   consistency and nothing more. A kernel that stores its own root and');
  say('   then attests to it is not tamper-evident; it is self-certified.');
  say();
  say('   Configure ANCHOR_TOPIC_ID and an operator key, run the batch again,');
  say('   and this step will read the message back from a mirror node that has');
  say('   never heard of this kernel.');
  process.exit(3);
}

const network = proof.network === 'mainnet' ? 'mainnet-public' : proof.network;
const mirror = `https://${network}.mirrornode.hedera.com/api/v1/topics/${proof.topic_id}/messages/${proof.sequence_number}`;

say('5. read the same root back from a Hedera mirror node');
say(`   ${mirror}`);

const response = await fetch(mirror);
if (!response.ok) {
  say(`   mirror node answered ${response.status} — cannot confirm`);
  process.exit(1);
}

const message = await response.json();
const payload = Buffer.from(message.message, 'base64').toString('utf8');
say(`   consensus      ${message.consensus_timestamp}`);
say(`   payload        ${payload}`);

let onLedger;
try {
  onLedger = JSON.parse(payload);
} catch {
  /* The message need not be JSON for the check to work — what matters is that
     the root appears in bytes we did not write and cannot revise. */
  if (payload.includes(rootComputed)) {
    say();
    say('VERIFIED — the computed root appears verbatim in the ledger message.');
    process.exit(0);
  }
  say('   the message neither parses as JSON nor contains the root');
  process.exit(1);
}

const ledgerRoot = onLedger.root ?? onLedger.merkle_root;
say();
say(`   root on the ledger  ${ledgerRoot}`);
say(`   root we computed    ${rootComputed}`);

if (ledgerRoot !== rootComputed) {
  say('   MISMATCH — the ledger does not carry this root.');
  process.exit(1);
}

say();
say('VERIFIED. A record fetched through the public API hashes into a root that');
say('was written to a public ledger at a consensus time nobody involved');
say('controls, and this process read it back without touching the database.');

import { before, after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { uuidv7 } from 'uuidv7';

import {
  startTestDatabase,
  sqlState,
  INSUFFICIENT_PRIVILEGE,
  type TestDatabase,
} from '../helpers/database.js';
import {
  auditServiceFor,
  consentServiceFor,
  consentGrantServiceFor,
  objectionServiceFor,
  entityDocument,
  ingestServiceFor,
  readingAs,
} from '../helpers/fixtures.js';
import { InferenceRepository } from '../../src/inference/inference.repository.js';
import { MediaRepository } from '../../src/media/media.repository.js';
import { MediaService } from '../../src/media/media.service.js';
import { ReadService } from '../../src/records/read.service.js';
import { RecordRepository } from '../../src/records/record.repository.js';
import { citedMedia } from '../../src/media/citations.js';
import {
  ALLOWED_MIME,
  MAX_OBJECT_BYTES,
  sniff,
  strip,
  MediaRejected,
} from '../../src/media/format.js';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  objectKey,
  type ObjectStore,
} from '../../src/media/objects.js';

let db: TestDatabase;
let media: MediaService;
let repository: MediaRepository;
let read: ReadService;
let ingest: ReturnType<typeof ingestServiceFor>['ingest']['ingest'];
let store: FakeStore;

/* ── a store that keeps bytes in a Map ────────────────────────────────────── */

/**
 * The S3 client is not the thing under test; what the kernel does with it is.
 * This fake is deliberately dumb — it records what was put and what was asked
 * for, so a test can assert that the bytes written are the *stripped* bytes
 * and that nothing was signed before the consent check ran.
 */
class FakeStore {
  readonly objects = new Map<string, Buffer>();
  readonly signed: { key: string; seconds: number }[] = [];

  put(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(body));
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (found === undefined) return Promise.reject(new Error(`no such key ${key}`));
    return Promise.resolve(found);
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  downloadUrl(key: string, seconds = DOWNLOAD_URL_TTL_SECONDS): Promise<string> {
    this.signed.push({ key, seconds });
    return Promise.resolve(`https://objects.invalid/${key}?X-Amz-Expires=${seconds}`);
  }

  list(prefix: string): Promise<{ key: string; size: number }[]> {
    return Promise.resolve(
      [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, body]) => ({ key, size: body.length })),
    );
  }
}

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/* ── file fixtures ────────────────────────────────────────────────────────── */

function jpegWith(segments: { marker: number; payload: Buffer }[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  for (const segment of segments) {
    const header = Buffer.alloc(4);
    header[0] = 0xff;
    header[1] = segment.marker;
    header.writeUInt16BE(segment.payload.length + 2, 2);
    parts.push(header, segment.payload);
  }
  // A start-of-scan and some entropy-coded data, then end-of-image.
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from('scan-data'));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** EXIF, with a GPS tag's worth of bytes standing in for the real thing. */
const EXIF_PAYLOAD = Buffer.concat([
  Buffer.from('Exif\0\0', 'latin1'),
  Buffer.from('II*\0\x08\0\0\0', 'latin1'),
  Buffer.from('GPSLatitude 0.3476 GPSLongitude 32.5825', 'latin1'),
]);

const PHOTOGRAPH = jpegWith([
  { marker: 0xe0, payload: Buffer.from('JFIF\0\x01\x02\0\0\x01\0\x01\0\0', 'latin1') },
  { marker: 0xe1, payload: EXIF_PAYLOAD },
]);

const CLEAN_PHOTOGRAPH = jpegWith([
  { marker: 0xe0, payload: Buffer.from('JFIF\0\x01\x02\0\0\x01\0\x01\0\0', 'latin1') },
  { marker: 0xdb, payload: Buffer.from('quantisation-table', 'latin1') },
]);

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  // The CRC is not checked by the stripper; a wrong one here would be a false
  // negative in a test rather than a real file, so it is left zero on purpose.
  return out;
}

const PNG_WITH_TEXT = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk('IHDR', Buffer.alloc(13)),
  pngChunk('tEXt', Buffer.from('Author\0Kato Sarah', 'latin1')),
  pngChunk('eXIf', Buffer.from('II*\0 gps', 'latin1')),
  pngChunk('IDAT', Buffer.from('pixels', 'latin1')),
  pngChunk('IEND', Buffer.alloc(0)),
]);

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const padded = data.length + (data.length % 2);
  const out = Buffer.alloc(8 + padded);
  out.write(fourcc, 0, 'latin1');
  out.writeUInt32LE(data.length, 4);
  data.copy(out, 8);
  return out;
}

function webpWithExif(): Buffer {
  const vp8xPayload = Buffer.alloc(10);
  // Flags: EXIF (0x08) and XMP (0x04) both advertised.
  vp8xPayload[0] = 0x0c;
  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    riffChunk('VP8X', vp8xPayload),
    riffChunk('VP8 ', Buffer.from('pixels', 'latin1')),
    riffChunk('EXIF', Buffer.from('II*\0 homestead', 'latin1')),
  ]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** A Mach-O executable, renamed by an optimist. */
const EXECUTABLE = Buffer.concat([
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.alloc(64),
]);

/* ── harness ──────────────────────────────────────────────────────────────── */

const OWNER = uuidv7();

async function upload(
  bytes: Buffer,
  options: { as?: string; declaredMime?: string; declaredHash?: string; chunk?: number } = {},
) {
  const requester = options.as ?? OWNER;
  const context = { requester, dataset: 'live', correlation: null };
  const session = await media.begin(
    {
      hash: options.declaredHash ?? sha256(bytes),
      mime: options.declaredMime ?? (sniff(bytes) ?? 'image/jpeg'),
      size: bytes.length,
    },
    context,
  );

  const size = options.chunk ?? bytes.length;
  let offset = 0;
  let last = null as Awaited<ReturnType<typeof media.receive>>;
  while (offset < bytes.length) {
    const slice = bytes.subarray(offset, Math.min(offset + size, bytes.length));
    last = await media.receive(session.id, offset, Buffer.from(slice), context);
    if (last === null) break;
    if (last.session.state === 'rejected') break;
    offset += slice.length;
  }
  return { session, outcome: last };
}

before(async () => {
  db = await startTestDatabase();
  repository = new MediaRepository(db.app);
  store = new FakeStore();

  const records = new RecordRepository(db.app);
  const audit = auditServiceFor(db.app);
  read = new ReadService(
    records,
    consentServiceFor(db.app),
    objectionServiceFor(db.app),
    audit,
    new InferenceRepository(db.app),
  );
  media = new MediaService(
    repository,
    read,
    audit,
    store as unknown as ObjectStore,
  );
  ingest = ingestServiceFor(db.app).ingest.ingest;
});

after(async () => {
  await db.stop();
});

/* ── the allow-list ───────────────────────────────────────────────────────── */

describe('what the bytes are, not what the client says they are', () => {
  test('an executable renamed image/jpeg is refused on its content', async () => {
    const { outcome } = await upload(EXECUTABLE, { declaredMime: 'image/jpeg' });

    assert.equal(outcome?.session.state, 'rejected');
    assert.equal(outcome?.session.rejection, 'type_refused');
    assert.equal(outcome?.object, null);
  });

  test('sniffing does not consult the declared type at all', () => {
    assert.equal(sniff(EXECUTABLE), null);
    assert.equal(sniff(PHOTOGRAPH), 'image/jpeg');
    assert.equal(sniff(PNG_WITH_TEXT), 'image/png');
    assert.equal(sniff(webpWithExif()), 'image/webp');
  });

  test('a type outside the allow-list is refused before any byte is sent', async () => {
    await assert.rejects(
      () =>
        media.begin(
          { hash: sha256(PHOTOGRAPH), mime: 'application/pdf', size: 10 },
          { requester: OWNER, dataset: 'live', correlation: null },
        ),
      (error: unknown) =>
        error instanceof MediaRejected && error.reason === 'type_refused',
    );
  });

  test('the allow-list and the strippers are the same list', () => {
    // A format that can be uploaded but not stripped would set
    // metadata_stripped = true about a file that still carries GPS.
    for (const mime of ALLOWED_MIME) {
      assert.doesNotThrow(() => {
        const sample =
          mime === 'image/jpeg'
            ? PHOTOGRAPH
            : mime === 'image/png'
              ? PNG_WITH_TEXT
              : webpWithExif();
        strip(mime, sample);
      });
    }
  });

  test('a size beyond the ceiling is refused before any byte is sent', async () => {
    await assert.rejects(
      () =>
        media.begin(
          {
            hash: sha256(PHOTOGRAPH),
            mime: 'image/jpeg',
            size: MAX_OBJECT_BYTES + 1,
          },
          { requester: OWNER, dataset: 'live', correlation: null },
        ),
      (error: unknown) =>
        error instanceof MediaRejected && error.reason === 'too_large',
    );
  });
});

/* ── the hash ─────────────────────────────────────────────────────────────── */

describe('the claimed hash is checked, because the hash is what gets anchored', () => {
  test('bytes that do not match the claim are refused', async () => {
    const wrong = sha256(Buffer.from('some other photograph'));
    const { outcome } = await upload(PHOTOGRAPH, { declaredHash: wrong });

    assert.equal(outcome?.session.state, 'rejected');
    assert.equal(outcome?.session.rejection, 'hash_mismatch');
    assert.equal(store.objects.size, 0, 'nothing was stored');
  });

  test('the stored hash is over the stripped bytes, not the received ones', async () => {
    const { outcome } = await upload(PHOTOGRAPH);
    const object = outcome?.object;

    assert.ok(object !== null && object !== undefined);
    assert.equal(object.received_hash, sha256(PHOTOGRAPH));
    assert.notEqual(object.content_hash, object.received_hash);
    // And the stored hash is the hash of what a verifier can actually fetch.
    const stored = store.objects.get(object.storage_ref);
    assert.ok(stored !== undefined);
    assert.equal(sha256(stored), object.content_hash);
  });

  test('a file with no metadata hashes to what the client claimed', async () => {
    const { outcome } = await upload(CLEAN_PHOTOGRAPH);
    const object = outcome?.object;

    assert.ok(object !== null && object !== undefined);
    assert.equal(object.content_hash, object.received_hash);
  });

  test('the same photograph twice is stored once', async () => {
    const first = await upload(PNG_WITH_TEXT);
    const before = store.objects.size;
    const second = await upload(PNG_WITH_TEXT, { as: uuidv7() });

    assert.equal(
      first.outcome?.object?.content_hash,
      second.outcome?.object?.content_hash,
    );
    assert.equal(store.objects.size, before, 'no second object was created');
    // The first uploader keeps provenance. An upsert would have overwritten it
    // with whoever happened to supply the bytes last.
    assert.equal(second.outcome?.object?.first_seen_by, OWNER);
  });
});

/* ── the key ──────────────────────────────────────────────────────────────── */

describe('the key discloses nothing', () => {
  test('it names no party, no record and no date', async () => {
    const farmer = uuidv7();
    const { outcome } = await upload(webpWithExif());
    const key = outcome?.object?.storage_ref ?? '';

    assert.ok(key.length > 0);
    assert.ok(!key.includes(farmer));
    assert.ok(!key.includes(OWNER));
    assert.ok(!/\d{4}-\d{2}-\d{2}/u.test(key), 'no date in the key');
    assert.ok(!/\.(jpe?g|png|webp)$/iu.test(key), 'no original filename');
  });

  test('the key is derived from the hash and nothing else', () => {
    const hash = 'a'.repeat(64);
    assert.equal(objectKey('live', hash), `live/sha256/aa/aa/${hash}`);
  });

  test('a seed object can never be reached at a live key', async () => {
    const hash = 'b'.repeat(64);
    assert.notEqual(objectKey('seed', hash), objectKey('live', hash));
  });
});

/* ── stripping ────────────────────────────────────────────────────────────── */

describe('metadata is removed by default, not on request', () => {
  test('JPEG EXIF goes, JFIF stays', () => {
    const stripped = strip('image/jpeg', PHOTOGRAPH);

    assert.equal(stripped.removed, true);
    assert.ok(!stripped.bytes.includes(Buffer.from('GPSLatitude')));
    assert.ok(stripped.bytes.includes(Buffer.from('JFIF')));
    assert.ok(stripped.bytes.includes(Buffer.from('scan-data')), 'the image survives');
  });

  test('a JPEG ICC profile is kept — it describes colour, not a person', () => {
    const withIcc = jpegWith([
      { marker: 0xe2, payload: Buffer.from('ICC_PROFILE\0 curve', 'latin1') },
      { marker: 0xe1, payload: EXIF_PAYLOAD },
    ]);
    const stripped = strip('image/jpeg', withIcc);

    assert.ok(stripped.bytes.includes(Buffer.from('ICC_PROFILE')));
    assert.ok(!stripped.bytes.includes(Buffer.from('GPSLatitude')));
  });

  test('a JPEG comment goes too — cameras put filenames there', () => {
    const withComment = jpegWith([
      { marker: 0xfe, payload: Buffer.from('/storage/emulated/0/DCIM/kato.jpg', 'latin1') },
    ]);
    const stripped = strip('image/jpeg', withComment);

    assert.equal(stripped.removed, true);
    assert.ok(!stripped.bytes.includes(Buffer.from('kato.jpg')));
  });

  test('PNG text and eXIf go, pixels stay', () => {
    const stripped = strip('image/png', PNG_WITH_TEXT);

    assert.equal(stripped.removed, true);
    assert.ok(!stripped.bytes.includes(Buffer.from('Kato Sarah')));
    assert.ok(!stripped.bytes.includes(Buffer.from('eXIf')));
    assert.ok(stripped.bytes.includes(Buffer.from('pixels')));
    assert.ok(stripped.bytes.includes(Buffer.from('IEND')));
  });

  test('WebP EXIF goes and VP8X stops advertising it', () => {
    const stripped = strip('image/webp', webpWithExif());

    assert.equal(stripped.removed, true);
    assert.ok(!stripped.bytes.includes(Buffer.from('homestead')));

    // The flags matter as much as the chunk: a VP8X still claiming EXIF after
    // the chunk is gone makes decoders treat the file as corrupt, which would
    // turn a privacy control into a broken photograph.
    const flagsAt = stripped.bytes.indexOf(Buffer.from('VP8X', 'latin1')) + 8;
    assert.equal(stripped.bytes[flagsAt]! & 0x0c, 0);

    // And the RIFF length was rewritten, or every reader sees a truncated file.
    assert.equal(stripped.bytes.readUInt32LE(4), stripped.bytes.length - 8);
  });

  test('a malformed file is refused rather than passed through unstripped', () => {
    const truncated = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
      Buffer.from([0xff, 0xff]), // a segment longer than the file
    ]);
    assert.throws(() => strip('image/jpeg', truncated), MediaRejected);
  });

  test('every stored object says so', async () => {
    const { outcome } = await upload(PHOTOGRAPH);
    assert.equal(outcome?.object?.metadata_stripped, true);
    assert.ok(
      Number(outcome?.object?.byte_size) < Number(outcome?.object?.received_size),
    );
  });
});

/* ── resuming ─────────────────────────────────────────────────────────────── */

describe('an upload that fails partway through can be finished', () => {
  test('a photograph arrives in pieces and assembles to the same object', async () => {
    const direct = await upload(webpWithExif(), { as: uuidv7() });
    const pieces = await upload(webpWithExif(), { as: uuidv7(), chunk: 7 });

    assert.equal(
      pieces.outcome?.object?.content_hash,
      direct.outcome?.object?.content_hash,
    );
  });

  test('a chunk at the wrong offset is refused and the offset does not move', async () => {
    const context = { requester: OWNER, dataset: 'live', correlation: null };
    const session = await media.begin(
      { hash: sha256(PHOTOGRAPH), mime: 'image/jpeg', size: PHOTOGRAPH.length },
      context,
    );

    const rejected = await media.receive(
      session.id,
      99,
      Buffer.from(PHOTOGRAPH.subarray(0, 10)),
      context,
    );
    assert.equal(rejected, null);

    const unchanged = await media.session(session.id, 'live');
    assert.equal(Number(unchanged?.received_size), 0);
  });

  test('replaying a chunk that already landed does not advance twice', async () => {
    const context = { requester: OWNER, dataset: 'live', correlation: null };
    const session = await media.begin(
      { hash: sha256(PHOTOGRAPH), mime: 'image/jpeg', size: PHOTOGRAPH.length },
      context,
    );
    const head = Buffer.from(PHOTOGRAPH.subarray(0, 10));

    const first = await media.receive(session.id, 0, head, context);
    const replay = await media.receive(session.id, 0, head, context);

    assert.equal(Number(first?.session.received_size), 10);
    assert.equal(replay, null, 'the retry is refused, not applied');

    const current = await media.session(session.id, 'live');
    assert.equal(Number(current?.received_size), 10);
  });

  test('somebody else cannot continue your upload', async () => {
    const context = { requester: OWNER, dataset: 'live', correlation: null };
    const session = await media.begin(
      { hash: sha256(PHOTOGRAPH), mime: 'image/jpeg', size: PHOTOGRAPH.length },
      context,
    );

    const stolen = await media.receive(session.id, 0, PHOTOGRAPH, {
      ...context,
      requester: uuidv7(),
    });
    assert.equal(stolen, null);
  });

  test('more bytes than were declared is a refusal, not a bigger file', async () => {
    const context = { requester: OWNER, dataset: 'live', correlation: null };
    const session = await media.begin(
      { hash: sha256(PHOTOGRAPH), mime: 'image/jpeg', size: 10 },
      context,
    );

    const outcome = await media.receive(session.id, 0, PHOTOGRAPH, context);
    assert.equal(outcome?.session.rejection, 'size_mismatch');
  });

  test('a refused upload leaves no staged bytes behind', async () => {
    for (const key of [...store.objects.keys()]) {
      if (key.startsWith('staging/')) store.objects.delete(key);
    }
    await upload(PHOTOGRAPH, { declaredHash: sha256(Buffer.from('nope')), chunk: 9 });

    const staged = [...store.objects.keys()].filter((key) => key.startsWith('staging/'));
    assert.deepEqual(staged, []);
  });
});

/* ── the consent gate ─────────────────────────────────────────────────────── */

describe('a url is not an access path around consent', () => {
  test('an object nothing cites is not released to anybody', async () => {
    const { outcome } = await upload(CLEAN_PHOTOGRAPH, { as: uuidv7() });
    const hash = outcome?.object?.content_hash ?? '';

    const released = await media.release(hash, readingAs(OWNER));
    assert.equal(released, null);
  });

  test('the citing record decides, and the subject may fetch', async () => {
    const farmer = uuidv7();
    const { outcome } = await upload(webpWithExif(), { as: uuidv7(), chunk: 11 });
    const object = outcome?.object;
    assert.ok(object !== null && object !== undefined);

    await ingest(
      entityDocument('observation', {
        asserted_by: farmer,
        subject_type: 'party',
        subject_ref: farmer,
        media: [
          {
            content_hash: object.content_hash,
            mime_type: object.mime_type,
            byte_size: Number(object.byte_size),
            storage_ref: object.storage_ref,
            captured_at: null,
            captured_by: farmer,
            capture_location: null,
            metadata_stripped: true,
          },
        ],
      }),
    );

    const mine = await media.release(object.content_hash, readingAs(farmer));
    assert.ok(mine !== null, 'the subject of the citing record may fetch it');
    assert.ok(mine.url.includes(object.storage_ref));

    // A stranger gets the same answer as if it did not exist. 404, not 403 —
    // distinguishing the two would confirm the photograph is there.
    const stranger = await media.release(object.content_hash, readingAs(uuidv7()));
    assert.equal(stranger, null);
  });

  test('nothing is signed when the check refuses', async () => {
    const { outcome } = await upload(
      jpegWith([{ marker: 0xe1, payload: Buffer.from('Exif\0\0 unshared', 'latin1') }]),
      { as: uuidv7() },
    );
    const hash = outcome?.object?.content_hash ?? '';
    const before = store.signed.length;

    await media.release(hash, readingAs(uuidv7()));
    assert.equal(store.signed.length, before, 'no url was ever generated');
  });

  test('the url expires in minutes, not hours', () => {
    assert.ok(DOWNLOAD_URL_TTL_SECONDS <= 600, 'minutes, not hours');
    assert.ok(DOWNLOAD_URL_TTL_SECONDS > 0);
    for (const signature of store.signed) {
      assert.ok(signature.seconds <= 600);
    }
  });

  test('a released url is a disclosure the subject can find', async () => {
    const farmer = uuidv7();
    const lender = uuidv7();
    // The subject has to be a party the kernel knows, or the record reaches
    // nobody and consent has nothing to decide about.
    await ingest(entityDocument('party', { id: farmer, asserted_by: farmer }));
    await consentGrantServiceFor(db.app).grant({
      subject: farmer,
      grantee: lender,
      purpose: 'advisory',
      recordTypes: ['observation'],
      expiresAt: null,
      grantedVia: 'in_person_signature',
      evidence: [],
      dataset: 'live',
    });

    const { outcome } = await upload(
      jpegWith([{ marker: 0xe1, payload: Buffer.from('Exif\0\0 disclosed', 'latin1') }]),
      { as: farmer },
    );
    const object = outcome?.object;
    assert.ok(object !== null && object !== undefined);

    await ingest(
      entityDocument('observation', {
        asserted_by: farmer,
        subject_type: 'party',
        subject_ref: farmer,
        media: [
          {
            content_hash: object.content_hash,
            mime_type: object.mime_type,
            byte_size: Number(object.byte_size),
            storage_ref: object.storage_ref,
            captured_at: null,
            captured_by: farmer,
            capture_location: null,
            metadata_stripped: true,
          },
        ],
      }),
    );

    const got = await media.release(object.content_hash, {
      requester: lender,
      purpose: 'advisory',
      dataset: 'live',
    });
    assert.ok(got !== null, 'the lender was refused');

    // The farmer asks who has seen their things. A photograph handed to a
    // lender is a disclosure like any other, and if it did not show up here
    // the subject would have no way to learn it happened.
    const disclosures = await db.app.query<{ actor: string; access: string | null }>(
      `select * from audit.disclosures_to($1, 'live')`,
      [farmer],
    );
    assert.ok(
      disclosures.rows.some(
        (row) => row.actor === lender && row.access === 'media',
      ),
      'the lender does not appear in the farmer\u2019s disclosure list',
    );

    const entries = await db.owner.query(
      `select action from audit.entry where action = 'media.read' limit 1`,
    );
    assert.equal(entries.rows.length, 1, 'the release was logged as a disclosure');
  });
});

/* ── citations ────────────────────────────────────────────────────────────── */

describe('what counts as citing an object', () => {
  test('a MediaRef nested anywhere in the body is found', () => {
    const hash = 'c'.repeat(64);
    const found = citedMedia({
      type: 'harvest',
      evidence: [{ content_hash: hash, storage_ref: 'live/sha256/cc/cc/x' }],
    });
    assert.deepEqual(found, [hash]);
  });

  test('a bare content_hash is not a citation', () => {
    // Anchoring roots and conversion digests are hashes too. Treating them as
    // media citations would make bytes reachable through records that never
    // mentioned them.
    const found = citedMedia({ merkle_root: 'd'.repeat(64) });
    assert.deepEqual(found, []);
  });

  test('the same object cited twice in one record is recorded once', () => {
    const hash = 'e'.repeat(64);
    const ref = { content_hash: hash, storage_ref: 'live/sha256/ee/ee/x' };
    assert.deepEqual(citedMedia({ evidence: [ref], media: [ref] }), [hash]);
  });
});

/* ── the database's own guarantees ────────────────────────────────────────── */

describe('what the database will not let happen', () => {
  test('a stored object cannot be edited or removed', async () => {
    const { outcome } = await upload(
      jpegWith([{ marker: 0xe1, payload: Buffer.from('Exif\0\0 immutable', 'latin1') }]),
      { as: uuidv7() },
    );
    const hash = outcome?.object?.content_hash;
    assert.ok(hash !== undefined);

    await assert.rejects(
      () =>
        db.owner.query(`update kernel.media_object set mime_type = 'image/png' where content_hash = $1`, [
          hash,
        ]),
      (error: unknown) => sqlState(error) === INSUFFICIENT_PRIVILEGE,
    );
    await assert.rejects(
      () => db.owner.query(`delete from kernel.media_object where content_hash = $1`, [hash]),
      (error: unknown) => sqlState(error) === INSUFFICIENT_PRIVILEGE,
    );
  });

  test('the training role cannot reach a photograph', async () => {
    for (const relation of [
      'kernel.media_object',
      'kernel.media_reference',
      'kernel.upload_session',
    ]) {
      await assert.rejects(
        () => db.training.query(`select * from ${relation} limit 1`),
        (error: unknown) => sqlState(error) === INSUFFICIENT_PRIVILEGE,
        `${relation} is reachable from the training role`,
      );
    }
  });

  test('the inventory the backup reads counts what is actually there', async () => {
    const inventory = await repository.inventory('live');
    const refs = await repository.storageRefs('live');

    assert.equal(Number(inventory.object_count), refs.length);
    assert.ok(Number(inventory.byte_total) > 0);
    assert.notEqual(inventory.digest, 'empty');

    // And the bucket agrees. This is the comparison scripts/restore.sh makes:
    // a restore that brought the rows back and not the objects fails here.
    const present = new Set((await store.list('live/')).map((object) => object.key));
    const missing = refs.filter((ref) => !present.has(ref));
    assert.deepEqual(missing, [], 'every named object is in the bucket');
  });
});

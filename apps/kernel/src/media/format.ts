import { createHash } from 'node:crypto';

/**
 * Format sniffing, the MIME allow-list, and metadata stripping.
 *
 * Everything here parses bytes that arrived from the network, from a phone in
 * a village, over a link that drops. It is written defensively: every read is
 * bounds-checked, every loop has a termination condition that does not depend
 * on the file being well-formed, and a file that does not parse is refused
 * rather than passed through. A stripper that silently gives up and returns
 * the input is worse than no stripper at all, because `metadata_stripped` then
 * says true about a file that still carries the farmer's GPS coordinates.
 */

/**
 * The allow-list, and it is short on purpose.
 *
 * These three are the formats a field client actually produces for evidence,
 * and the three whose metadata this module knows how to remove. Adding a
 * format here without teaching {@link strip} about it would be a privacy
 * regression wearing the disguise of a config change, so the two are the same
 * table.
 *
 * PDF is absent deliberately. It carries author and producer metadata this
 * module cannot remove, it can embed JavaScript and remote references, and
 * nothing in the spec asks a farmer to photograph a delivery as a PDF.
 */
export const ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type AllowedMime = (typeof ALLOWED_MIME)[number];

/**
 * Spec §3.9 evidence is photographs. 12MB is a generous phone camera original;
 * anything larger is either not a photograph or is not going to survive the
 * network it has to cross.
 */
export const MAX_OBJECT_BYTES = 12 * 1024 * 1024;

/**
 * A single PATCH body. Small enough that losing one to a dropped connection
 * costs a second, which is the entire point of resuming.
 */
export const MAX_CHUNK_BYTES = 1 * 1024 * 1024;

export class MediaRejected extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'MediaRejected';
  }
}

/**
 * What the bytes actually are, from their leading bytes — never from what the
 * client said they were.
 *
 * A `Content-Type: image/jpeg` header on a Mach-O binary is a one-line lie.
 * The allow-list is only worth having if it is applied to the content.
 */
export function sniff(bytes: Buffer): AllowedMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes.toString('latin1', 1, 4) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface Stripped {
  bytes: Buffer;
  /** True when the input carried metadata and it is now gone. */
  removed: boolean;
}

/**
 * Remove metadata, by format.
 *
 * Stripping is the default and not an option a caller may decline, because the
 * caller is a field client written by somebody else and the person whose
 * homestead coordinates are in the file is not the caller. Capture location is
 * carried in `MediaRef.capture_location` when it is *stated*, which is a
 * different act from a camera recording it silently.
 */
export function strip(mime: AllowedMime, bytes: Buffer): Stripped {
  switch (mime) {
    case 'image/jpeg':
      return stripJpeg(bytes);
    case 'image/png':
      return stripPng(bytes);
    case 'image/webp':
      return stripWebp(bytes);
  }
}

/* ── JPEG ─────────────────────────────────────────────────────────────────── */

/**
 * A JPEG is a sequence of marker segments. EXIF lives in APP1, XMP in APP1 or
 * APP2, Photoshop IRB (which carries IPTC, which carries author and location)
 * in APP13, and free-text comments in COM. All of those go.
 *
 * APP0 (JFIF) stays because it carries the density the image needs to display
 * at the right aspect, and APP2 stays only when it is an ICC colour profile.
 * Neither says anything about a person.
 */
function stripJpeg(bytes: Buffer): Stripped {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new MediaRejected('malformed', 'not a JPEG: no start-of-image marker');
  }

  const out: Buffer[] = [bytes.subarray(0, 2)];
  let removed = false;
  let i = 2;

  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) {
      throw new MediaRejected('malformed', `JPEG segment at ${i} does not start with 0xFF`);
    }

    // Fill bytes: 0xFF may be repeated as padding before a marker.
    let marker = bytes[i + 1]!;
    let markerAt = i + 1;
    while (marker === 0xff && markerAt + 1 < bytes.length) {
      markerAt += 1;
      marker = bytes[markerAt]!;
    }

    // Start of scan: entropy-coded data follows to the end. Copy verbatim —
    // walking it would mean decoding the image, which this module does not do.
    if (marker === 0xda) {
      out.push(bytes.subarray(i));
      break;
    }

    // Standalone markers carry no length.
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(bytes.subarray(i, markerAt + 1));
      i = markerAt + 1;
      continue;
    }

    if (markerAt + 3 > bytes.length) {
      throw new MediaRejected('malformed', 'JPEG segment header runs past the end');
    }
    const length = bytes.readUInt16BE(markerAt + 1);
    if (length < 2) {
      throw new MediaRejected('malformed', `JPEG segment at ${markerAt} declares length ${length}`);
    }
    const end = markerAt + 1 + length;
    if (end > bytes.length) {
      throw new MediaRejected('malformed', 'JPEG segment runs past the end');
    }

    if (dropJpegSegment(marker, bytes.subarray(markerAt + 3, end))) {
      removed = true;
    } else {
      out.push(bytes.subarray(i, end));
    }
    i = end;
  }

  return { bytes: Buffer.concat(out), removed };
}

function dropJpegSegment(marker: number, payload: Buffer): boolean {
  // COM — a free-text comment. Cameras and editors put filenames and usernames
  // here.
  if (marker === 0xfe) return true;

  // APP1: EXIF and XMP both. Nothing else uses it.
  if (marker === 0xe1) return true;

  // APP13: Photoshop IRB, which wraps IPTC — creator, contact, location.
  if (marker === 0xed) return true;

  // APP2 is ICC when it says so, and XMP extension otherwise.
  if (marker === 0xe2) {
    return payload.toString('latin1', 0, 12) !== 'ICC_PROFILE\0';
  }

  // Remaining APPn (0xE3–0xEF): vendor maker-notes, which are exactly the
  // device identifiers this exists to remove. APP0 (0xE0) is JFIF and stays.
  return marker >= 0xe3 && marker <= 0xef;
}

/* ── PNG ──────────────────────────────────────────────────────────────────── */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * PNG chunks that carry metadata. `eXIf` is EXIF wholesale; the text chunks
 * carry anything an editor felt like writing; `tIME` is the last-modified
 * timestamp, which on a phone is the moment of capture.
 */
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(bytes: Buffer): Stripped {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new MediaRejected('malformed', 'not a PNG: bad signature');
  }

  const out: Buffer[] = [bytes.subarray(0, 8)];
  let removed = false;
  let i = 8;

  while (i + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(i);
    // Guard before widening: a declared length near 2^32 would overflow the
    // addition on a 32-bit read and wrap into a valid-looking offset.
    if (length > bytes.length) {
      throw new MediaRejected('malformed', `PNG chunk at ${i} declares ${length} bytes`);
    }
    const type = bytes.toString('latin1', i + 4, i + 8);
    const end = i + 12 + length;
    if (end > bytes.length) {
      throw new MediaRejected('malformed', 'PNG chunk runs past the end');
    }

    if (PNG_DROP.has(type)) {
      removed = true;
    } else {
      out.push(bytes.subarray(i, end));
    }

    i = end;
    if (type === 'IEND') break;
  }

  return { bytes: Buffer.concat(out), removed };
}

/* ── WebP ─────────────────────────────────────────────────────────────────── */

function stripWebp(bytes: Buffer): Stripped {
  if (bytes.length < 12) {
    throw new MediaRejected('malformed', 'not a WebP: too short for a RIFF header');
  }

  const chunks: Buffer[] = [];
  let removed = false;
  let vp8x: Buffer | null = null;
  let i = 12;

  while (i + 8 <= bytes.length) {
    const fourcc = bytes.toString('latin1', i, i + 4);
    const declared = bytes.readUInt32LE(i + 4);
    if (declared > bytes.length) {
      throw new MediaRejected('malformed', `WebP chunk ${fourcc} declares ${declared} bytes`);
    }
    // RIFF pads every chunk to an even length.
    const padded = declared + (declared % 2);
    const end = i + 8 + padded;
    if (end > bytes.length) {
      throw new MediaRejected('malformed', 'WebP chunk runs past the end');
    }

    if (fourcc === 'EXIF' || fourcc === 'XMP ') {
      removed = true;
    } else {
      const chunk = Buffer.from(bytes.subarray(i, end));
      if (fourcc === 'VP8X') vp8x = chunk;
      chunks.push(chunk);
    }
    i = end;
  }

  // VP8X advertises which optional chunks are present. Leaving the EXIF and
  // XMP flags set after removing the chunks produces a file that decoders
  // consider corrupt, which would turn a privacy control into a broken image.
  if (vp8x !== null && vp8x.length >= 9) {
    vp8x[8] = vp8x[8]! & ~0x0c;
  }

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');

  return { bytes: Buffer.concat([header, body]), removed };
}

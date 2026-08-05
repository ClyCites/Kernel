/**
 * An evidence photograph carrying the metadata a phone would put in it.
 *
 * Structurally a JPEG and not a picture: marker segments in the right order
 * with entropy-coded rubbish after the scan header. The kernel's stripper
 * walks markers and never decodes, so this exercises exactly the code path a
 * real photograph would, and a rehearsal that needed a real camera roll would
 * not be runnable from a clean checkout.
 *
 * The APP1 segment holds a real EXIF IFD with GPS coordinates and a capture
 * time. Those are the bytes stage 3 checks are gone.
 */

/** Somebody's homestead. The whole reason stripping is not optional. */
export const EXIF_LATITUDE = [0, 20, 3] as const;
export const EXIF_LONGITUDE = [31, 44, 3] as const;
export const EXIF_CAPTURED = '2026:07:18 14:35:02';

function segment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt8(0xff, 0);
  header.writeUInt8(marker, 1);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/**
 * A little-endian TIFF block: one IFD entry pointing at a GPS sub-IFD, and a
 * DateTimeOriginal string. Enough that `exiftool` on the original reports
 * coordinates, which is the claim being tested.
 */
function exifPayload(): Buffer {
  const rational = (values: readonly number[]): Buffer => {
    const out = Buffer.alloc(values.length * 8);
    values.forEach((value, index) => {
      out.writeUInt32LE(Math.round(value * 1000), index * 8);
      out.writeUInt32LE(1000, index * 8 + 4);
    });
    return out;
  };

  const captured = Buffer.from(`${EXIF_CAPTURED}\0`, 'latin1');
  const latitude = rational(EXIF_LATITUDE);
  const longitude = rational(EXIF_LONGITUDE);

  // Offsets are from the start of the TIFF header, which begins after
  // "Exif\0\0". The layout below is fixed, so they are computed once here.
  const tiffHeader = Buffer.alloc(8);
  tiffHeader.write('II', 0, 'latin1');
  tiffHeader.writeUInt16LE(42, 2);
  tiffHeader.writeUInt32LE(8, 4);

  const entryCount = 2;
  const ifdSize = 2 + entryCount * 12 + 4;
  const gpsIfdAt = 8 + ifdSize;
  const gpsEntryCount = 2;
  const gpsIfdSize = 2 + gpsEntryCount * 12 + 4;
  const latitudeAt = gpsIfdAt + gpsIfdSize;
  const longitudeAt = latitudeAt + latitude.length;
  const capturedAt = longitudeAt + longitude.length;

  const entry = (
    tag: number,
    format: number,
    count: number,
    value: number,
  ): Buffer => {
    const out = Buffer.alloc(12);
    out.writeUInt16LE(tag, 0);
    out.writeUInt16LE(format, 2);
    out.writeUInt32LE(count, 4);
    out.writeUInt32LE(value, 8);
    return out;
  };

  const ifd0 = Buffer.concat([
    Buffer.from([entryCount, 0]),
    entry(0x8825, 4, 1, gpsIfdAt), // GPSInfoIFDPointer
    entry(0x9003, 2, captured.length, capturedAt), // DateTimeOriginal
    Buffer.alloc(4), // no IFD1
  ]);

  const gpsIfd = Buffer.concat([
    Buffer.from([gpsEntryCount, 0]),
    entry(0x0002, 5, 3, latitudeAt), // GPSLatitude
    entry(0x0004, 5, 3, longitudeAt), // GPSLongitude
    Buffer.alloc(4),
  ]);

  return Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    tiffHeader,
    ifd0,
    gpsIfd,
    latitude,
    longitude,
    captured,
  ]);
}

export interface Photograph {
  bytes: Buffer;
  /** Byte ranges a reader can check for in the stored object. */
  markers: { exif: Buffer; comment: Buffer };
}

export function photograph(): Photograph {
  const jfif = Buffer.concat([
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ]);
  const comment = Buffer.from('taken by officer handset 07 — IMG_0431.JPG', 'latin1');
  const exif = exifPayload();

  // A scan header and some entropy bytes. Never decoded; padded so the upload
  // needs more than one chunk and the resume in stage 3 is a real resume.
  const scan = Buffer.concat([
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.alloc(96 * 1024, 0x5a),
    Buffer.from([0xff, 0xd9]),
  ]);

  return {
    bytes: Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(0xe0, jfif),
      segment(0xe1, exif),
      segment(0xfe, comment),
      scan,
    ]),
    markers: { exif, comment },
  };
}

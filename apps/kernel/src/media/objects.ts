import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * The object store, reached over the S3 API and nothing else.
 *
 * Nothing above this file knows which implementation is behind it. That is not
 * decoration: the store this was built against is MinIO, pinned to the last
 * release published before its owner archived the open-source server, and
 * whatever runs in production in two years is not knowable now. See
 * docs/decisions/0040-minio.md.
 *
 * Only the S3 subset that every implementation actually has is used here —
 * PUT, GET, HEAD, DELETE, LIST, and SigV4 presigning. No bucket policies, no
 * object lock, no versioning, no lifecycle. Those are the parts where
 * implementations diverge, and the parts a swap would break on.
 */

export const OBJECT_STORE = Symbol('OBJECT_STORE');

export interface ObjectStoreSettings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing. Garage and MinIO both want it; AWS tolerates it. */
  forcePathStyle: boolean;
}

export interface StoredObject {
  key: string;
  size: number;
}

/**
 * How long a download URL lives.
 *
 * Minutes, not hours. A presigned URL is a bearer token in a query string: it
 * lands in proxy logs, in browser history, in the referer header of whatever
 * the image is embedded in, and in the screenshot somebody sends to support.
 * The consent check that authorised it ran once, at issue; every second after
 * that is a second in which the answer may have changed and the URL does not
 * know. Five minutes is enough to fetch a photograph over a bad link and short
 * enough that a leaked URL is usually already dead.
 */
export const DOWNLOAD_URL_TTL_SECONDS = 300;

export class ObjectStore {
  private readonly client: S3Client;

  constructor(private readonly settings: ObjectStoreSettings) {
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
    });
  }

  get bucket(): string {
    return this.settings.bucket;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.settings.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Belt and braces against a store that has been configured with a
        // permissive default ACL. S3 and MinIO honour it; stores with no ACL
        // model at all ignore it.
        ACL: 'private',
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.settings.bucket, Key: key }),
    );
    const body = response.Body;
    if (body === undefined) {
      throw new Error(`object ${key} has no body`);
    }
    return Buffer.from(await body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: key }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.settings.bucket, Key: key }),
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * Every object under a prefix. Used by the backup inventory, which has to
   * compare what the bucket holds against what the database says it should.
   */
  async list(prefix: string): Promise<StoredObject[]> {
    const found: StoredObject[] = [];
    let token: string | undefined;

    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.settings.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key !== undefined) {
          found.push({ key: item.Key, size: item.Size ?? 0 });
        }
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);

    return found;
  }

  /**
   * A short-lived download URL.
   *
   * Callers must have passed the consent check before reaching this. There is
   * no other gate — the bucket is not public, no anonymous key exists, and
   * this signature is the only way bytes leave the store.
   */
  async downloadUrl(key: string, seconds = DOWNLOAD_URL_TTL_SECONDS): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.settings.bucket, Key: key }),
      { expiresIn: seconds },
    );
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const named = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    named.name === 'NotFound' ||
    named.name === 'NoSuchKey' ||
    named.$metadata?.httpStatusCode === 404
  );
}

/**
 * Where an object lives.
 *
 * Deliberately says nothing. The dataset is in the prefix so that a seed
 * bucket and a live bucket can share a store without a seed photograph ever
 * being reachable at a live key; the two fan-out levels keep any single
 * listing small on stores that shard by prefix. Everything after that is the
 * hash, which is the object's identity.
 */
export function objectKey(dataset: string, contentHash: string): string {
  return `${dataset}/sha256/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}`;
}

/**
 * Where a part of an in-flight upload lives. Removed once the upload is
 * assembled, and swept by expiry if it never is.
 */
export function stagingKey(sessionId: string, offset: number): string {
  return `staging/${sessionId}/${String(offset).padStart(12, '0')}`;
}

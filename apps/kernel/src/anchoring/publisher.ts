/**
 * Where a root goes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why there is no ledger SDK in package.json.
 *
 * Installing one pulls upwards of 230 packages, among them a beta protobuf
 * build asking for `protobufjs@7.5.4` against the 8.0.0 already in the tree,
 * whose install script this workspace does not run. That is a real
 * correctness and supply-chain cost, taken today, for a code path that
 * cannot be exercised at all until testnet credentials exist.
 *
 * The same argument that put the S3 client behind `ObjectStore` in P5 applies
 * with more force here: nothing in the kernel should know the name of a
 * ledger vendor. So this is a port. A deployment that anchors installs the SDK
 * itself and `HieroPublisher` picks it up at runtime; a deployment that does
 * not gets a kernel with no ledger dependency and batches that sit `pending`,
 * which is the same state a network outage produces and which the retry path
 * already handles.
 *
 * The SDK to install is `@hiero-ledger/sdk`, not `@hashgraph/sdk`. Same client
 * library under Linux Foundation governance; the Hashgraph-scoped package is
 * the one that has stopped moving. The network is still Hedera and the mirror
 * node hostnames are unchanged, so only the import name differs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const HCS_PUBLISHER = Symbol('HCS_PUBLISHER');

/** What the network gives back, and the only part of it we keep. */
export interface PublishReceipt {
  topicId: string;
  sequenceNumber: string;
  consensusAt: Date;
  transactionId: string | null;
}

export interface TopicPublisher {
  readonly network: 'testnet' | 'mainnet';
  publish(message: string): Promise<PublishReceipt>;
}

/**
 * The message body. Small on purpose — HCS charges by the byte and a root is
 * the whole point. Everything else is here so a reader of the topic alone can
 * tell what the root covers without asking us anything.
 */
export interface AnchorMessage {
  v: 1;
  kind: 'clycites.anchor';
  dataset: 'live';
  date: string;
  root: string;
  count: number;
  /** How the leaves were built, so a verifier is not guessing. */
  alg: 'sha256/salted-leaf/v1';
}

export const encodeMessage = (message: AnchorMessage): string =>
  JSON.stringify(message);

/* ── the HTTP adapter ────────────────────────────────────────────────────── */

/**
 * Publish over HTTP to something that already holds the keys.
 *
 * This is the implementation to prefer, and it is why `TopicPublisher` is as
 * narrow as it is: submit a root, get a transaction id back. Everything a
 * ledger SDK does beyond that is somebody else's problem.
 *
 * ProofLayer already does HCS anchoring and is the natural service to point
 * this at; a small sidecar holding the operator key is the alternative. Either
 * way the kernel keeps no ledger dependency and, more to the point, no
 * operator private key — which is the part of `HieroPublisher` that has to sit
 * in the environment of the process that serves farmer records.
 *
 * The endpoint is expected to answer 2xx with
 * `{ topic_id, sequence_number, consensus_at?, transaction_id? }`.
 */
export interface HttpPublisherSettings {
  network: 'testnet' | 'mainnet';
  /** Absolute URL of the submit endpoint. */
  endpoint: string;
  /** Sent as `Authorization`, verbatim. Null where the hop is already trusted. */
  authorization: string | null;
  /** Beyond this, the batch stays pending and is retried. */
  timeoutMs: number;
}

interface SubmitResponse {
  topic_id?: unknown;
  sequence_number?: unknown;
  consensus_at?: unknown;
  transaction_id?: unknown;
}

export class HttpPublisher implements TopicPublisher {
  constructor(private readonly settings: HttpPublisherSettings) {}

  get network(): 'testnet' | 'mainnet' {
    return this.settings.network;
  }

  async publish(message: string): Promise<PublishReceipt> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.settings.authorization !== null) {
      headers['authorization'] = this.settings.authorization;
    }

    // An abort leaves the batch pending, which is the same state a network
    // outage produces and which the retry path already handles. Hanging here
    // would instead hold the anchor run open indefinitely and produce neither
    // a success nor a failure anyone could act on.
    const response = await fetch(this.settings.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ network: this.settings.network, message }),
      signal: AbortSignal.timeout(this.settings.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `anchor publisher answered ${response.status} — the root is computed but unpublished`,
      );
    }

    const body = (await response.json()) as SubmitResponse;
    const topicId = body.topic_id;
    const sequenceNumber = body.sequence_number;

    // Checked rather than trusted: a receipt without a sequence number cannot
    // be used to find the message on a mirror node, so recording it would
    // store a claim of publication that nobody can check. That is worse than
    // staying pending.
    if (typeof topicId !== 'string' || topicId === '') {
      throw new Error('anchor publisher returned no topic_id');
    }
    if (
      (typeof sequenceNumber !== 'string' && typeof sequenceNumber !== 'number') ||
      sequenceNumber === ''
    ) {
      throw new Error('anchor publisher returned no sequence_number');
    }

    const consensusAt =
      typeof body.consensus_at === 'string' ? new Date(body.consensus_at) : new Date();

    return {
      topicId,
      sequenceNumber: String(sequenceNumber),
      consensusAt: Number.isNaN(consensusAt.getTime()) ? new Date() : consensusAt,
      transactionId:
        typeof body.transaction_id === 'string' ? body.transaction_id : null,
    };
  }
}

/* ── the Hiero adapter ───────────────────────────────────────────────────── */

/**
 * Only what we call. Written out here so this file compiles without the SDK
 * present — the alternative is a dependency carried by every deployment for
 * the benefit of the few that anchor.
 */
interface HieroModule {
  Client: {
    forTestnet(): HieroClient;
    forMainnet(): HieroClient;
  };
  PrivateKey: { fromStringDer(key: string): unknown; fromStringECDSA(key: string): unknown };
  TopicId: { fromString(id: string): unknown };
  TopicMessageSubmitTransaction: new () => HieroSubmit;
}

interface HieroClient {
  setOperator(accountId: string, key: unknown): HieroClient;
  close(): void;
}

interface HieroSubmit {
  setTopicId(id: unknown): HieroSubmit;
  setMessage(message: string): HieroSubmit;
  execute(client: HieroClient): Promise<{
    transactionId: { toString(): string };
    getReceipt(client: HieroClient): Promise<{
      topicSequenceNumber: { toString(): string };
    }>;
  }>;
}

export interface HieroSettings {
  network: 'testnet' | 'mainnet';
  topicId: string;
  accountId: string;
  privateKey: string;
}

export class HieroPublisher implements TopicPublisher {
  constructor(private readonly settings: HieroSettings) {}

  get network(): 'testnet' | 'mainnet' {
    return this.settings.network;
  }

  async publish(message: string): Promise<PublishReceipt> {
    const sdk = await load();
    const client =
      this.settings.network === 'mainnet' ? sdk.Client.forMainnet() : sdk.Client.forTestnet();
    client.setOperator(
      this.settings.accountId,
      sdk.PrivateKey.fromStringDer(this.settings.privateKey),
    );

    try {
      const response = await new sdk.TopicMessageSubmitTransaction()
        .setTopicId(sdk.TopicId.fromString(this.settings.topicId))
        .setMessage(message)
        .execute(client);

      const receipt = await response.getReceipt(client);
      return {
        topicId: this.settings.topicId,
        sequenceNumber: receipt.topicSequenceNumber.toString(),
        // The SDK's consensus timestamp is on the record, not the receipt, and
        // fetching a record costs a second query. The sequence number is what
        // makes the message findable on a mirror node, and the mirror node is
        // where an independent verifier should be looking anyway.
        consensusAt: new Date(),
        transactionId: response.transactionId.toString(),
      };
    } finally {
      client.close();
    }
  }
}

async function load(): Promise<HieroModule> {
  try {
    return (await import('@hiero-ledger' + '/sdk')) as unknown as HieroModule;
  } catch {
    throw new Error(
      'anchoring is configured but @hiero-ledger/sdk is not installed — ' +
        'install it in the deployment that publishes roots',
    );
  }
}

/**
 * Where a root goes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why there is no `@hashgraph/sdk` in package.json.
 *
 * Installing it pulls 232 packages, among them `@hashgraph/proto`
 * 2.26.0-beta.3, which asks for `protobufjs@7.5.4` against the 8.0.0 already in
 * the tree and whose install script this workspace does not run. That is a
 * real correctness and supply-chain cost, taken today, for a code path that
 * cannot be exercised at all until testnet credentials exist.
 *
 * The same argument that put the S3 client behind `ObjectStore` in P5 applies
 * with more force here: nothing in the kernel should know the name of a
 * ledger vendor. So this is a port. A deployment that anchors installs the SDK
 * itself and `HederaPublisher` picks it up at runtime; a deployment that does
 * not gets a kernel with no ledger dependency and batches that sit `pending`,
 * which is the same state a network outage produces and which the retry path
 * already handles.
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

/* ── the Hedera adapter ───────────────────────────────────────────────────── */

/**
 * Only what we call. Written out here so this file compiles without the SDK
 * present — the alternative is a dependency carried by every deployment for
 * the benefit of the few that anchor.
 */
interface HederaModule {
  Client: {
    forTestnet(): HederaClient;
    forMainnet(): HederaClient;
  };
  PrivateKey: { fromStringDer(key: string): unknown; fromStringECDSA(key: string): unknown };
  TopicId: { fromString(id: string): unknown };
  TopicMessageSubmitTransaction: new () => HederaSubmit;
}

interface HederaClient {
  setOperator(accountId: string, key: unknown): HederaClient;
  close(): void;
}

interface HederaSubmit {
  setTopicId(id: unknown): HederaSubmit;
  setMessage(message: string): HederaSubmit;
  execute(client: HederaClient): Promise<{
    transactionId: { toString(): string };
    getReceipt(client: HederaClient): Promise<{
      topicSequenceNumber: { toString(): string };
    }>;
  }>;
}

export interface HederaSettings {
  network: 'testnet' | 'mainnet';
  topicId: string;
  accountId: string;
  privateKey: string;
}

export class HederaPublisher implements TopicPublisher {
  constructor(private readonly settings: HederaSettings) {}

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

async function load(): Promise<HederaModule> {
  try {
    return (await import('@hashgraph' + '/sdk')) as unknown as HederaModule;
  } catch {
    throw new Error(
      'anchoring is configured but @hashgraph/sdk is not installed — ' +
        'install it in the deployment that publishes roots',
    );
  }
}

import { z } from 'zod';

import { DEFAULT_MASS_BALANCE_TOLERANCE } from './records/mass-balance.js';
import { DEFAULT_SUPERSESSION_MAX_DEPTH } from './records/lineage.js';

/**
 * Environment configuration. Validated with the same library the records are
 * validated with — but note this is process configuration, not a core record,
 * so it does not belong in @clycites/schema.
 */
/** An optional string where blank and absent mean the same thing. */
const unset = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value));

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  /** Required by migrate-cli, but never supplied to the request-serving process. */
  MIGRATOR_DATABASE_URL: z.string().min(1).optional(),
  /** Required by migrate-cli to provision the restricted application role. */
  KERNEL_APP_PASSWORD: z.string().min(1).optional(),
  /**
   * The read-only role the training path connects as (migration 0028). It has
   * no privileges on the inference schema, which is what makes "training never
   * sees a prediction" a database fact rather than a filter someone remembers.
   *
   * Optional here and required by the migrator, which is where it is actually
   * used. An instance that only serves requests never provisions the role and
   * has no business holding the credential.
   */
  KERNEL_TRAINING_PASSWORD: z.string().min(1).optional(),
  /**
   * Connection string for that role. Absent in deployments that do not run a
   * training path, in which case the training queries are simply unavailable —
   * which is the safe direction to fail in.
   */
  TRAINING_DATABASE_URL: z.string().min(1).optional(),
  PARTITION_MONTHS_AHEAD: z.coerce.number().int().min(1).default(24),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /**
   * Spec §9.1. Unexplained shrinkage above this fraction of a lot's opening
   * weight is surfaced. The default is a guess — roughly the moisture loss a
   * coop would not remark on — and stays a guess until the field validation in
   * §13 produces a real number. It is configurable so that number can be
   * adopted without a deploy of new code, and so different commodities can be
   * run at different thresholds while that is being worked out.
   */
  MASS_BALANCE_TOLERANCE: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_MASS_BALANCE_TOLERANCE),
  /**
   * Spec §8 rule 3. How many corrections one record may accumulate before the
   * chain is refused.
   *
   * A bound is needed because every default read resolves chains to their tip,
   * so an unbounded chain is a denial of service against reads of every other
   * record too. 64 is well past any plausible correction history — a delivery
   * corrected sixty-four times is a dispute, not a record — and it is a
   * parameter rather than a constant so an instance that meets a legitimate
   * long chain can raise it without a deploy, and so the read-side walks and
   * the ingest-side check cannot drift apart.
   */
  SUPERSESSION_MAX_DEPTH: z.coerce
    .number()
    .int()
    .min(2)
    .default(DEFAULT_SUPERSESSION_MAX_DEPTH),
  /**
   * Whether this instance will accept writes marked `dataset: 'seed'`.
   *
   * Off means the dataset header is ignored outright, so a production instance
   * cannot be poisoned with fabricated records however the request is dressed
   * up. It is deliberately a literal `'true'` rather than anything coercible:
   * `z.coerce.boolean()` treats every non-empty string as true, which would
   * turn a stray `SEED_INGEST_ENABLED=no` into a live seeding switch.
   */
  SEED_INGEST_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * Emergency/staging guard for every live-corpus mutation at the HTTP edge.
   * Production remains permissive unless an operator explicitly disables it.
   */
  LIVE_INGEST_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  DEPLOYMENT_ENVIRONMENT: z
    .enum(['production', 'staging', 'development'])
    .default('production'),
  /** `username:password` for the Prometheus endpoint. Absent means hidden. */
  METRICS_BASIC_AUTH: unset,
  /**
   * Requests per window per address against `/v1/registry`, the only surface
   * with no authenticated caller behind it. The registry is immutable and
   * served with a day-long `Cache-Control`, so a well-behaved consumer fetches
   * a factor once; a limit this generous only catches something that is not
   * caching. Counted in process memory — see rate-limit.middleware.ts.
   */
  REGISTRY_RATE_LIMIT: z.coerce.number().int().min(1).default(600),
  REGISTRY_RATE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  /**
   * How long a registry response stays in the in-process cache. The rows are
   * immutable once written, so the only thing that can change an answer is a
   * migration inserting new ones — and a migration is followed by a deploy,
   * which empties the cache anyway. Ten minutes bounds the window in which a
   * long-lived process could serve a list that has since grown.
   */
  REGISTRY_CACHE_SECONDS: z.coerce.number().int().min(0).default(600),
  /**
   * Where the audit log is copied to, off this box. Empty means it is not.
   *
   * The database copy is the statutory record and is written synchronously.
   * This is the tamper-evidence copy: its value is that it sits somewhere an
   * operator with credentials to this database cannot reach, so an entry
   * removed here can still be shown to have existed. Shipping is therefore
   * best-effort by design and never blocks a request — see audit.shipper.ts.
   */
  AUDIT_SHIP_URL: z.string().default(''),
  /**
   * Bearer token for that endpoint. Never logged, never echoed, and absent
   * from .env.example on purpose.
   */
  AUDIT_SHIP_TOKEN: z.string().default(''),
  AUDIT_SHIP_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(10),
  AUDIT_SHIP_BATCH: z.coerce.number().int().min(1).max(1000).default(200),
  /**
   * The entire s.9 question, isolated to one boolean.
   *
   * s.9(1) makes financial information special personal data, prohibited
   * outside s.9(3). s.9(3)(c) exempts a body relating to individuals who are
   * its members, provided nothing is disclosed to a third party without
   * consent — which describes a cooperative and describes this kernel's
   * architecture. Whether that limb reaches a coop processing its members'
   * prices and obligations is a question for counsel, not for us.
   *
   * True means member-body access to a priced Delivery, an Obligation or a
   * SettlementReference needs a grant on top of the membership. False means
   * the membership alone suffices.
   *
   * FAIL CLOSED. Default true. Do not flip it without a written answer — the
   * cost of being wrong in this direction is that coops collect consent at
   * enrolment, which they should be doing anyway; the cost of being wrong in
   * the other direction is unlawful processing of special data.
   */
  S9_CONSENT_REQUIRED_FOR_MEMBER_BODY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  NODE_ENV: z.string().default('development'),

  // `.env.example` ships these keys blank so an operator can see the full set.
  // A blank line means "not configured", not "configured as the empty string" —
  // without this, copying the example file produces a kernel that refuses to
  // start, which is how a documentation file becomes a boot failure.

  // ── the object store (work order H) ───────────────────────────────────────
  //
  // All optional, and all read by MediaModule directly rather than from here.
  // They are declared so that `.env.example` and this schema stay in step —
  // test/ops/exposure.test.ts checks that every documented variable is one the
  // kernel actually reads — and so an operator can see the full set in one
  // place.
  //
  // A kernel with none of these set starts normally and answers 503 on the
  // media endpoints. Media is one concern of twelve; a missing bucket
  // credential must not take the consent module down with it.
  MEDIA_S3_ENDPOINT: unset,
  MEDIA_S3_BUCKET: unset,
  MEDIA_S3_ACCESS_KEY: unset,
  MEDIA_S3_SECRET_KEY: unset,
  MEDIA_S3_REGION: unset,
  MEDIA_S3_PATH_STYLE: unset,

  // Anchoring. Same arrangement as media: read by AnchoringModule directly,
  // declared here so `.env.example` and this schema stay in step, and all
  // optional — a kernel with none of them set records and reads normally and
  // simply never publishes a root.
  //
  // Testnet is the default and mainnet is not a config change. Moving to
  // mainnet needs ANCHOR_NETWORK=mainnet *and* ANCHOR_MAINNET_ACKNOWLEDGED set
  // to the exact sentence below, because the thing being made permanent is
  // other people's farm records on a ledger nobody can edit, and one
  // mistyped environment variable should not be able to do that.
  ANCHOR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  ANCHOR_TOPIC_ID: unset,
  ANCHOR_OPERATOR_ID: unset,
  ANCHOR_OPERATOR_KEY: unset,
  ANCHOR_MAINNET_ACKNOWLEDGED: unset,
});

export type KernelConfig = z.infer<typeof Env>;

/** Nest injection token. Tests construct services directly and pass a literal. */
export const KERNEL_CONFIG = Symbol('KERNEL_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KernelConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid environment configuration — ${detail}`);
  }
  // A copied .env is the ordinary way this happens, and nothing downstream
  // would report it: seeded records are well formed and indistinguishable from
  // real ones once written, and the log is append-only. Refusing to start is
  // the last point at which it is still cheap.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.SEED_INGEST_ENABLED) {
    throw new Error(
      'refusing to start: SEED_INGEST_ENABLED is true in production. ' +
        'Fabricated records cannot be removed from an append-only log.',
    );
  }
  return parsed.data;
}

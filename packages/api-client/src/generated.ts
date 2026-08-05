// Generated from apps/kernel/openapi.json. Do not edit.
import type * as Schema from '@clycites/schema';

export const API_VERSION = "0.1.0" as const;

export type paths = {
    readonly "/anchors/{id}/proof": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Proof that one record is under a published root
         * @description Recompute the root yourself: hash the record body canonically, prepend the salt to get the leaf, then fold the path — left siblings on the left, right on the right, each step prefixed 0x01 — and compare the result against the root published to the consensus service. If they agree, that record existed, unchanged, on that day, and you did not have to take our word for any of it.
         *
         *     The path is sibling hashes and nothing else: no other record’s id, type or contents appears here, which is the property the whole scheme exists for.
         *
         *     Behind the ordinary read check, because the proof carries the record’s salt, and the salt is what stops a leaf hash being ground out from a name, a weight and a date. A caller who may not read the record gets 404 — as does a record that has not been anchored yet, because distinguishing the two would confirm it exists.
         */
        readonly get: operations["anchorProof"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/anchors/roots": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Every published Merkle root
         * @description Unauthenticated on purpose, for the same reason the registry is: a root you need our permission to see is a root you are trusting us for. Each entry names the day it covers, the number of records in it, and where the root was published — enough to read the same value off the ledger without asking us again. A root discloses nothing about the records under it.
         */
        readonly get: operations["publishedRoots"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/clients/authorisations": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** List this party’s client authorisations */
        readonly get: operations["listClientAuthorisations"];
        readonly put?: never;
        /** Authorise a client to act for this party */
        readonly post: operations["authoriseClient"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/clients/authorisations/{id}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post?: never;
        /** Revoke a client authorisation */
        readonly delete: operations["revokeClientAuthorisation"];
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/consent/grants": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * What this subject has permitted
         * @description Scoped to the verified subject and never widenable. A grant is personal data about the person who gave it, so this is part of their subject-access answer — and a grantee able to list a subject’s grants could enumerate everybody else that subject deals with.
         */
        readonly get: operations["listOwnGrants"];
        readonly put?: never;
        /**
         * Give consent
         * @description The subject is the verified subject, never a body field. Purpose-bound: a grant for credit assessment is not a grant for market intelligence, and the kernel never widens one to cover another.
         */
        readonly post: operations["grantConsent"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/consent/grants/{id}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post?: never;
        /**
         * Withdraw consent
         * @description Nothing is deleted and nothing is updated. A withdrawal is a new row beside the grant, so a subject who withdraws in August can still show they had consented in July.
         */
        readonly delete: operations["revokeConsent"];
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/devices": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Register a device
         * @description Idempotent. Re-registering the same device to the same party returns 200; claiming a device id already held by another party is a conflict.
         */
        readonly post: operations["registerDevice"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/field/confirmation-requests": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** List this cooperative’s confirmation requests */
        readonly get: operations["listConfirmationRequests"];
        readonly put?: never;
        /**
         * Queue a farmer confirmation prompt
         * @description Queues work for the external USSD adapter. The officer’s device never receives or submits the farmer’s PIN.
         */
        readonly post: operations["requestDeliveryConfirmation"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/field/events": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Record one bounded field-use signal
         * @description The closed schema has no payload or free-text field, so farmer data cannot be sent as analytics.
         */
        readonly post: operations["recordFieldEvent"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/health": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Liveness */
        readonly get: operations["health"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/inferences": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Write a model output
         * @description A separate route from POST /records, because the two record classes never mix. `inference_depth` is computed by the kernel as 1 + max(depth of inputs) and any submitted value is discarded; a depth above 1 is flagged, not refused. `validated_by` and `stale` are likewise discarded — both are derived on read.
         */
        readonly post: operations["submitInference"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/inferences/{id}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Fetch an inference by id
         * @description Inferences live in their own namespace and never appear in a record read. Asking for one is deliberate.
         */
        readonly get: operations["getInference"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/inferences/{id}/validations": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** What later observations said about this prediction */
        readonly get: operations["listValidations"];
        readonly put?: never;
        /**
         * Link the observation that settled a prediction
         * @description The prediction acquires a verdict and remains a prediction. There is no path from here into the fact log. Idempotent on (inference, observation): re-linking the same pair returns the row already recorded, so an evaluation set cannot be revised by replay.
         */
        readonly post: operations["validateInference"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/media": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Open a resumable upload
         * @description Declares the SHA-256, the type and the length before any byte is sent, so a file that will be refused is refused before it is paid for. The declared hash is of the file as it leaves the device; the hash the kernel stores and anchors is computed after metadata is stripped, and the two differ whenever the file carried any. Both are returned when the upload completes.
         */
        readonly post: operations["beginUpload"];
        readonly delete?: never;
        /**
         * What this kernel will accept
         * @description The tus discovery request. `Clycites-Accept-Types` and `Clycites-Max-Chunk` are extensions: a client on a metered link needs to know the chunk ceiling before it starts, and needs to know the type is acceptable before it spends the bytes.
         */
        readonly options: operations["mediaCapabilities"];
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/media/{hash}/url": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * A short-lived link to the bytes
         * @description The bucket is not public and no object is reachable without passing through here. The answer is decided by the records that cite the object: a caller who may read at least one of them gets a signed URL valid for minutes, and everyone else gets 404 — not 403, which would confirm the photograph exists. The disclosure is logged, so it appears in the subject’s own disclosure list alongside record reads.
         */
        readonly get: operations["mediaUrl"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/media/{id}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        /**
         * How much of my upload arrived
         * @description The resume point. A client that lost the network mid-file asks this and continues from the returned offset. Only the party that opened the session may ask; anyone else gets 404.
         */
        readonly head: operations["uploadOffset"];
        /**
         * Send the next piece
         * @description A chunk at any offset other than the current one is a conflict, not a correction — accepting it would let a retry that crossed with a success silently duplicate bytes. On the last chunk the kernel verifies the hash, checks the bytes really are the type declared, strips metadata and stores the result; the response then carries the content hash to cite.
         */
        readonly patch: operations["appendChunk"];
        readonly trace?: never;
    };
    readonly "/metrics": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Prometheus metrics
         * @description Normalized mass grouped by the basis of the conversion behind it, and the share of it resting on an unverified default factor. A high assumed share is the honest state of the unit registry, not a fault in the endpoint.
         */
        readonly get: operations["metrics"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/objections": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** What this subject has objected to */
        readonly get: operations["listOwnObjections"];
        readonly put?: never;
        /**
         * Object to processing
         * @description May be lodged for another party under a delegation — `on_behalf_of` with `delegation` — because a farmer with no smartphone must still be able to object. The response enumerates what stopped and what continues, with the ground named for each.
         */
        readonly post: operations["lodgeObjection"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/objections/{id}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post?: never;
        /**
         * Re-consent
         * @description The subject only, and never under a delegation. Lodging an objection protects the subject and may be delegated; withdrawing one removes the protection, and the party best placed to want it removed is the one whose access it restricts. `ussd_confirmation` is not accepted here for the same reason.
         */
        readonly delete: operations["withdrawObjection"];
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/parties/{id}/links": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Identities linked to this party
         * @description Resolved transitively, capped at eight hops, and never collapsed. A longer chain is a matcher that has joined two unrelated clusters, not a person with many aliases.
         */
        readonly get: operations["resolvePartyLinks"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/parties/links": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Assert that two parties are the same person
         * @description The asserter is the verified subject, never a body field: a caller who can name who asserted a link can attribute their guess to somebody else.
         */
        readonly post: operations["assertPartyLink"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/parties/links/{id}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post?: never;
        /**
         * Withdraw a link
         * @description Nothing is deleted. The row keeps who withdrew the link and why, which is what makes linking recoverable where merging is not.
         */
        readonly delete: operations["retractPartyLink"];
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/ready": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Readiness
         * @description Checks that the log is reachable.
         */
        readonly get: operations["ready"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/records": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * List current records
         * @description Superseded and retracted records are absent. Both remain addressable by id.
         */
        readonly get: operations["listRecords"];
        readonly put?: never;
        /**
         * Append a record
         * @description Idempotent on the client-generated id: resubmitting an identical record returns 200 and writes nothing. Reusing an id for different contents is a conflict.
         */
        readonly post: operations["submitRecord"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/records/{id}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Fetch a record by id
         * @description Returns superseded and retracted records too, labelled as such.
         */
        readonly get: operations["getRecord"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/records/{id}/chain": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Walk the supersession chain
         * @description Every version of the record, oldest first, from any point in the chain.
         */
        readonly get: operations["getRecordChain"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/registry/admin-regions": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Administrative boundaries, by vintage */
        readonly get: operations["listAdminRegions"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/registry/admin-regions/{code}/{vintage}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * One region at one boundary vintage
         * @description Both parts are required. Uganda’s districts have subdivided repeatedly, so a bare district code is ambiguous across time and there is deliberately no route that accepts one.
         */
        readonly get: operations["getAdminRegion"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/registry/conversions": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Find conversion factors
         * @description Newest first. No subject header: reference data has no data subject, and requiring a credential to check a weight would make verification depend on our permission.
         */
        readonly get: operations["listConversions"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/registry/conversions/{id}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Fetch one factor and the weighings behind it
         * @description The route a lender uses to check a quantity. A delivery states `raw_value`, `raw_unit` and `normalized_kg` and cites a `conversion_id`; this resolves that id to a factor, a basis, and — where the basis is `measured` — the individual weights, who took them, when, and on what instrument.
         */
        readonly get: operations["getConversion"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/registry/crop-codes": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * The crop vocabulary
         * @description An indirection layer, not a taxonomy. Open decision D1 has not chosen an underlying standard; `external_scheme` and `external_code` are where the mapping will land when it does.
         */
        readonly get: operations["listCropCodes"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/registry/crop-codes/{code}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** One crop code */
        readonly get: operations["getCropCode"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/registry/grading-schemes": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Grading vocabularies */
        readonly get: operations["listGradingSchemes"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/registry/grading-schemes/{scheme}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** One scheme and its permitted values */
        readonly get: operations["getGradingScheme"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/registry/observation-types": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** The observation vocabulary */
        readonly get: operations["listObservationTypes"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/registry/observation-types/{code}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** One observation type, current version */
        readonly get: operations["getObservationType"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/registry/seasons": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * What a season label means, where it is known
         * @description Nearly empty on purpose. Only windows a published source states are in the table; a label with no row returns nothing rather than a plausible guess.
         */
        readonly get: operations["listSeasons"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/registry/seasons/{label}/{code}/{vintage}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * One season window for one region
         * @description Most specific region wins: a district row beats the national one. No match is a 404, not a fallback.
         */
        readonly get: operations["getSeason"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/retention/notices": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * What a party was told, and when
         * @description The subject sees every notice given to them; anybody else sees only the notices they themselves gave, so a cooperative cannot read what a rival told the same farmer. With `as_at`, returns the single notice in force at that moment — which is the question worth asking, since a notice given later does not retroactively become what somebody was told.
         */
        readonly get: operations["retentionNotices"];
        readonly put?: never;
        /**
         * Record the notice given at enrolment
         * @description DPPA s.13(1)(i). Records what a subject was actually told about how long their data will be kept — the wording, the ground, the purposes, the language it was given in and how it reached them. `given_by` is the verified caller and is never taken from the body. Append-only: a changed policy is a new notice, and the earlier one still governs the period before it. Nothing in the kernel acts on `period_stated`; the lawful period is unresolved and no expiry job exists.
         */
        readonly post: operations["giveRetentionNotice"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/subject-access": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Everything held about you
         * @description There is no subject parameter and there must not be one. The answer is assembled for the verified subject and nobody else, because a route that took an id would be a route for enumerating everyone’s records with one compromised token. Where a record involves another individual their particulars are blanked and the record is still returned — s.24(4) and s.24(7) offer redaction, and wholesale refusal is the wrong answer to the commonest shape of record held.
         */
        readonly get: operations["subjectAccess"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/sync/changes": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Pull everything appended since a cursor
         * @description The replication feed, oldest first, scoped to the records the requesting party asserted. Unlike a default read it includes superseded and retracted records, because a device holding a partial copy of the log has to be able to resolve a chain without asking. The cursor is held by the device; the kernel keeps no per-device position.
         */
        readonly get: operations["pullChanges"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/sync/outbox": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Append a batch captured offline
         * @description Every record is processed independently, so one bad record does not strand the rest of a device’s outbox. The response is always 200 when the batch itself was well formed; per-record outcomes are in the body. Replaying a batch is safe.
         */
        readonly post: operations["drainOutbox"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        readonly Account: Schema.Account;
        readonly AccountSubmission: {
            /** Format: uuid */
            readonly account_id: string;
            /** Format: uuid */
            readonly asserted_by: string;
            readonly auth_subject: string;
            /** @default null */
            readonly authenticated_as: string | null;
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            /** Format: uuid */
            readonly primary_party: string;
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** @enum {string} */
            readonly status: "active" | "suspended" | "retired";
            /** @default null */
            readonly supersedes: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "account";
        };
        readonly AdminRegionEntry: {
            readonly code: string;
            readonly level: string;
            readonly name: string;
            readonly parent_code?: string | null;
            readonly parent_vintage?: string | null;
            readonly source?: string | null;
            readonly vintage: string;
        };
        readonly Agreement: Schema.Agreement;
        readonly AgreementSubmission: {
            /** Format: date-time */
            readonly agreed_at: string;
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            readonly commodity: string;
            /** @default null */
            readonly delegation: string | null;
            readonly delivery_window: {
                /** Format: date-time */
                readonly from: string;
                /** Format: date-time */
                readonly to: string;
            };
            /** @default null */
            readonly device_id: string | null;
            /** @default [] */
            readonly evidence: readonly {
                readonly byte_size: number;
                /** @default null */
                readonly capture_location: {
                    /** @default null */
                    readonly accuracy_m: number | null;
                    /** @default null */
                    readonly captured_at: string | null;
                    readonly lat: number;
                    readonly lon: number;
                    /** @enum {string} */
                    readonly source: "gps_device" | "map_pin" | "admin_centroid" | "declared";
                } | null;
                /** @default null */
                readonly captured_at: string | null;
                /** Format: uuid */
                readonly captured_by: string;
                readonly content_hash: string;
                readonly metadata_stripped: boolean;
                readonly mime_type: string;
                readonly storage_ref: string;
            }[];
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly kind: "spot" | "forward" | "contract_farming" | "input_credit" | "offtake";
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            readonly parties: readonly {
                /** Format: uuid */
                readonly party: string;
                /** @enum {string} */
                readonly role: "supplier" | "buyer" | "financier" | "guarantor";
            }[];
            readonly price_terms: {
                /** @enum {string} */
                readonly basis: "fixed" | "indexed" | "floor";
                /** @default null */
                readonly index_ref: string | null;
                /** @default null */
                readonly value: {
                    readonly amount_minor: number;
                    readonly currency: string;
                } | null;
            };
            readonly quantity_committed: {
                /** @default null */
                readonly conversion_id: string | null;
                /** @enum {string} */
                readonly measurement_method: "self_reported" | "field_estimated" | "coop_counted" | "coop_weighed" | "calibrated_weighed" | "counterparty_confirmed" | "third_party_verified";
                /** @default null */
                readonly normalized_kg: number | null;
                /** @default [] */
                readonly quality_flags: readonly string[];
                /** @enum {string} */
                readonly raw_unit: "kg" | "tonne" | "gram" | "litre" | "bag" | "sack" | "basin" | "tin" | "basket" | "bunch" | "heap" | "wheelbarrow" | "jerrycan" | "piece";
                /** @default null */
                readonly raw_unit_label: string | null;
                readonly raw_value: number;
            };
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** @default null */
            readonly season: string | null;
            /** @default null */
            readonly supersedes: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "agreement";
        };
        /** @description Spec §9.1. Where the lot's mass went, reconciled across the custody sequence — every transfer re-weighs the lot, so the sequence is a series of independent measurements of the same produce. Present on lots only. A discrepancy is always stored and served, never a reason to refuse a record. */
        readonly Balance: {
            /** @description The whole-lot ratio was exceeded, or any single leg was. A lot that loses 8% and gains it back nets to zero and is still not clean. */
            readonly breached: boolean;
            readonly closing_kg: number | null;
            /** @description Sum of `loss.declared` Observations against this lot. Losses are events with an author and a time, not fields on the lot. */
            readonly declared_loss_kg: number;
            /** @description A weighing or a loss could not be read in kilograms, or one of them is under an unresolved correction, so the arithmetic is partial. A clean-looking balance on an incomplete ledger means nothing. */
            readonly incomplete: boolean;
            readonly legs: readonly components["schemas"]["BalanceLeg"][];
            readonly opening_kg: number | null;
            /** @description The fraction of the opening weight in force when this was computed. Configurable; the default is a placeholder pending field validation. */
            readonly tolerance: number;
            /** @description Shrinkage nobody accounted for. */
            readonly unexplained_kg: number | null;
        };
        /** @description One hand-over, and what the lot weighed when it happened. */
        readonly BalanceLeg: {
            /** Format: date-time */
            readonly at: string;
            readonly breached: boolean;
            readonly declared_loss_kg: number;
            /** @description Positive means mass went missing. Negative means mass appeared, which is no less interesting. */
            readonly discrepancy_kg: number | null;
            /** @description What it weighed at the previous hand-over, less losses declared since. */
            readonly expected_kg: number | null;
            /** Format: uuid */
            readonly from_party: string;
            /** Format: uuid */
            readonly to_party: string;
            /** Format: uuid */
            readonly transfer: string;
            readonly weighed_kg: number | null;
        };
        readonly BasisOutcome: {
            /** @description Present only where processing continues. Why it continues. */
            readonly ground?: string;
            readonly lawful_basis: string;
            readonly record_type: string;
            readonly records: number;
        };
        readonly Chain: {
            /** @description Every version of the record, oldest first. */
            readonly records: readonly components["schemas"]["RecordView"][];
        };
        readonly Changes: {
            readonly has_more: boolean;
            readonly next_cursor: string | null;
            readonly records: readonly components["schemas"]["RecordView"][];
        };
        readonly Client: {
            readonly client_id: string;
            readonly display_name: string;
            /** Format: uuid */
            readonly id: string;
            /** Format: uuid */
            readonly owner_party: string;
            /** Format: date-time */
            readonly recorded_at: string;
            readonly scopes: readonly ("records:read" | "records:write" | "registry:read" | "media:read" | "media:write" | "sync")[];
            /** @enum {string} */
            readonly status: "active" | "suspended" | "retired";
        };
        readonly ClientAuthorisation: {
            readonly client_id: string;
            /** Format: date-time */
            readonly expires_at?: string | null;
            /** Format: date-time */
            readonly granted_at: string;
            readonly granted_via: string;
            /** Format: uuid */
            readonly id: string;
            /** Format: uuid */
            readonly party: string;
            /** Format: date-time */
            readonly revoked_at?: string | null;
            readonly scopes: readonly ("records:read" | "records:write" | "registry:read" | "media:read" | "media:write" | "sync")[];
        };
        readonly ConfirmationRequest: {
            readonly attempts: number;
            readonly client_id: string;
            /** @enum {string} */
            readonly dataset: "live" | "seed";
            /** Format: uuid */
            readonly delivery: string;
            /** Format: uuid */
            readonly id: string;
            readonly last_error?: string | null;
            /** Format: date-time */
            readonly requested_at: string;
            /** Format: uuid */
            readonly requested_by: string;
            /** @enum {string} */
            readonly status: "queued" | "sent" | "failed";
            /** Format: date-time */
            readonly updated_at: string;
        };
        /** @description One subject permitting one grantee to use records of named types for one named purpose. Purpose-bound and never widened. Withdrawal fills `revoked_at` from a separate row; the grant itself is never edited, because a consent record that could be edited is not evidence of anything. */
        readonly ConsentGrant: {
            /** @enum {string} */
            readonly dataset?: "live" | "seed";
            readonly evidence?: readonly unknown[];
            /** Format: date-time */
            readonly expires_at?: string | null;
            /** Format: date-time */
            readonly granted_at: string;
            /**
             * @description How the subject actually said yes. A grant nobody can evidence is not one.
             * @enum {string}
             */
            readonly granted_via: "in_person_signature" | "ussd_confirmation" | "witnessed";
            /** Format: uuid */
            readonly grantee: string;
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly purpose: "credit_assessment" | "insurance_underwriting" | "input_supply" | "market_intelligence" | "traceability_claim" | "advisory" | "research" | "regulatory_reporting";
            /** @description A grant over deliveries is not a grant over harvests. There is no wildcard. */
            readonly record_types: readonly string[];
            /**
             * Format: date-time
             * @description Resolved at request time, not at grant time: a grant withdrawn before the read does not authorise it.
             */
            readonly revoked_at?: string | null;
            /** Format: uuid */
            readonly subject: string;
        };
        /** @description One weighing. Present only where somebody actually weighed. */
        readonly ConversionSample: {
            /** @description The state of that container, e.g. `damp,tight`. Per sample, because one damp bag among eleven dry ones is the observation that explains the spread. */
            readonly condition: string | null;
            readonly ordinal: number;
            readonly weight_kg: number;
        };
        readonly CropCodeEntry: {
            readonly code: string;
            readonly external_code?: string | null;
            readonly external_scheme?: string | null;
            readonly label: string;
            readonly parent_code?: string | null;
        };
        /** @description How the kernel arrived at `record.custodian`. Present on lots only. */
        readonly Custody: {
            /**
             * Format: date-time
             * @description When the current holder took it. Null if nothing moved.
             */
            readonly as_of: string | null;
            /**
             * Format: uuid
             * @description The custodian named when the lot was created. Kept so the derived answer never erases the claimed one.
             */
            readonly asserted: string;
            /** @description A transfer moved the lot from a party who was not holding it. Two simultaneous transfers present this way too. Surfaced, never resolved. */
            readonly broken: boolean;
            /**
             * Format: uuid
             * @description Who holds the lot now, per the transfer chain.
             */
            readonly custodian: string;
            /** @description A transfer in the sequence was corrected two ways at once and was left out of the walk, so `custodian` is where the lot got to before the dispute and not necessarily where it is. */
            readonly forked: boolean;
            readonly transfers: number;
        };
        readonly CustodyTransfer: Schema.CustodyTransfer;
        readonly CustodyTransferSubmission: {
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            /** @default [] */
            readonly evidence: readonly {
                readonly byte_size: number;
                /** @default null */
                readonly capture_location: {
                    /** @default null */
                    readonly accuracy_m: number | null;
                    /** @default null */
                    readonly captured_at: string | null;
                    readonly lat: number;
                    readonly lon: number;
                    /** @enum {string} */
                    readonly source: "gps_device" | "map_pin" | "admin_centroid" | "declared";
                } | null;
                /** @default null */
                readonly captured_at: string | null;
                /** Format: uuid */
                readonly captured_by: string;
                readonly content_hash: string;
                readonly metadata_stripped: boolean;
                readonly mime_type: string;
                readonly storage_ref: string;
            }[];
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly from_party: string;
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            readonly location: string | {
                /** @default null */
                readonly accuracy_m: number | null;
                /** @default null */
                readonly captured_at: string | null;
                readonly lat: number;
                readonly lon: number;
                /** @enum {string} */
                readonly source: "gps_device" | "map_pin" | "admin_centroid" | "declared";
            };
            /** Format: uuid */
            readonly lot: string;
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            readonly quantity: {
                /** @default null */
                readonly conversion_id: string | null;
                /** @enum {string} */
                readonly measurement_method: "self_reported" | "field_estimated" | "coop_counted" | "coop_weighed" | "calibrated_weighed" | "counterparty_confirmed" | "third_party_verified";
                /** @default null */
                readonly normalized_kg: number | null;
                /** @default [] */
                readonly quality_flags: readonly string[];
                /** @enum {string} */
                readonly raw_unit: "kg" | "tonne" | "gram" | "litre" | "bag" | "sack" | "basin" | "tin" | "basket" | "bunch" | "heap" | "wheelbarrow" | "jerrycan" | "piece";
                /** @default null */
                readonly raw_unit_label: string | null;
                readonly raw_value: number;
            };
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** @default null */
            readonly supersedes: string | null;
            /** Format: uuid */
            readonly to_party: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "custody_transfer";
        };
        readonly Delegation: Schema.Delegation;
        readonly DelegationSubmission: {
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            /** Format: uuid */
            readonly delegate: string;
            /** @default null */
            readonly delegation: string | null;
            /** Format: uuid */
            readonly delegator: string;
            /** @default null */
            readonly device_id: string | null;
            /** @default [] */
            readonly evidence: readonly {
                readonly byte_size: number;
                /** @default null */
                readonly capture_location: {
                    /** @default null */
                    readonly accuracy_m: number | null;
                    /** @default null */
                    readonly captured_at: string | null;
                    readonly lat: number;
                    readonly lon: number;
                    /** @enum {string} */
                    readonly source: "gps_device" | "map_pin" | "admin_centroid" | "declared";
                } | null;
                /** @default null */
                readonly captured_at: string | null;
                /** Format: uuid */
                readonly captured_by: string;
                readonly content_hash: string;
                readonly metadata_stripped: boolean;
                readonly mime_type: string;
                readonly storage_ref: string;
            }[];
            /** @default null */
            readonly expires_at: string | null;
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: date-time */
            readonly granted_at: string;
            /** @enum {string} */
            readonly granted_via: "in_person_signature" | "ussd_confirmation" | "witnessed" | "organisational_bylaw";
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            /** @constant */
            readonly record_class: "observation";
            /** @default null */
            readonly revoked_at: string | null;
            readonly schema_version: string;
            readonly scope: readonly string[];
            /** @default null */
            readonly supersedes: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "delegation";
        };
        readonly Delivery: Schema.Delivery;
        readonly DeliveryConfirmation: Schema.DeliveryConfirmation;
        readonly DeliveryConfirmationSubmission: {
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            /** @enum {string} */
            readonly channel: "ussd_pin" | "in_person" | "written" | "app";
            /** Format: uuid */
            readonly confirming_party: string;
            /** @default null */
            readonly delegation: string | null;
            /** Format: uuid */
            readonly delivery: string;
            /** @default null */
            readonly device_id: string | null;
            /** @default [] */
            readonly evidence: readonly {
                readonly byte_size: number;
                /** @default null */
                readonly capture_location: {
                    /** @default null */
                    readonly accuracy_m: number | null;
                    /** @default null */
                    readonly captured_at: string | null;
                    readonly lat: number;
                    readonly lon: number;
                    /** @enum {string} */
                    readonly source: "gps_device" | "map_pin" | "admin_centroid" | "declared";
                } | null;
                /** @default null */
                readonly captured_at: string | null;
                /** Format: uuid */
                readonly captured_by: string;
                readonly content_hash: string;
                readonly metadata_stripped: boolean;
                readonly mime_type: string;
                readonly storage_ref: string;
            }[];
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** @default null */
            readonly note: string | null;
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** @default null */
            readonly supersedes: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "delivery_confirmation";
        };
        readonly DeliverySubmission: {
            /** @default null */
            readonly agreed_price: {
                readonly amount_minor: number;
                readonly currency: string;
            } | null;
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            readonly commodity: string;
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            /** @default [] */
            readonly evidence: readonly {
                readonly byte_size: number;
                /** @default null */
                readonly capture_location: {
                    /** @default null */
                    readonly accuracy_m: number | null;
                    /** @default null */
                    readonly captured_at: string | null;
                    readonly lat: number;
                    readonly lon: number;
                    /** @enum {string} */
                    readonly source: "gps_device" | "map_pin" | "admin_centroid" | "declared";
                } | null;
                /** @default null */
                readonly captured_at: string | null;
                /** Format: uuid */
                readonly captured_by: string;
                readonly content_hash: string;
                readonly metadata_stripped: boolean;
                readonly mime_type: string;
                readonly storage_ref: string;
            }[];
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly from_party: string;
            /** @default null */
            readonly fulfils: string | null;
            /** @default null */
            readonly grade: {
                /** Format: uuid */
                readonly assessed_by: string;
                readonly method: string;
                readonly scheme: string;
                readonly value: string;
            } | null;
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            readonly location: string | {
                /** @default null */
                readonly accuracy_m: number | null;
                /** @default null */
                readonly captured_at: string | null;
                readonly lat: number;
                readonly lon: number;
                /** @enum {string} */
                readonly source: "gps_device" | "map_pin" | "admin_centroid" | "declared";
            };
            /** @default null */
            readonly lot: string | null;
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            readonly quantity: {
                /** @default null */
                readonly conversion_id: string | null;
                /** @enum {string} */
                readonly measurement_method: "self_reported" | "field_estimated" | "coop_counted" | "coop_weighed" | "calibrated_weighed" | "counterparty_confirmed" | "third_party_verified";
                /** @default null */
                readonly normalized_kg: number | null;
                /** @default [] */
                readonly quality_flags: readonly string[];
                /** @enum {string} */
                readonly raw_unit: "kg" | "tonne" | "gram" | "litre" | "bag" | "sack" | "basin" | "tin" | "basket" | "bunch" | "heap" | "wheelbarrow" | "jerrycan" | "piece";
                /** @default null */
                readonly raw_unit_label: string | null;
                readonly raw_value: number;
            };
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** @default null */
            readonly supersedes: string | null;
            /** Format: uuid */
            readonly to_party: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "delivery";
        };
        readonly Device: {
            /** Format: uuid */
            readonly device_id: string;
            readonly label: string;
            /** Format: date-time */
            readonly registered_at: string;
            /** Format: uuid */
            readonly registered_by: string;
        };
        readonly DeviceRegistration: {
            /**
             * Format: uuid
             * @description Generated on the device. The kernel never issues one.
             */
            readonly device_id: string;
            readonly label: string;
            /** Format: uuid */
            readonly registered_by: string;
        };
        readonly Disclosure: {
            /** @description Which permission was leaned on. Whether somebody read a record on a grant the subject gave or on a membership they never agreed to is the part a subject would act on. */
            readonly access: string | null;
            /** Format: uuid */
            readonly actor: string | null;
            /** Format: date-time */
            readonly occurred_at: string;
            readonly purpose: string | null;
            readonly record_types: readonly string[];
            readonly records: readonly string[];
        };
        readonly DrainReport: {
            /** @description One entry per submitted record, in the order they were sent. */
            readonly results: readonly components["schemas"]["DrainResult"][];
        };
        readonly DrainResult: {
            readonly code?: string;
            readonly detail?: string;
            /** Format: uuid */
            readonly id: string | null;
            readonly issues?: readonly {
                readonly message: string;
                readonly path: string;
            }[];
            /** @enum {string} */
            readonly outcome: "accepted" | "replayed" | "rejected";
        };
        readonly Facility: Schema.Facility;
        readonly FacilitySubmission: {
            readonly admin_region: {
                readonly code: string;
                readonly vintage: string;
            };
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            /** @default null */
            readonly capacity: {
                /** @default null */
                readonly conversion_id: string | null;
                /** @enum {string} */
                readonly measurement_method: "self_reported" | "field_estimated" | "coop_counted" | "coop_weighed" | "calibrated_weighed" | "counterparty_confirmed" | "third_party_verified";
                /** @default null */
                readonly normalized_kg: number | null;
                /** @default [] */
                readonly quality_flags: readonly string[];
                /** @enum {string} */
                readonly raw_unit: "kg" | "tonne" | "gram" | "litre" | "bag" | "sack" | "basin" | "tin" | "basket" | "bunch" | "heap" | "wheelbarrow" | "jerrycan" | "piece";
                /** @default null */
                readonly raw_unit_label: string | null;
                readonly raw_value: number;
            } | null;
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly kind: "collection_point" | "store" | "warehouse" | "weighbridge" | "market" | "processing" | "dry_yard";
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            readonly location: {
                /** @default null */
                readonly accuracy_m: number | null;
                /** @default null */
                readonly captured_at: string | null;
                readonly lat: number;
                readonly lon: number;
                /** @enum {string} */
                readonly source: "gps_device" | "map_pin" | "admin_centroid" | "declared";
            };
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            /** Format: uuid */
            readonly operated_by: string;
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** @default null */
            readonly supersedes: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "facility";
        };
        readonly FieldEvent: {
            /** Format: uuid */
            readonly acting_for: string;
            readonly choice: string;
            readonly client_id: string;
            /** @enum {string} */
            readonly event: "delegation_basis" | "name_collision" | "season_label" | "missing_field" | "flow_abandoned";
            readonly flow?: string | null;
            /** Format: uuid */
            readonly id: string;
            /** Format: date-time */
            readonly recorded_at: string;
            readonly step?: string | null;
        };
        readonly FieldEventSubmission: {
            /** @enum {string} */
            readonly choice: "witnessed_in_person" | "ussd_confirmation" | "organisational_bylaw";
            /** @constant */
            readonly event: "delegation_basis";
        } | {
            /** @enum {string} */
            readonly choice: "created_separate" | "same_as_linked" | "kept_separate";
            /** @constant */
            readonly event: "name_collision";
        } | {
            /** @enum {string} */
            readonly choice: "registry_label" | "officer_label" | "no_label";
            /** @constant */
            readonly event: "season_label";
        } | {
            /** @enum {string} */
            readonly choice: "unsupported";
            /** @constant */
            readonly event: "missing_field";
            /** @enum {string} */
            readonly flow: "enrolment" | "delivery" | "confirmation" | "calibration" | "media" | "sync";
            readonly step: string;
        } | {
            /** @enum {string} */
            readonly choice: "abandoned";
            /** @constant */
            readonly event: "flow_abandoned";
            /** @enum {string} */
            readonly flow: "enrolment" | "delivery" | "confirmation" | "calibration" | "media" | "sync";
            readonly step: string;
        };
        /** @description What the deliveries pointing at this agreement add up to. Present on agreements only. Summed on every read — the agreement stores no counter, because a stored total is wrong the moment a delivery is corrected or retracted. */
        readonly Fulfilment: {
            /** @description Null when the agreement itself was never normalized, in which case the shortfall is unknowable rather than zero. */
            readonly committed_kg: number | null;
            /** @description Of those, how many the counterparty confirmed. Arrival and agreement are different facts. */
            readonly confirmed: number;
            readonly delivered_kg: number;
            /** @description Deliveries counted. Superseded and retracted ones are excluded. */
            readonly deliveries: number;
            /** @description Deliveries under an unresolved correction. A fork has two tips, so neither branch is added to `delivered_kg` and neither is counted in `deliveries`. */
            readonly forked: number;
            /** @description At least one delivery is unconvertible or forked, so `delivered_kg` is a floor and not a total. Any percentage taken from it understates. */
            readonly incomplete: boolean;
            /** @description Negative when more arrived than was committed. Not clamped: an over-delivery is a fact worth seeing. */
            readonly outstanding_kg: number | null;
            readonly over_delivered: boolean;
            /** @description Deliveries whose quantity never reached kilograms. */
            readonly unconvertible: number;
        };
        /** @description Stored opaquely. `ordinal` orders values inside one scheme and carries no meaning across schemes: UNBS Grade 1 and a buyer’s Grade 1 are different claims and the kernel never ranks one against the other. */
        readonly GradingSchemeEntry: {
            readonly label: string;
            readonly owner: string;
            readonly scheme: string;
            readonly source?: string | null;
            /** @description Returned on the single-scheme route only. */
            readonly values?: readonly {
                readonly label?: string | null;
                readonly ordinal?: number | null;
                readonly scheme: string;
                readonly value: string;
            }[];
        };
        readonly Harvest: Schema.Harvest;
        readonly HarvestSubmission: {
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            readonly crop: string;
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** @default null */
            readonly grade: {
                /** Format: uuid */
                readonly assessed_by: string;
                readonly method: string;
                readonly scheme: string;
                readonly value: string;
            } | null;
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            /** @default null */
            readonly planting: string | null;
            /** Format: uuid */
            readonly plot: string;
            readonly quantity: {
                /** @default null */
                readonly conversion_id: string | null;
                /** @enum {string} */
                readonly measurement_method: "self_reported" | "field_estimated" | "coop_counted" | "coop_weighed" | "calibrated_weighed" | "counterparty_confirmed" | "third_party_verified";
                /** @default null */
                readonly normalized_kg: number | null;
                /** @default [] */
                readonly quality_flags: readonly string[];
                /** @enum {string} */
                readonly raw_unit: "kg" | "tonne" | "gram" | "litre" | "bag" | "sack" | "basin" | "tin" | "basket" | "bunch" | "heap" | "wheelbarrow" | "jerrycan" | "piece";
                /** @default null */
                readonly raw_unit_label: string | null;
                readonly raw_value: number;
            };
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** @default null */
            readonly supersedes: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "harvest";
        };
        readonly Health: {
            readonly schema_version?: string;
            readonly status: string;
        };
        /** @description One later observation, and what it said about a prediction. Recorded beside the inference, never merged into it: a verdict is bookkeeping about a claim, not part of it. */
        readonly InferenceValidation: {
            /** Format: uuid */
            readonly id: string;
            /** Format: uuid */
            readonly inference_id: string;
            /** Format: date-time */
            readonly linked_at: string;
            /** Format: uuid */
            readonly linked_by: string;
            readonly note?: string | null;
            /**
             * Format: uuid
             * @description Must be an observation. Linking a prediction to a prediction is refused.
             */
            readonly observation: string;
            /** @enum {string} */
            readonly verdict: "confirmed" | "contradicted" | "inconclusive";
        };
        readonly InferenceValidationSubmission: {
            readonly note?: string | null;
            /** Format: uuid */
            readonly observation: string;
            /** @enum {string} */
            readonly verdict: "confirmed" | "contradicted" | "inconclusive";
        };
        readonly Lot: Schema.Lot;
        readonly LotSubmission: {
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            readonly commodity: string;
            /** @default [] */
            readonly composed_of: readonly {
                /** @enum {string} */
                readonly basis: "physical" | "proportional" | "declared";
                readonly quantity: {
                    /** @default null */
                    readonly conversion_id: string | null;
                    /** @enum {string} */
                    readonly measurement_method: "self_reported" | "field_estimated" | "coop_counted" | "coop_weighed" | "calibrated_weighed" | "counterparty_confirmed" | "third_party_verified";
                    /** @default null */
                    readonly normalized_kg: number | null;
                    /** @default [] */
                    readonly quality_flags: readonly string[];
                    /** @enum {string} */
                    readonly raw_unit: "kg" | "tonne" | "gram" | "litre" | "bag" | "sack" | "basin" | "tin" | "basket" | "bunch" | "heap" | "wheelbarrow" | "jerrycan" | "piece";
                    /** @default null */
                    readonly raw_unit_label: string | null;
                    readonly raw_value: number;
                };
                /** Format: uuid */
                readonly source_ref: string;
                /** @enum {string} */
                readonly source_type: "harvest" | "lot";
            }[];
            /** Format: uuid */
            readonly custodian: string;
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** @default null */
            readonly grade: {
                /** Format: uuid */
                readonly assessed_by: string;
                readonly method: string;
                readonly scheme: string;
                readonly value: string;
            } | null;
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            readonly location: string | {
                /** @default null */
                readonly accuracy_m: number | null;
                /** @default null */
                readonly captured_at: string | null;
                readonly lat: number;
                readonly lon: number;
                /** @enum {string} */
                readonly source: "gps_device" | "map_pin" | "admin_centroid" | "declared";
            };
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            readonly quantity: {
                /** @default null */
                readonly conversion_id: string | null;
                /** @enum {string} */
                readonly measurement_method: "self_reported" | "field_estimated" | "coop_counted" | "coop_weighed" | "calibrated_weighed" | "counterparty_confirmed" | "third_party_verified";
                /** @default null */
                readonly normalized_kg: number | null;
                /** @default [] */
                readonly quality_flags: readonly string[];
                /** @enum {string} */
                readonly raw_unit: "kg" | "tonne" | "gram" | "litre" | "bag" | "sack" | "basin" | "tin" | "basket" | "bunch" | "heap" | "wheelbarrow" | "jerrycan" | "piece";
                /** @default null */
                readonly raw_unit_label: string | null;
                readonly raw_value: number;
            };
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** @default null */
            readonly supersedes: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "lot";
        };
        readonly Membership: Schema.Membership;
        readonly MembershipSubmission: {
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly id: string;
            /** @default null */
            readonly joined_at: string | null;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** @default null */
            readonly left_at: string | null;
            /** Format: uuid */
            readonly member: string;
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            /** Format: uuid */
            readonly organisation: string;
            /** @constant */
            readonly record_class: "observation";
            /** @enum {string} */
            readonly role: "member" | "officer" | "agent" | "supplier";
            readonly schema_version: string;
            /** @default null */
            readonly supersedes: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "membership";
        };
        /** @description An objection to processing under s.7(3). Not the same thing as withdrawing a grant: withdrawal names one grantee and one purpose, an objection is against the processing itself and stops it only where the record’s lawful basis is not one of the s.7(2) grounds. */
        readonly Objection: {
            /** @enum {string} */
            readonly dataset?: "live" | "seed";
            /** Format: uuid */
            readonly delegation?: string | null;
            readonly evidence?: readonly unknown[];
            /** Format: uuid */
            readonly id: string;
            /** Format: date-time */
            readonly lodged_at: string;
            /**
             * Format: uuid
             * @description Not always the subject. An officer may lodge under delegation, because a farmer with no smartphone must still be able to object.
             */
            readonly lodged_by: string;
            /** @enum {string} */
            readonly lodged_via: "in_person" | "ussd_confirmation" | "written";
            /** @description Record types covered, or null for all of them. A farmer objecting to observations about their plot has not objected to the delivery receipts they need for a loan. */
            readonly scope?: readonly string[] | null;
            /** Format: uuid */
            readonly subject: string;
            /** Format: date-time */
            readonly withdrawn_at?: string | null;
        };
        /** @description Both sets, enumerated. Never a boolean: a subject told “done” while a cooperative carries on under contract_performance has been misled, which is worse than a refusal. */
        readonly ObjectionOutcome: {
            readonly continuing: readonly components["schemas"]["BasisOutcome"][];
            /** @description What an objection does not do. Erasure, notifying prior recipients, and the audit log are all outside it, as is another party’s own record of a transaction it was part of. */
            readonly notice: readonly string[];
            readonly objection: components["schemas"]["Objection"];
            readonly stopped: readonly components["schemas"]["BasisOutcome"][];
        };
        readonly Obligation: Schema.Obligation;
        readonly ObligationSubmission: {
            readonly amount: {
                readonly amount_minor: number;
                readonly currency: string;
            };
            readonly arising_from: string;
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            /** @default null */
            readonly due_at: string | null;
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly kind: "payment_for_goods" | "loan_disbursement" | "loan_repayment" | "insurance_premium" | "fee" | "input_credit";
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** Format: uuid */
            readonly obligee: string;
            /** Format: uuid */
            readonly obligor: string;
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** @default null */
            readonly supersedes: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "obligation";
        };
        readonly Observation: Schema.Observation;
        readonly ObservationSubmission: {
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly id: string;
            /** @default null */
            readonly instrument: string | null;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** @default [] */
            readonly media: readonly {
                readonly byte_size: number;
                /** @default null */
                readonly capture_location: {
                    /** @default null */
                    readonly accuracy_m: number | null;
                    /** @default null */
                    readonly captured_at: string | null;
                    readonly lat: number;
                    readonly lon: number;
                    /** @enum {string} */
                    readonly source: "gps_device" | "map_pin" | "admin_centroid" | "declared";
                } | null;
                /** @default null */
                readonly captured_at: string | null;
                /** Format: uuid */
                readonly captured_by: string;
                readonly content_hash: string;
                readonly metadata_stripped: boolean;
                readonly mime_type: string;
                readonly storage_ref: string;
            }[];
            /** @enum {string} */
            readonly method: "lab_tested" | "field_instrument" | "visual" | "reported" | "survey";
            readonly observation_type: string;
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** Format: uuid */
            readonly subject_ref: string;
            /** @enum {string} */
            readonly subject_type: "plot" | "lot" | "party" | "facility" | "region" | "planting";
            /** @default null */
            readonly supersedes: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "observation";
            readonly value: {
                /** @constant */
                readonly kind: "quantity";
                readonly value: {
                    /** @default null */
                    readonly conversion_id: string | null;
                    /** @enum {string} */
                    readonly measurement_method: "self_reported" | "field_estimated" | "coop_counted" | "coop_weighed" | "calibrated_weighed" | "counterparty_confirmed" | "third_party_verified";
                    /** @default null */
                    readonly normalized_kg: number | null;
                    /** @default [] */
                    readonly quality_flags: readonly string[];
                    /** @enum {string} */
                    readonly raw_unit: "kg" | "tonne" | "gram" | "litre" | "bag" | "sack" | "basin" | "tin" | "basket" | "bunch" | "heap" | "wheelbarrow" | "jerrycan" | "piece";
                    /** @default null */
                    readonly raw_unit_label: string | null;
                    readonly raw_value: number;
                };
            } | {
                /** @constant */
                readonly kind: "scalar";
                readonly unit: string;
                readonly value: number;
            } | {
                /** @constant */
                readonly kind: "category";
                readonly value: string;
            } | {
                /** @constant */
                readonly kind: "boolean";
                readonly value: boolean;
            } | {
                /** @constant */
                readonly kind: "text";
                readonly value: string;
            };
        };
        readonly ObservationTypeEntry: {
            readonly code: string;
            readonly label: string;
            /** @description The party accountable for the entry. An unowned vocabulary grows entries nobody can retire. */
            readonly owner: string;
            readonly permitted_methods?: readonly string[];
            readonly source?: string | null;
            readonly subject_types?: readonly string[];
            readonly unit?: string | null;
            readonly value_kind: string;
            readonly version: number;
        };
        readonly Page: {
            readonly next_cursor: string | null;
            readonly records: readonly components["schemas"]["RecordView"][];
        };
        readonly Party: Schema.Party;
        /** @description An assertion that two party ids are the same person. Reversible: a link is withdrawn by retraction, and no record is ever rewritten. Confidence is never a boolean because matching is never a boolean. */
        readonly PartyLink: {
            /** Format: date-time */
            readonly asserted_at?: string;
            /** Format: uuid */
            readonly asserted_by: string;
            readonly confidence: number;
            /**
             * @description The weakest three are named explicitly so a consumer can refuse to act on them.
             * @enum {string}
             */
            readonly evidence: "national_id_match" | "phone_match" | "name_and_region_match" | "declared_by_subject" | "declared_by_organisation" | "assumed";
            readonly evidence_note?: string | null;
            /** Format: uuid */
            readonly id: string;
            readonly lawful_basis?: string;
            /** Format: uuid */
            readonly left_party: string;
            /** @enum {string} */
            readonly relation: "same_as";
            /** Format: date-time */
            readonly retracted_at?: string | null;
            /** Format: uuid */
            readonly retracted_by?: string | null;
            readonly retraction_reason?: string | null;
            /** Format: uuid */
            readonly right_party: string;
        };
        /** @description Everything reachable from a party, and the links that got you there. There is no canonical id and no route that will give you one: merging is not reversible, and a consumer asking for a farmer’s deliveries gets a set plus the links so it can decide for itself. Open decision D2 is deferred, not answered. */
        readonly PartyLinkResolution: {
            /**
             * @description Always false. Present so that no consumer mistakes this for a merged identity.
             * @constant
             */
            readonly collapsed: false;
            /** @description The party asked about first, then everything linked to it. */
            readonly identities: readonly string[];
            readonly links: readonly components["schemas"]["PartyLink"][];
        };
        readonly PartySubmission: {
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            /** @default [] */
            readonly contacts: readonly {
                /** @enum {string} */
                readonly channel: "phone" | "sms" | "ussd" | "email" | "whatsapp";
                readonly value: string;
                /** @default null */
                readonly verified_at: string | null;
            }[];
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            readonly display_name: string;
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly id: string;
            /** @default [] */
            readonly identifiers: readonly {
                /** Format: date-time */
                readonly attested_at: string;
                /** Format: uuid */
                readonly attested_by: string;
                readonly scheme: string;
                readonly value: string;
            }[];
            /** @enum {string} */
            readonly kind: "person" | "cooperative" | "business" | "institution" | "agency";
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            /** @default null */
            readonly primary_region: {
                readonly code: string;
                readonly vintage: string;
            } | null;
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** @default null */
            readonly supersedes: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "party";
        };
        readonly Planting: Schema.Planting;
        readonly PlantingSubmission: {
            readonly area_planted: {
                /** @default null */
                readonly local_unit_label: string | null;
                /** @enum {string} */
                readonly method: "gps_walked" | "map_traced" | "declared" | "derived_from_boundary";
                /** @enum {string} */
                readonly unit: "hectare" | "acre" | "local";
                readonly value: number;
            };
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            readonly crop: string;
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            /** Format: uuid */
            readonly plot: string;
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            readonly season: string;
            /** @default null */
            readonly supersedes: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "planting";
            /** @default null */
            readonly variety: string | null;
        };
        readonly Plot: Schema.Plot;
        readonly PlotSubmission: {
            readonly admin_region: {
                readonly code: string;
                readonly vintage: string;
            };
            readonly area: {
                /** @default null */
                readonly local_unit_label: string | null;
                /** @enum {string} */
                readonly method: "gps_walked" | "map_traced" | "declared" | "derived_from_boundary";
                /** @enum {string} */
                readonly unit: "hectare" | "acre" | "local";
                readonly value: number;
            };
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            /** @default null */
            readonly boundary: readonly (readonly [
                number,
                number
            ])[] | null;
            readonly centroid: {
                /** @default null */
                readonly accuracy_m: number | null;
                /** @default null */
                readonly captured_at: string | null;
                readonly lat: number;
                readonly lon: number;
                /** @enum {string} */
                readonly source: "gps_device" | "map_pin" | "admin_centroid" | "declared";
            };
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly held_by: string;
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** @default null */
            readonly local_name: string | null;
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** @default null */
            readonly supersedes: string | null;
            /** @enum {string} */
            readonly tenure: "owned" | "rented" | "customary" | "borrowed" | "communal" | "unknown";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "plot";
        };
        /** @description RFC 9457 problem details. */
        readonly Problem: {
            readonly code?: string;
            readonly correlation_id?: string;
            readonly detail?: string;
            /** Format: uri-reference */
            readonly instance?: string;
            readonly issues?: readonly {
                readonly message: string;
                readonly path: string;
            }[];
            readonly status: number;
            readonly title: string;
            /** Format: uri-reference */
            readonly type: string;
        };
        readonly Record: components["schemas"]["Account"] | components["schemas"]["Agreement"] | components["schemas"]["CustodyTransfer"] | components["schemas"]["Delegation"] | components["schemas"]["Delivery"] | components["schemas"]["DeliveryConfirmation"] | components["schemas"]["Facility"] | components["schemas"]["Harvest"] | components["schemas"]["Lot"] | components["schemas"]["Membership"] | components["schemas"]["Obligation"] | components["schemas"]["Observation"] | components["schemas"]["Party"] | components["schemas"]["Planting"] | components["schemas"]["Plot"] | components["schemas"]["Retraction"] | components["schemas"]["SettlementReference"];
        readonly RecordSubmission: components["schemas"]["AccountSubmission"] | components["schemas"]["AgreementSubmission"] | components["schemas"]["CustodyTransferSubmission"] | components["schemas"]["DelegationSubmission"] | components["schemas"]["DeliverySubmission"] | components["schemas"]["DeliveryConfirmationSubmission"] | components["schemas"]["FacilitySubmission"] | components["schemas"]["HarvestSubmission"] | components["schemas"]["LotSubmission"] | components["schemas"]["MembershipSubmission"] | components["schemas"]["ObligationSubmission"] | components["schemas"]["ObservationSubmission"] | components["schemas"]["PartySubmission"] | components["schemas"]["PlantingSubmission"] | components["schemas"]["PlotSubmission"] | components["schemas"]["RetractionSubmission"] | components["schemas"]["SettlementReferenceSubmission"];
        readonly RecordView: {
            readonly balance?: components["schemas"]["Balance"];
            readonly custody?: components["schemas"]["Custody"];
            readonly fulfilment?: components["schemas"]["Fulfilment"];
            /** @description Kernel-derived labels. Never merged into the record itself, so the asserted body reads back byte for byte. The two exceptions are the fields the schema itself marks derived — `superseded_by` and, on a lot, `custodian` — which the kernel computes rather than serving a stale claim. */
            readonly quality_flags: readonly string[];
            readonly record: components["schemas"]["Record"];
            readonly retracted: boolean;
            readonly settlement?: components["schemas"]["SettlementSummary"];
            readonly staleness?: components["schemas"]["Staleness"];
            readonly subject?: components["schemas"]["SubjectResolution"];
            /** @description Direct corrections of this record. More than one entry is a fork: two parties corrected the same record and the kernel will not choose between them. */
            readonly superseded_by: readonly string[];
        };
        /** @description The notice given to a subject at enrolment, DPPA s.13(1)(i), recorded as it was given. A farmer enrolled in March was told something; a policy changed in June does not become what they were told. */
        readonly RetentionNotice: {
            /** @enum {string} */
            readonly dataset?: "live" | "seed";
            /** Format: date-time */
            readonly given_at: string;
            /**
             * Format: uuid
             * @description The verified caller who gave it, never a body field.
             */
            readonly given_by?: string | null;
            /** @enum {string} */
            readonly given_via: "in_person_reading" | "in_person_signature" | "ussd_confirmation" | "sms" | "printed_handout" | "witnessed";
            /** Format: uuid */
            readonly id: string;
            /** @description A notice in a language the subject does not read does not inform them, so the claim is recorded and can be checked. */
            readonly language: string;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** @description The notice in full, not a template id. A template can be edited afterwards, which would make the notice unprovable. */
            readonly notice_text: string;
            /** Format: uuid */
            readonly party: string;
            /** @description What the subject was told about how long, in the words used. Free text on purpose: “until three years after your last delivery” is a real answer and is not a duration. A machine-readable period would invite a job to act on it, and the lawful period is unresolved. */
            readonly period_stated: string;
            readonly purposes: readonly string[];
        };
        readonly RetentionNoticeSubmission: {
            /** Format: date-time */
            readonly given_at: string;
            /** @enum {string} */
            readonly given_via: "in_person_reading" | "in_person_signature" | "ussd_confirmation" | "sms" | "printed_handout" | "witnessed";
            readonly language: string;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            readonly notice_text: string;
            /** Format: uuid */
            readonly party: string;
            readonly period_stated: string;
            readonly purposes: readonly string[];
        };
        readonly Retraction: Schema.Retraction;
        readonly RetractionSubmission: {
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** @default null */
            readonly note: string | null;
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            /** @enum {string} */
            readonly reason_code: "test_entry" | "wrong_subject" | "duplicate" | "consent_withdrawn" | "other";
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** @default null */
            readonly supersedes: string | null;
            /** Format: uuid */
            readonly target: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "retraction";
        };
        /** @description What a season label means in one region. Nearly empty on purpose: only what a citation supports is in the table, so a label with no row returns nothing rather than a plausible guess. `basis` distinguishes a published window from one somebody observed in a field. Open decision D5 — whose calendar wins when a cooperative disagrees with the national one — is not answered here. */
        readonly SeasonCalendarEntry: {
            /** @enum {string} */
            readonly basis: "published" | "observed";
            /** Format: date */
            readonly ends_on: string;
            readonly label: string;
            readonly note?: string | null;
            readonly region_code: string;
            readonly region_vintage: string;
            readonly source: string;
            /** Format: date */
            readonly starts_on: string;
        };
        readonly SettlementReference: Schema.SettlementReference;
        readonly SettlementReferenceSubmission: {
            readonly amount: {
                readonly amount_minor: number;
                readonly currency: string;
            };
            /** Format: uuid */
            readonly asserted_by: string;
            /** @default null */
            readonly authenticated_as: string | null;
            /** @default null */
            readonly confirmed_by: string | null;
            /** @default null */
            readonly delegation: string | null;
            /** @default null */
            readonly device_id: string | null;
            /** @default [] */
            readonly evidence: readonly {
                readonly byte_size: number;
                /** @default null */
                readonly capture_location: {
                    /** @default null */
                    readonly accuracy_m: number | null;
                    /** @default null */
                    readonly captured_at: string | null;
                    readonly lat: number;
                    readonly lon: number;
                    /** @enum {string} */
                    readonly source: "gps_device" | "map_pin" | "admin_centroid" | "declared";
                } | null;
                /** @default null */
                readonly captured_at: string | null;
                /** Format: uuid */
                readonly captured_by: string;
                readonly content_hash: string;
                readonly metadata_stripped: boolean;
                readonly mime_type: string;
                readonly storage_ref: string;
            }[];
            /** @default {} */
            readonly ext: {
                readonly [key: string]: unknown;
            };
            /** @default null */
            readonly external_ref: string | null;
            /** Format: uuid */
            readonly id: string;
            /** @enum {string} */
            readonly lawful_basis: "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            /** Format: uuid */
            readonly obligation: string;
            /** Format: date-time */
            readonly occurred_at: string;
            /** @enum {string} */
            readonly occurred_at_precision: "instant" | "day" | "week" | "month" | "season";
            /** @default null */
            readonly on_behalf_of: string | null;
            /** @enum {string} */
            readonly rail: "mtn_momo" | "airtel_money" | "bank_transfer" | "cash" | "in_kind" | "offset";
            /** @constant */
            readonly record_class: "observation";
            readonly schema_version: string;
            /** Format: date-time */
            readonly settled_at: string;
            /** @default null */
            readonly supersedes: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            readonly type: "settlement_reference";
            /**
             * @default asserted
             * @enum {string}
             */
            readonly verification_status: "asserted" | "provider_verified" | "disputed";
        };
        /** @description What settlement records say about **one** obligation. Present on obligations only. There is deliberately no equivalent keyed on a party: totalling what someone is owed across obligations produces a balance, and ClyCites holds no funds and is not a ledger of record for money. */
        readonly SettlementSummary: {
            readonly amount_minor: number;
            /** @description The obligation's currency. Only settlements in it count. */
            readonly currency: string;
            /** @description Settlements denominated in some other currency. Counted, never converted — adding across currencies would invent an exchange rate. */
            readonly currency_mismatch: number;
            readonly disputed: boolean;
            /** @description Settlements corrected two ways at once. Counted, never summed — a fork has two tips and the kernel will not pick one. */
            readonly forked: number;
            /** @description A settlement was left out because it is forked, so `unreferenced_minor` is an upper bound. */
            readonly incomplete: boolean;
            /** @description Sums by `verification_status`, kept apart and never added together. An `asserted` settlement is one side’s claim; a `provider_verified` one is evidence from the rail, and the distinction is the whole value of the repayment signal. */
            readonly referenced_minor: {
                readonly [key: string]: number;
            };
            readonly references: number;
            /** @description The obligation less every reference against it. Not a balance: the kernel does not know whether money moved, only whether a record exists claiming it did. Negative when over-referenced, and not clamped. */
            readonly unreferenced_minor: number;
        };
        /** @description Spec §8 rule 5. Whether the records this inference was computed from have moved since. Present on inferences only. Derived on every read and never written into the body: the log is append-only, so a stored flag could only be corrected by a second record asserting the first is stale, and it would be wrong again the moment an input moved. A `stale` supplied on ingest is discarded. */
        readonly Staleness: {
            /** @description Both can apply at once. A superseded input means a newer value exists and the model can re-run. A retracted input means the input is gone and recomputation may be impossible — a different problem with a different answer. */
            readonly reasons: readonly ("input_superseded" | "input_retracted")[];
            readonly retracted_inputs: readonly string[];
            readonly stale: boolean;
            readonly superseded_inputs: readonly string[];
            /** @description Named as a dependency but not found. Not staleness — it is a statement that the check could not be made. */
            readonly unresolved_inputs: readonly string[];
        };
        readonly SubjectAccessRecord: {
            /** @description The record, after redaction. */
            readonly document: Record<string, never>;
            /** Format: uuid */
            readonly id: string;
            /** @description The ground it was collected on. Whether an objection can stop it turns on this. */
            readonly lawful_basis: string;
            /** Format: date-time */
            readonly occurred_at: string;
            /** Format: date-time */
            readonly recorded_at: string;
            /** @description Fields blanked under s.24(4). Named rather than silently removed, so the subject knows what to ask about. */
            readonly redacted: readonly string[];
            /** @description A retracted record is still held, so it is still answered for. What a subject asks for is not what a buyer would be shown. */
            readonly retracted: boolean;
            readonly superseded_by: readonly string[];
            readonly type: string;
        };
        /** @description Everything held about one subject, assembled for them under s.24. Not a record read: the consent guard answers whether one party may see another’s record, and a subject asking for their own data is not that question. */
        readonly SubjectAccessResponse: {
            readonly client_authorisations: readonly components["schemas"]["ClientAuthorisation"][];
            readonly consents: readonly components["schemas"]["ConsentGrant"][];
            /** @enum {string} */
            readonly dataset: "live" | "seed";
            /** @description s.24(1)(c). Third parties only: the subject’s own reads are not disclosures, and a refused request disclosed nothing. */
            readonly disclosures: readonly components["schemas"]["Disclosure"][];
            /**
             * Format: date-time
             * @description s.24(9) gives thirty days. Carried here so the deadline is the subject’s to hold us to rather than ours to remember.
             */
            readonly due_by: string;
            /** @description s.24(1)(a). False is an answer, not a refusal. */
            readonly held: boolean;
            readonly notice: readonly string[];
            readonly objections: readonly components["schemas"]["Objection"][];
            /** Format: date-time */
            readonly prepared_at: string;
            readonly records: readonly components["schemas"]["SubjectAccessRecord"][];
            /** Format: uuid */
            readonly subject: string;
            /** @description True when the answer hit its cap and is incomplete. Reported rather than paginated: a response that silently stops at a page boundary is worse than a slow one. */
            readonly truncated: boolean;
        };
        /** @description Whether an observation’s `subject_ref` names anything in the log. Present on observations only. Resolved on every read rather than settled at ingest, because an observation can arrive before its subject and later be about something perfectly real. */
        readonly SubjectResolution: {
            /** @description The record type actually found. Null if nothing was. */
            readonly actual_type: string | null;
            readonly declared_type: string;
            readonly exists: boolean;
            /** Format: uuid */
            readonly ref: string;
            /** @description The subject was retracted. Surfaced rather than hiding the observation, which remains someone’s account of what they saw. */
            readonly retracted: boolean;
            /** @description Null while unknowable — the subject has not arrived, or the declared type names nothing the log can hold. False is permanent and also carries a `subject_type_mismatch` quality flag. */
            readonly type_matches: boolean | null;
        };
        /** @description A factor, and the evidence for it. `basis` is the whole point: `measured` means somebody weighed a sample and the sample is below; `assumed_default` means the number is a convention nobody has checked. A quantity resting on the second is not wrong, it is unverified, and a lender is entitled to tell the difference without asking us. */
        readonly UnitConversion: Schema.UnitConversion;
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    readonly anchorProof: {
        readonly parameters: {
            readonly query?: {
                readonly purpose?: string;
            };
            readonly header?: {
                /** @description The authenticated party, set by the gateway. Reads without it are refused. */
                readonly "x-clycites-subject"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The leaf, the path to the root, and where the root was published. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        /** Format: date */
                        readonly batch_date: string;
                        /** Format: date-time */
                        readonly consensus_at?: string | null;
                        /** @description sha256(0x00 || salt || record_digest). */
                        readonly leaf_hash: string;
                        readonly merkle_root: string;
                        readonly network?: string;
                        /** @description Sibling hashes, leaf upwards. */
                        readonly path: readonly {
                            readonly hash: string;
                            /** @enum {string} */
                            readonly side: "left" | "right";
                        }[];
                        readonly record_count: number;
                        readonly record_digest: string;
                        /** Format: uuid */
                        readonly record_id: string;
                        /** @description Thirty-two random bytes, hex. Not derived from the record. */
                        readonly salt: string;
                        readonly sequence_number?: string | null;
                        readonly topic_id?: string | null;
                    };
                };
            };
            /** @description No such record, not readable by this caller, or not yet anchored. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly publishedRoots: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The roots, oldest first. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly roots: readonly {
                            /** Format: date */
                            readonly batch_date: string;
                            /** Format: date-time */
                            readonly consensus_at?: string | null;
                            readonly merkle_root: string;
                            /** @enum {string} */
                            readonly network?: "testnet" | "mainnet";
                            readonly record_count: number;
                            readonly sequence_number?: string | null;
                            readonly topic_id?: string | null;
                        }[];
                    };
                };
            };
            /** @description This kernel does not anchor. */
            readonly 503: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly listClientAuthorisations: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Authorisations, including revoked ones. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly authorisations: readonly components["schemas"]["ClientAuthorisation"][];
                    };
                };
            };
            /** @description No verified subject. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly authoriseClient: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": {
                    readonly client_id: string;
                    /** Format: date-time */
                    readonly expires_at?: string | null;
                    readonly granted_via: string;
                    readonly scopes: readonly ("records:read" | "records:write" | "registry:read" | "media:read" | "media:write" | "sync")[];
                };
            };
        };
        readonly responses: {
            /** @description Authorised. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ClientAuthorisation"];
                };
            };
            /** @description Client authorisation is not permitted. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly revokeClientAuthorisation: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: {
            readonly content: {
                readonly "application/json": {
                    /** Format: uuid */
                    readonly delegation?: string;
                    /** Format: uuid */
                    readonly on_behalf_of?: string;
                    readonly reason?: string | null;
                };
            };
        };
        readonly responses: {
            /** @description Revoked. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No authorisation of this party with that id. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly listOwnGrants: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The subject’s own grants, withdrawn ones included. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly grants: readonly components["schemas"]["ConsentGrant"][];
                    };
                };
            };
            /** @description No verified subject. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly grantConsent: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": {
                    readonly evidence?: readonly unknown[];
                    /** Format: date-time */
                    readonly expires_at?: string | null;
                    /** @enum {string} */
                    readonly granted_via: "in_person_signature" | "ussd_confirmation" | "witnessed";
                    /** Format: uuid */
                    readonly grantee: string;
                    /** @enum {string} */
                    readonly purpose: "credit_assessment" | "insurance_underwriting" | "input_supply" | "market_intelligence" | "traceability_claim" | "advisory" | "research" | "regulatory_reporting";
                    readonly record_types: readonly string[];
                };
            };
        };
        readonly responses: {
            /** @description Granted. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ConsentGrant"];
                };
            };
            /** @description The grant is not a shape we accept. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No verified subject. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly revokeConsent: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Withdrawn. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ConsentGrant"];
                };
            };
            /** @description No verified subject. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No grant of yours with that id. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly registerDevice: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["DeviceRegistration"];
            };
        };
        readonly responses: {
            /** @description Already registered to this party. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Device"];
                };
            };
            /** @description Registered. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Device"];
                };
            };
            /** @description That device belongs to another party. */
            readonly 409: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The registration is not well formed. */
            readonly 422: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly listConfirmationRequests: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Exactly one party represented by the OAuth client. Repeated or list-valued forms are refused. */
                readonly "x-acting-for"?: string;
                /** @description The Authentik OAuth client identifier, set by the trusted gateway from the validated token. */
                readonly "x-clycites-client-id"?: string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Recent requests made by this represented party. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly requests: readonly components["schemas"]["ConfirmationRequest"][];
                    };
                };
            };
            /** @description The field client is not currently authorised. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly requestDeliveryConfirmation: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Exactly one party represented by the OAuth client. Repeated or list-valued forms are refused. */
                readonly "x-acting-for"?: string;
                /** @description The Authentik OAuth client identifier, set by the trusted gateway from the validated token. */
                readonly "x-clycites-client-id"?: string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": {
                    /** Format: uuid */
                    readonly delivery: string;
                };
            };
        };
        readonly responses: {
            /** @description Queued, or the existing request returned. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ConfirmationRequest"];
                };
            };
            /** @description The delivery id is malformed. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The field client is not currently authorised. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No delivery visible to this cooperative. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly recordFieldEvent: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Exactly one party represented by the OAuth client. Repeated or list-valued forms are refused. */
                readonly "x-acting-for"?: string;
                /** @description The Authentik OAuth client identifier, set by the trusted gateway from the validated token. */
                readonly "x-clycites-client-id"?: string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["FieldEventSubmission"];
            };
        };
        readonly responses: {
            /** @description Recorded. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["FieldEvent"];
                };
            };
            /** @description The event is outside the closed vocabulary. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The field client is not currently authorised. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly health: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The process is up. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Health"];
                };
            };
        };
    };
    readonly submitInference: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description The authenticated party, set by the gateway. Reads without it are refused. */
                readonly "x-clycites-subject"?: string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": Record<string, never>;
            };
        };
        readonly responses: {
            /** @description The id was already in the log; nothing was written. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["RecordView"];
                };
            };
            /** @description Written. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["RecordView"];
                };
            };
            /** @description The payload does not satisfy the Inference schema. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly getInference: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Exactly one party represented by the OAuth client. Repeated or list-valued forms are refused. */
                readonly "x-acting-for"?: string;
                /** @description The Authentik OAuth client identifier, set by the trusted gateway from the validated token. */
                readonly "x-clycites-client-id"?: string;
                /** @description The authenticated party, set by the gateway. Reads without it are refused. */
                readonly "x-clycites-subject"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The inference. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["RecordView"];
                };
            };
            /** @description No lawful basis for this disclosure. Consent is not implemented yet, so only a subject reading their own records and the party that asserted a record are permitted. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not in the inference log. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly listValidations: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description The authenticated party, set by the gateway. Reads without it are refused. */
                readonly "x-clycites-subject"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The verdicts recorded against this inference. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly validations?: readonly components["schemas"]["InferenceValidation"][];
                    };
                };
            };
            /** @description Not in the inference log. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly validateInference: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description The authenticated party, set by the gateway. Reads without it are refused. */
                readonly "x-clycites-subject"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["InferenceValidationSubmission"];
            };
        };
        readonly responses: {
            /** @description Linked. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["InferenceValidation"];
                };
            };
            /** @description The linkage is malformed, or the observation is not one. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not in the inference log. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly beginUpload: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "Upload-Length": number;
                /** @description tus metadata: comma-separated `key base64(value)` pairs. `hash` and `mime` are required. */
                readonly "Upload-Metadata": string;
                /** @description The authenticated party, set by the gateway. Reads without it are refused. */
                readonly "x-clycites-subject"?: string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Opened. The session id is in `Location`. */
            readonly 201: {
                headers: {
                    readonly Location?: string;
                    readonly "Tus-Resumable"?: string;
                    readonly "Upload-Offset"?: number;
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The declared hash, type or size is not acceptable. `reason` is one of `hash_malformed`, `type_refused`, `too_large`. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No verified subject; an upload must have an owner. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description This kernel has no object store configured. */
            readonly 503: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly mediaCapabilities: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Capabilities, in headers. */
            readonly 204: {
                headers: {
                    readonly "Clycites-Accept-Types"?: string;
                    readonly "Clycites-Max-Chunk"?: number;
                    readonly "Tus-Extension"?: string;
                    readonly "Tus-Max-Size"?: number;
                    readonly "Tus-Resumable"?: string;
                    readonly "Tus-Version"?: string;
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            /** @description This kernel has no object store configured. */
            readonly 503: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly mediaUrl: {
        readonly parameters: {
            readonly query?: {
                readonly purpose?: string;
            };
            readonly header?: {
                /** @description The authenticated party, set by the gateway. Reads without it are refused. */
                readonly "x-clycites-subject"?: string;
            };
            readonly path: {
                /** @description The content hash — the stored, post-strip one. */
                readonly hash: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The link and its lifetime in seconds. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly expires_in: number;
                        readonly url: string;
                    };
                };
            };
            /** @description No such object, or nothing citing it may be read by this caller. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description This kernel has no object store configured. */
            readonly 503: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly uploadOffset: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description The authenticated party, set by the gateway. Reads without it are refused. */
                readonly "x-clycites-subject"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The current offset and state. */
            readonly 200: {
                headers: {
                    readonly "Clycites-Content-Hash"?: string;
                    readonly "Clycites-Upload-Rejection"?: string;
                    readonly "Clycites-Upload-State"?: "open" | "complete" | "rejected";
                    readonly "Upload-Length"?: number;
                    readonly "Upload-Offset"?: number;
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No such session, or not yours. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly appendChunk: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "Upload-Offset": number;
                /** @description The authenticated party, set by the gateway. Reads without it are refused. */
                readonly "x-clycites-subject"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/offset+octet-stream": string;
            };
        };
        readonly responses: {
            /** @description Accepted. */
            readonly 204: {
                headers: {
                    /** @description Present once the object is stored. This is what a record cites. */
                    readonly "Clycites-Content-Hash"?: string;
                    readonly "Clycites-Metadata-Stripped"?: string;
                    readonly "Clycites-Upload-State"?: string;
                    readonly "Upload-Offset"?: number;
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Wrong content type, or a missing offset. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such session, or not yours. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The offset does not match; re-read it with HEAD. */
            readonly 409: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly metrics: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Prometheus text exposition format. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "text/plain": string;
                };
            };
            /** @description The rollup could not be computed. */
            readonly 500: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly listOwnObjections: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The subject’s own objections, withdrawn ones included. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly objections: readonly components["schemas"]["Objection"][];
                    };
                };
            };
            /** @description No verified subject. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly lodgeObjection: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": {
                    /** Format: uuid */
                    readonly delegation?: string;
                    readonly evidence?: readonly unknown[];
                    /** @enum {string} */
                    readonly lodged_via: "in_person" | "ussd_confirmation" | "written";
                    /** Format: uuid */
                    readonly on_behalf_of?: string;
                    readonly scope?: readonly string[] | null;
                };
            };
        };
        readonly responses: {
            /** @description Lodged, with both sets enumerated. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ObjectionOutcome"];
                };
            };
            /** @description Lodging for another party without naming the delegation it rests on. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No verified subject. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly withdrawObjection: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": {
                    readonly reason?: string | null;
                    /** @enum {string} */
                    readonly withdrawn_via: "in_person" | "written";
                };
            };
        };
        readonly responses: {
            /** @description Withdrawn. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Objection"];
                };
            };
            /** @description Evidence too weak to remove a protection. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No verified subject. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No objection of yours with that id. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly resolvePartyLinks: {
        readonly parameters: {
            readonly query?: {
                readonly purpose?: string;
            };
            readonly header?: never;
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The set and its links. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["PartyLinkResolution"];
                };
            };
            /** @description Consent did not permit the disclosure. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly assertPartyLink: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": {
                    readonly confidence: number;
                    readonly evidence: string;
                    readonly evidence_note?: string | null;
                    readonly lawful_basis: string;
                    /** Format: uuid */
                    readonly left_party: string;
                    /** Format: uuid */
                    readonly right_party: string;
                };
            };
        };
        readonly responses: {
            /** @description Linked. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["PartyLink"];
                };
            };
            /** @description The assertion is not a shape we accept. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Consent did not permit the assertion. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly retractPartyLink: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": {
                    readonly reason: string;
                };
            };
        };
        readonly responses: {
            /** @description Retracted. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["PartyLink"];
                };
            };
            /** @description No live link with that id. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly ready: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Ready to serve. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Health"];
                };
            };
            /** @description The log is not reachable. */
            readonly 503: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly listRecords: {
        readonly parameters: {
            readonly query?: {
                readonly asserted_by?: string;
                readonly cursor?: string;
                readonly limit?: number;
                /** @description The lawful basis for the read, under the Data Protection and Privacy Act, 2019. Purpose-bound consent is not implemented yet, so naming a purpose is refused. */
                readonly purpose?: "credit_assessment" | "insurance_underwriting" | "input_supply" | "market_intelligence" | "traceability_claim" | "advisory" | "research" | "regulatory_reporting";
                /** @description A party or entity the record is about — either side of a delivery, either side of a delegation. */
                readonly subject?: string;
                readonly type?: "account" | "agreement" | "custody_transfer" | "delegation" | "delivery" | "delivery_confirmation" | "facility" | "harvest" | "lot" | "membership" | "obligation" | "observation" | "party" | "planting" | "plot" | "retraction" | "settlement_reference";
            };
            readonly header?: {
                /** @description Exactly one party represented by the OAuth client. Repeated or list-valued forms are refused. */
                readonly "x-acting-for"?: string;
                /** @description The Authentik OAuth client identifier, set by the trusted gateway from the validated token. */
                readonly "x-clycites-client-id"?: string;
                /** @description The authenticated party, set by the gateway. Reads without it are refused. */
                readonly "x-clycites-subject"?: string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description A page of records. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Page"];
                };
            };
            /** @description The cursor is not one we issued. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No lawful basis for this disclosure. Consent is not implemented yet, so only a subject reading their own records and the party that asserted a record are permitted. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No such record type. */
            readonly 422: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly submitRecord: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /** @description Marks a write as fabricated. Ignored unless seed ingest is enabled; anything unrecognised reads as live. */
                readonly "x-clycites-dataset"?: "live" | "seed";
                /** @description The Data Protection and Privacy Act, 2019 ground this record is collected under. Financial records are s.9(1) special data and accept special_data_consent only. */
                readonly "x-clycites-lawful-basis": "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["RecordSubmission"];
            };
        };
        readonly responses: {
            /** @description Already in the log; nothing was written. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["RecordView"];
                };
            };
            /** @description Appended. */
            readonly 201: {
                headers: {
                    readonly Location: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["RecordView"];
                };
            };
            /** @description No delegation authorises this claim, or no lawful basis was stated for it. The record may be well formed; what is missing is our authority to hold it. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description That id belongs to a different record. */
            readonly 409: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The record is not one the schema allows. */
            readonly 422: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly getRecord: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Exactly one party represented by the OAuth client. Repeated or list-valued forms are refused. */
                readonly "x-acting-for"?: string;
                /** @description The Authentik OAuth client identifier, set by the trusted gateway from the validated token. */
                readonly "x-clycites-client-id"?: string;
                /** @description The authenticated party, set by the gateway. Reads without it are refused. */
                readonly "x-clycites-subject"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The record. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["RecordView"];
                };
            };
            /** @description No lawful basis for this disclosure. Consent is not implemented yet, so only a subject reading their own records and the party that asserted a record are permitted. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not in the log. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly getRecordChain: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: {
                /** @description Exactly one party represented by the OAuth client. Repeated or list-valued forms are refused. */
                readonly "x-acting-for"?: string;
                /** @description The Authentik OAuth client identifier, set by the trusted gateway from the validated token. */
                readonly "x-clycites-client-id"?: string;
                /** @description The authenticated party, set by the gateway. Reads without it are refused. */
                readonly "x-clycites-subject"?: string;
            };
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The chain. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Chain"];
                };
            };
            /** @description No lawful basis for this disclosure. Consent is not implemented yet, so only a subject reading their own records and the party that asserted a record are permitted. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not in the log. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly listAdminRegions: {
        readonly parameters: {
            readonly query?: {
                readonly level?: string;
                readonly limit?: number;
                readonly parent_code?: string;
                readonly vintage?: string;
            };
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Regions. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly admin_regions: readonly components["schemas"]["AdminRegionEntry"][];
                    };
                };
            };
            /** @description A filter is not a shape we accept. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Too many requests from one address. */
            readonly 429: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly getAdminRegion: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly code: string;
                readonly vintage: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The region. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["AdminRegionEntry"];
                };
            };
            /** @description No such region at that vintage. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Too many requests from one address. */
            readonly 429: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly listConversions: {
        readonly parameters: {
            readonly query?: {
                readonly basis?: "definitional" | "measured" | "published_standard" | "estimated" | "assumed_default";
                readonly commodity?: string;
                readonly from_unit?: string;
                readonly limit?: number;
                readonly region_code?: string;
                readonly to_unit?: string;
            };
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Matching factors, without their sample rows. */
            readonly 200: {
                headers: {
                    readonly "Cache-Control"?: string;
                    readonly "RateLimit-Remaining"?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly conversions: readonly components["schemas"]["UnitConversion"][];
                    };
                };
            };
            /** @description A filter is not a shape we accept. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Too many requests from one address. The rows are immutable — cache them rather than polling. */
            readonly 429: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly getConversion: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The factor, with its sample. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["UnitConversion"];
                };
            };
            /** @description No such factor. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Too many requests from one address. */
            readonly 429: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly listCropCodes: {
        readonly parameters: {
            readonly query?: {
                readonly limit?: number;
                readonly parent_code?: string;
            };
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Crop codes. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly crop_codes: readonly components["schemas"]["CropCodeEntry"][];
                    };
                };
            };
            /** @description A filter is not a shape we accept. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Too many requests from one address. */
            readonly 429: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly getCropCode: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly code: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The code. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["CropCodeEntry"];
                };
            };
            /** @description Not registered. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Too many requests from one address. */
            readonly 429: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly listGradingSchemes: {
        readonly parameters: {
            readonly query?: {
                readonly limit?: number;
            };
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Schemes, without their values. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly grading_schemes: readonly components["schemas"]["GradingSchemeEntry"][];
                    };
                };
            };
            /** @description A filter is not a shape we accept. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Too many requests from one address. */
            readonly 429: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly getGradingScheme: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly scheme: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The scheme, with its values. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["GradingSchemeEntry"];
                };
            };
            /** @description Not registered. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Too many requests from one address. */
            readonly 429: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly listObservationTypes: {
        readonly parameters: {
            readonly query?: {
                readonly limit?: number;
                readonly subject_type?: string;
            };
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Registered types, newest version of each first. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly observation_types: readonly components["schemas"]["ObservationTypeEntry"][];
                    };
                };
            };
            /** @description A filter is not a shape we accept. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Too many requests from one address. */
            readonly 429: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly getObservationType: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly code: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The type. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ObservationTypeEntry"];
                };
            };
            /** @description Not registered. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Too many requests from one address. */
            readonly 429: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly listSeasons: {
        readonly parameters: {
            readonly query?: {
                readonly label?: string;
                readonly limit?: number;
                readonly region_code?: string;
            };
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Season windows, most recent label first. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly seasons: readonly components["schemas"]["SeasonCalendarEntry"][];
                    };
                };
            };
            /** @description A filter is not a shape we accept. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Too many requests from one address. */
            readonly 429: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly getSeason: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly code: string;
                readonly label: string;
                readonly vintage: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The window, with its citation. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["SeasonCalendarEntry"];
                };
            };
            /** @description No calendar for that season in that region. */
            readonly 404: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Too many requests from one address. */
            readonly 429: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly retentionNotices: {
        readonly parameters: {
            readonly query: {
                readonly as_at?: string;
                readonly party: string;
            };
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Notices this caller may read. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly notices: readonly components["schemas"]["RetentionNotice"][];
                    };
                };
            };
            /** @description A party id is required. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No verified party. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly giveRetentionNotice: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /** @description Marks a write as fabricated. Ignored unless seed ingest is enabled; anything unrecognised reads as live. */
                readonly "x-clycites-dataset"?: "live" | "seed";
                /** @description The Data Protection and Privacy Act, 2019 ground this record is collected under. Financial records are s.9(1) special data and accept special_data_consent only. */
                readonly "x-clycites-lawful-basis": "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["RetentionNoticeSubmission"];
            };
        };
        readonly responses: {
            /** @description Recorded. */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["RetentionNotice"];
                };
            };
            /** @description The notice is incomplete. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No verified party. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly subjectAccess: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description The subject’s own answer under s.24. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["SubjectAccessResponse"];
                };
            };
            /** @description No verified subject. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly pullChanges: {
        readonly parameters: {
            readonly query?: {
                /** @description Omit to start from the beginning of the log. */
                readonly cursor?: string;
                readonly limit?: number;
            };
            readonly header?: {
                /** @description The authenticated party, set by the gateway. Reads without it are refused. */
                readonly "x-clycites-subject"?: string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description A page of changes. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Changes"];
                };
            };
            /** @description The cursor is not one we issued. */
            readonly 400: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description No lawful basis for this disclosure. Consent is not implemented yet, so only a subject reading their own records and the party that asserted a record are permitted. */
            readonly 403: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readonly drainOutbox: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /** @description Marks a write as fabricated. Ignored unless seed ingest is enabled; anything unrecognised reads as live. */
                readonly "x-clycites-dataset"?: "live" | "seed";
                /** @description The Data Protection and Privacy Act, 2019 ground this record is collected under. Financial records are s.9(1) special data and accept special_data_consent only. */
                readonly "x-clycites-lawful-basis": "consent" | "legal_authorisation" | "public_duty" | "national_security" | "law_enforcement" | "contract_performance" | "medical" | "legal_obligation" | "special_data_consent";
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": readonly components["schemas"]["RecordSubmission"][];
            };
        };
        readonly responses: {
            /** @description The batch was received. See each result. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["DrainReport"];
                };
            };
            /** @description The batch itself is not well formed. */
            readonly 422: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
}

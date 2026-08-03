# Runbook

Operational procedures for the ClyCites kernel. Written to be followed by
somebody who did not build it, at three in the morning, under pressure.

References to sections are to the Data Protection and Privacy Act, 2019
(Act 9 of 2019).

> **The contact rows in §1 are empty. That is a real gap, not a template
> placeholder.** Fill them before they are needed, because the one thing §1 does
> not permit is time spent looking up who to call.

---

## 1. Data breach — s.23

**Trigger:** any belief that personal data has been accessed, altered,
disclosed, or destroyed without authorisation. Belief, not proof. A suspicious
access pattern, a leaked credential, a lost laptop with a database password on
it, an unexplained gap in the audit log.

**s.23(1) requires notification to the Personal Data Protection Office
immediately.** Not within seventy-two hours. Not once the investigation
concludes. Immediately, on belief.

### Do these concurrently, not in sequence

Containment does not wait for notification, and notification does not wait for
containment. Two people, two tracks. If there is only one person, notify first —
it is the shorter task.

| Track | Action |
| --- | --- |
| Contain | Rotate the credentials that could have been used (§3). Revoke sessions. Block the source if it is identifiable. |
| Notify | Contact the Authority. See below. |
| Preserve | Snapshot logs and the audit schema **now**, before rotation destroys the evidence. |

### Do not delete anything

**s.36 makes unlawful destruction of personal data a criminal offence.** The
append-only log is the evidence of what happened and when. Deleting affected
records to "limit exposure" converts a data breach into a second offence and
destroys the only account of the first.

The log cannot be deleted from anyway — decision 0001 removed DELETE from the
application role — but nothing stops somebody dropping a schema as the owner.
Do not.

### The Authority decides whether data subjects are notified

**s.23(2).** Not us. Prepare the notification text so it can go out the moment
it is authorised, and do not send it unilaterally. Notifying subjects before the
Authority has ruled can prejudice an investigation and is not within our
discretion to choose.

### Contacts

| Role | Name | Phone | Email |
| --- | --- | --- | --- |
| Incident owner (decides, and is accountable) | | | |
| Deputy (when the owner is unreachable) | | | |
| Personal Data Protection Office | | | |
| Legal counsel | | | |
| Infrastructure / hosting provider | | | |

### Record it

Every breach, and every belief of one that turned out to be nothing, gets an
entry in §7. Under **s.33(2)** a documented, dated record of how we responded
forms part of a reasonable-care defence. An undocumented correct response is
worth less than a documented imperfect one.

---

## 2. Restore from backup

### Verify a backup without touching production

This is the drill. Run it monthly (§6). It never touches the live database.

```sh
export BACKUP_PASSPHRASE=...        # from the secret store, never from a file
scripts/restore.sh backups/<stamp> \
  postgres://clycites_owner:...@localhost:5433/clycites_restore
```

Exit 0 means every row count, every primary-key fingerprint, every constraint
(including its validated flag), and every table grant matches the database that
was dumped. Anything else prints a diff and exits non-zero.

`restore.sh` **drops and recreates its target**, and refuses any database whose
name does not contain `restore`, `test`, or `scratch`.

### Restore production

1. Stop the kernel. Writes during a restore are lost silently and there is no
   reconciliation path afterwards.
2. Restore into a scratch database first and confirm it verifies. Do not restore
   straight over production — a corrupt backup then leaves you with nothing.
3. Rename or point the connection at the verified scratch database.
4. Run `pnpm migrate`. It is idempotent and will report `already applied`.
5. Start the kernel and check `/ready`, then `/metrics`.
6. Note the actual RPO and RTO in §7 while it is fresh.

### What the verification does not cover

The manifest is one we wrote ourselves. It proves the restored database matches
the dump; it cannot prove the dump matched reality at the moment it was taken.

Once anchoring ships (work order I), completeness becomes checkable against
published Merkle roots, which is independently strong because we do not control
them. That is the intended upgrade to this section.

### Recovery objectives

| | Target | Last measured | Date |
| --- | --- | --- | --- |
| RPO — data we accept losing | | | |
| RTO — time to serving again | | | |

Measure these during the monthly drill. A target with no measurement beside it
is a hope.

---

## 3. Rotate a secret

Rotate on any breach belief, on any staff departure with access, and on any
credential that has ever existed in a file, a terminal history, or a chat.

### `kernel_app` password

1. Change it in the secret store.
2. `ALTER ROLE kernel_app WITH PASSWORD '<new>'` as the owner.
3. Update `KERNEL_APP_PASSWORD` and `DATABASE_URL` in the deployment
   environment.
4. Restart the kernel. Confirm `/ready` returns 200 — it fails when Postgres is
   unreachable, which is exactly what a half-rotated password looks like.

### `clycites_owner` password

Same, plus `MIGRATOR_DATABASE_URL`, plus anywhere `scripts/backup.sh` runs.

### `BACKUP_PASSPHRASE`

**Backups taken under the old passphrase stay readable only with the old
passphrase.** Keep it until every backup encrypted with it has aged out of
retention, and record the date it becomes safe to destroy. Losing the old
passphrase while old backups are still the only copies means losing the data.

After rotating, take a fresh backup and verify it (§2) before relying on it.

### After any rotation

Run `bash scripts/check-secrets.sh`. It scans everything git tracks.

---

## 4. Roll back a migration

**There is no down-migration, by design.** Decision 0001 makes the log
append-only; a mechanism able to undo a schema change would also be a mechanism
able to reach the data behind it.

- **A schema change to undo:** write a new forward migration that undoes it.
  Migrations are immutable once applied — the migrator refuses a file whose
  checksum changed — so editing the original is not an option and will fail
  loudly if attempted.
- **A migration that failed mid-run:** it ran in its own transaction and rolled
  back. The database is on the last complete migration. Fix the file and re-run.
- **Record data that is wrong:** this is not a deployment problem. Supersede or
  retract through the API, which is what those record types exist for. If the
  data is wrong because of a defect, it is an incident (§1), not a rollback.

---

## 5. Deploy

1. `pnpm typecheck && pnpm lint && pnpm test` — all three, no exceptions.
2. `pnpm openapi && git diff --exit-code apps/kernel/openapi.json`. A drifted
   contract means applications are coding against a document that is no longer
   true.
3. **Take a backup and verify it** (§2) before running migrations.
4. `pnpm migrate`.
5. Deploy, then check `/ready` and `/metrics`.

Watch after a deploy:

| Metric | What a change means |
| --- | --- |
| `kernel_assumed_conversion_share` | Tonnage resting on an unverified conversion factor |
| `kernel_thin_sample_kg_total` | Tonnage on a `measured` factor with a thin sample (0018) |
| `kernel_records_by_lawful_basis{basis="unstated"}` | Should only ever be pre-0013 rows. Growth means a write path is bypassing the basis check |
| `kernel_financial_records_without_special_consent` | Should be zero for anything written after 0013 |

---

## 6. Monthly verification — s.20(2)

**s.20(2) requires regularly verifying that safeguards are effectively
implemented.** A one-off hardening pass does not satisfy it. This table, dated
and signed, is what does — and under s.33(2) it forms part of a reasonable-care
defence.

Run on the first working day of each month.

| # | Check | How |
| --- | --- | --- |
| 1 | A backup from the last 24h exists | `ls backups/` |
| 2 | That backup restores and verifies | §2, into a scratch database |
| 3 | RPO and RTO measured and recorded | §2 |
| 4 | No credential in the tree | `bash scripts/check-secrets.sh` |
| 5 | Config guards pass | `pnpm test` — `test/ops/` |
| 6 | No data-tier port reachable from off-host | `nmap` or `nc -vz` from another machine |
| 7 | OS security updates applied | `unattended-upgrades` log |
| 8 | Access list still correct | Who holds DB, host, and secret-store access — remove departures |
| 9 | §1 contacts still correct | Ring one of them |
| 10 | Audit log shipping off-box | `AUDIT_SHIP_URL` is set, and the collector holds entries dated within the last 24h |
| 11 | Audit log is still write-only to the app | `select privilege_type from information_schema.role_table_grants where grantee='kernel_app' and table_schema='audit'` returns INSERT and nothing else |
| 12 | No unexplained DDL | `select occurred_at, reason, detail->>'object', detail->>'role' from audit.entry where action='schema.ddl' and occurred_at > now() - interval '1 month'` — every row should match a deploy in §5 |
| 13 | Denial rate has not shifted | `select date_trunc('day', occurred_at) d, reason, count(*) from audit.entry where outcome='denied' group by 1,2 order by 1` — a change is a signal, not noise |

### Verification log

| Date | Who | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | | | | | | |

---

## 7. Incident log

Every incident, every drill, every restore. Append only — correct an entry by
adding another, which is the same discipline the log itself keeps.

| Date | What | Data subjects affected | Authority notified | RPO/RTO observed | Outcome |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

---

## 8. Known gaps

Recorded here rather than left implicit, because a gap somebody wrote down is a
decision and a gap nobody wrote down is a surprise.

| Gap | Blocked on |
| --- | --- |
| §1 contact rows are empty | Nothing. Fill them. |
| Answering a s.24(1)(c) request has no tooling | Nothing. The data and the grants are right (0025); a person runs the query as the owner. |
| Un-shipped audit entries are lost if the process dies | A shipper outside this process, which needs its own role. See 0025 finding 1. |
| Retention expiry and destruction, s.18(4) | The 2021 Regulations, and counsel |
| Cross-border transfer position | Counsel |
| External penetration test | Budget. Before the first real farmer record. |
| Restore completeness verified independently | Work order I (anchoring) |
| Seed plot area, crop mix and delivery frequency are invented | The UNPS microdata, which is behind a manually approved login. See `docs/data-sources.md`. |
| `UG.KIRYANDONGO` and `UG.NEBBI` are not in `registry.admin_region` | Nothing. The seed uses both district codes anyway; the season calendar could not be scoped to them. |
| Three observation types carry no citation | A field request for any of them, or their eventual withdrawal. See 0028. |
| A farmer cannot read their own Planting, Harvest or Observation | Closed. Those types reach a party through one declared hop — `plot` for Planting and Harvest, `subject_ref` for Observation. Where the hop resolves to nobody the read is denied as `subject_unresolvable`. See 0029. |
| A cooperative can classify as member body on records it is not a party to | Nothing, but know the bound: only where *every* party the record resolves to is its member at `occurred_at`. A member's dealings with an outsider stay third party. This is how a coop sees its members' production history at all. See 0029. |
| `S9_CONSENT_REQUIRED_FOR_MEMBER_BODY` is set true on a guess | Counsel. One question: does s.9(3)(c) permit a cooperative to process its members' financial information without separate explicit consent? The answer sets one flag. See 0029. |
| Aggregate and anonymised access has no rule at all | Counsel, and a de-identification standard. Tangled with s.37 on selling personal data. The next consent question, not part of 0029. |

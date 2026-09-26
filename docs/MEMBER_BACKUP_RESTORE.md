# Member database backup and recovery

The production build includes `dist/scripts/member-backup.js`. It creates a consistent SQLite snapshot, verifies integrity, and encrypts it using AES-256-GCM with a fresh nonce. It includes committed WAL records and excludes deleted free-page content. It never copies a live database file by itself. Restores authenticate the entire encrypted file before publishing a verified database to a **new** path. Existing files are never overwritten.

## Protected configuration

Provision `MEMBER_BACKUP_KEY` as a cryptographically random 32-byte key encoded in standard base64. Supply it through a protected process environment, never a command-line argument, repository, log or chat. Keep an independent recoverable copy in the operator's secret manager. Losing the key makes its backups unrecoverable. Record key version alongside each encrypted object in the backup service; never store the key with the backup.

Run the command from a trusted administrative job with read access to the database and a private writable working directory. The source remains online during snapshot creation. The resulting ciphertext is mode `0600`; temporary plaintext is confined to a private directory and removed on normal completion or failure. Process termination or host loss can interrupt cleanup, so use an encrypted ephemeral working volume and include stale-workspace cleanup in the operator's maintenance policy.

```sh
node dist/scripts/member-backup.js create /data/waitlist.sqlite /protected-backups/member-20260926.enc
node dist/scripts/member-backup.js restore /protected-backups/member-20260926.enc /protected-restore/rehearsal.sqlite
```

Replace the example source with the service's actual `DB_PATH`; this document does not change it. Destination directories must already exist. The command prints integrity status, aggregate table counts, bytes and (for creation) a ciphertext SHA-256. It does not print records or credentials.

## Off-volume retention

The command does not upload or schedule backups by itself. Connect it to the operator's backup job and authenticated object storage, verify the uploaded ciphertext hash, then rehearse restoring a downloaded object. A copy on the same service volume is not disaster recovery. Before cutover, set an explicit cadence, retention policy, encryption-key recovery procedure and an alert for a missed or failed backup. Keep backup destination credentials separate from the member application credential.

## Restore rehearsal and promotion

1. Restore a downloaded encrypted object to an isolated new path. Compare the returned counts with the backup receipt and check sampled UserIDs, inviter relationships, collectible serials and quest progress using the application.
2. Keep email, Discord reconciliation and research workers disabled in the rehearsal. A restored outbox can contain real recipients, so no external integrations should run against rehearsal data.
3. Record the snapshot time and the resulting recovery gap. Backups do not recover records written after that snapshot. Continuous recovery would need additional replication or an event journal.
4. Before any production promotion, replay every deletion and external-access revocation recorded after the snapshot, preserving collectible tombstones and SAMV2 erasure tombstones. An old backup must not resurrect a deleted account or reclaim a consumed badge serial. Reconcile unknown email-delivery outcomes before retrying messages outside the provider's idempotency window.
5. Revoke restored sessions and expired authentication challenges before serving traffic. Verify owner email recovery, restore the current protected configuration, and check Discord roles against current membership.
6. Only after that review, stop the affected application and promote the restored database through the deployment's normal recovery procedure. The tool deliberately does not perform this replacement.

Verification in this branch covers an open WAL database, original member IDs and collectible serials, later writes excluded from the snapshot, wrong keys, modified ciphertext/IV/tag, truncation, file permissions and refusal to overwrite an existing live database. Actual off-volume upload/download, key recovery and production-volume restore remain activation gates.

Implementation references: [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html), [Node crypto](https://nodejs.org/api/crypto.html).

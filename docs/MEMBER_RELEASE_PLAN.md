# SAM member community — release and operating plan

Prepared 26 September 2026. This is implementation and rollout documentation, not a claim that the production integrations are running.

## Product rules in this release

The existing early-access records retain their original IDs and emails. On the first members-only activation, a transactional migration brings them into membership. They must prove control of their stored email before receiving access. New members must redeem an invitation bound to their email. A public UserID is an identity, never a password.

Each verified member has ten lifetime successful-join slots. Expired or revoked unused invitations can be replaced. Consumed slots never refill when an invited account is deleted. Every member has one immutable inviter. Community rank counts verified descendants at all depths, with a new community title for each direct recruit through ten. Research reputation is separate.

Quest 1 requires one verified invitation. This is an explicit product default: the original request did not supply a threshold. It unlocks Discord verification; members retain their unused invitations. Quest 2 requires authenticated Discord ownership, verification through the existing stored email, completed server screening, and a verified member-role grant. Quest 3 awards 0, 1 or 3 evidence-based research points and completes at 500. Research rank changes every ten points.

The first 200 email-verified members receive First Man on the Moon. The first 100 completed Discord verifications reserve one choice across the entire pioneer collection: Stargazer, Techhead, or Wolf of Wall Street. It is **100 total**, not 100 of each. Serial allocations are atomic and never silently replenished. These are digital collectibles. No blockchain tokens, trading rights, investment value, or scarcity beyond the recorded issuance cap are represented.

Five further titles recognize reviewed work: Signal Scout, Source Sleuth, Counterweight, First Response, and Clear Thinker. A speed title requires source-verified event timing. Shortness, fast typing, reactions, recruitment and message volume never establish research quality.

## Honest device enforcement

The website enforces two active **registered browser installations**, using a nonextractable P-256 private key stored in IndexedDB, server-side public keys, session-bound signed requests and replay rejection. It does not use an IP address or browser fingerprint as a permanent device ID. Clearing local storage does not release the server slot. Members can revoke another registered browser; administrator recovery requires an exact member ID, public UserID, device ID and documented recovery reason.

A normal website cannot guarantee a permanent physical-device identifier. A custom client can enroll an exportable key, and a compromised browser can invoke a nonextractable key. Stronger physical-device enforcement would require a separately designed managed/native client with hardware attestation and recovery. Do not advertise browser registration as hardware binding.

## Integration status

This release adds durable queues and integration protocols. Live email delivery, live Discord membership, real model/provider review and production browser behavior require operational verification. Configuration flags are not proof of those capabilities. Use the protected operational report for deployment-specific observations; do not publish internal environment inventories.

## Configuration

Keep secrets in protected service variables. Never put them in chat, Git, client code, URLs or member-facing status responses.

| Variable | Purpose |
|---|---|
| `MEMBER_ACCESS_ENABLED=true` | Activate members-only cutover. Once migrated, losing this flag does not reopen signup. |
| `MEMBER_EMAIL_ENABLED=true` | Enable configured transactional email worker after sender verification. |
| `RESEND_API_KEY` | Server-only sending credential. Adapter uses the official email API. |
| `MEMBER_EMAIL_FROM` | Verified sender address/name owned by the operator. |
| `RESEND_WEBHOOK_SECRET` | Separate signing secret for delivery events at `/api/webhooks/resend`. |
| `MEMBER_EMAIL_PROBE_TO` | Operator-owned mailbox for the protected prelaunch delivery check. Never supplied by an HTTP caller. |
| `MEMBER_PUBLIC_ORIGIN` | Exact HTTPS origin, without trailing slash. |
| `DISCORD_MEMBER_ENABLED=true` | Explicit operational gate after channel/role/screening verification. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Existing official Discord application's OAuth configuration. |
| `DISCORD_GUILD_ID`, `DISCORD_BOT_TOKEN` | Existing server and official bot. |
| `DISCORD_VERIFIED_ROLE_ID` | Dedicated member role, below staff/admin. |
| `DISCORD_TOKEN_ENCRYPTION_KEY` | Random 32-byte encryption key encoded in base64; server-only. |
| `DISCORD_PUBLIC_KEY` | Discord application's public interaction-signature key. |
| `DISCORD_RESEARCH_CHANNEL_ID` | One verified-member channel accepting `/dd`, `/profile`, `/quest`, `/badge`. |
| `SAM_RESEARCH_SHARED_KEY` | Dedicated >=32-byte HMAC secret for SAMV2 evidence receipts. |
| `SAM_REVIEW_SHARED_KEY` | Different >=32-byte secret for the independent model reviewer. |
| `SAM_RESEARCH_ALLOWED_PROVIDERS` | Comma-separated deployed, tested evidence adapter identifiers. |
| `SAM_REVIEW_ALLOWED_MODELS` | Comma-separated pinned reviewer identifiers actually deployed. |
| `MEMBER_QUEST_DEADLINE` | Optional real ISO timestamp. Absent means no deadline scheduled. |
| `MEMBER_BACKUP_KEY` | Protected base64 32-byte key for the administrative backup process; retain separately from ciphertext. |
| `ADMIN_TOKEN` | Existing administrator bearer credential; never share with members or workers. |

The web server drains the persistent email outbox and reconciles Discord revocations every 15 seconds with overlap prevention. Before membership activation, only an explicitly requested administrator delivery probe may send. It does not run a fictional AI reviewer when workers are absent. Accepted email means the provider accepted it. Signed delivery events prove recipient mail-server acceptance; actual inbox arrival still needs a mailbox check. Retries reuse one idempotency key and stop before its validity window ends. See `MEMBER_EMAIL_OPERATIONS.md` for the delivery callback, suppression behavior, private diagnostics and prelaunch probe.

## Activation sequence

1. Finish review of this branch. Pass unit/integration tests and a production build. Run a real browser flow in a private staging environment using test accounts before enforcing access on the live domain.
2. Take a consistent SQLite backup while preserving the existing volume. Record signup count; test restoring into an isolated database. Use the implemented encrypted snapshot/restore command in `MEMBER_BACKUP_RESTORE.md`, then connect off-volume storage with operator-owned retention and test downloading/restoring a real backup. A volume alone is not a backup.
3. Configure the email sender and signed delivery webhook through protected provider/service fields. Use the administrator-only probe in `MEMBER_EMAIL_OPERATIONS.md` to verify domain authentication, a signed delivery receipt and actual arrival at an operator-controlled mailbox before membership activation. Confirm restart/retry behavior and that message bodies are erased after acceptance. Do not enable membership before this succeeds.
4. Confirm owner recovery is operational. Test an existing member's stored email, then two browser registrations and third-registration rejection. Lost-browser recovery must revoke the old key before admitting a replacement.
5. Merge/deploy the exact reviewed commit, preserving the SQLite path and volume. Activate `MEMBER_ACCESS_ENABLED` only after the email and recovery gates pass. Keep the legacy waitlist closed afterward, including during outages.
6. Complete the existing Discord bot installation/human verification, then store credentials in protected fields. Set one dedicated Verified Member role; remove anonymous access to member categories; deny ordinary members invitation creation; revoke old general invite links; preserve staff restrictions. Check forwarded invites cannot expose member research.
7. Register the OAuth callback and slash commands documented in `DISCORD_MEMBER_SETUP.md` and `RESEARCH_REVIEW_PROTOCOL.md`. Test one real OAuth + email + screening + role sequence, badge allocation, unlink, outage retry and deletion.
8. Install and test the SAMV2 and independent-review workers using distinct credentials. Run known good, false, stale, wrong-issuer, disputed, duplicated and malicious-instruction samples. Archive source receipts and model version. Only then configure positive award permissions.
9. Verify one source-reviewed +1, one independently reviewed +3, one zero decision, and one unavailable-provider case that stays pending. Confirm identical retries do not award twice; verify an appeal presents its new evidence to the worker.
10. Post truthful rollout updates only after the bot can actually publish and the relevant milestone has been demonstrated. Record message IDs. No credentials, private reports, internal provider arrangements or owner information belong in posts.

Do not apply environment-wide staged changes to make a single-service update. Inspect staged state before mutation.

## Deletion, recovery and data lifecycle

UserID, email, invitation lineage, progress and research remain in persistent storage until a deliberate one-member deletion. Ephemeral authentication material expires independently. Deletion immediately disables sessions, revokes browser keys, cancels queued mail and authentication challenges, and removes research content. If Discord removal is unavailable, it stays explicitly pending and retries; do not claim external access has vanished.

For any research already claimed by a worker, deletion first records a content-free central cleanup task. The source worker drains it, erases both roles’ retained model payloads and identifying model-call metadata, and records a tombstone that prevents late model responses from recreating the text. Leased, signed receipts confirm this bounded cleanup; an unavailable worker leaves deletion explicitly pending. Admin status includes pending cleanup counts and the oldest request. External vendor logs/traces and historical backups require the operator’s separate retention and deletion policy.

After Discord revocation and required SAMV2 cleanup, purge email/identity/credentials and retain anonymous issuance and lineage tombstones. Collectible supply does not refill. Remove corresponding personal data from exports and honor the documented backup retention policy. Existing offline backups cannot be retroactively changed by a live database mutation; the operator must manage encrypted backup expiry and deletion handling.

Protected administrator endpoints require the existing bearer token:

- `GET /api/admin/members/status`: counts only, no email bodies or codes.
- `POST /api/admin/members/:id/revoke-device`: `{confirmUserId,deviceId,recoveryReason}`.
- `POST /api/admin/members/:id/delete`: `{confirmUserId,confirmDelete:"DELETE THIS MEMBER"}`. A `202 requested` result means Discord revocation or SAMV2 cleanup is still pending. Completion describes the application’s live datastores, not a vendor or historical-backup erasure attestation.

Do not automate identity recovery from a public UserID or a claim posted in Discord.

## Operating beyond the initial quests

These are proposed extensions, not unlocked or advertised as shipped:

1. **Evidence bounties:** SAM publishes a specific unresolved public research question, required evidence and a real deadline. Useful disconfirmation earns equal credit to confirmation.
2. **Thesis evolution:** a member revisits their own approved claim after a filing or catalyst. Reward a substantiated correction, not protecting an old prediction.
3. **Peer-review apprenticeship after 500:** supervised reviewers identify unsupported steps and missing counterevidence. Review authority is earned through separate benchmark accuracy; community rank never grants it automatically.
4. **Research circles:** small topic groups assemble a shared brief with individual attributable contributions. Shared work does not multiply points for duplicate text.
5. **Calibration record:** keep forecasts, cutoff times and revisions immutable; measure outcomes only after their stated horizon. Forecast accuracy is a separate measured skill from contribution points.

Use clear progress, meaningful unlocks and recognition for work. No fake countdowns, fabricated participants, points for engagement spam, cash referral commissions, punitive absence penalties or manufactured FOMO. Members should return because the next research question is valuable.

## The analyst-level standard

The ambition is to perform serious analyst work. The product must earn that claim through evidence: correct issuer attribution; source dates and availability clocks; supported calculations; explicit alternatives; calibrated uncertainty; reproducible valuation assumptions; honest abstention; and accessible corrections.

Before claiming parity with a senior analyst, test on a held-out benchmark of actual research tasks scored against source evidence, compare qualified human work, report error and abstention rates, and include cost/latency and failure cases. Do not market replacement of hedge-fund analysts as an accomplished capability. Community points and attractive badges are not evidence of financial forecasting quality.

## Sources used for implementation

- WebAuthn credential backup/portability: https://www.w3.org/TR/webauthn-3/
- Discord OAuth: https://docs.discord.com/developers/topics/oauth2
- Discord guild membership: https://docs.discord.com/developers/resources/guild#add-guild-member
- Discord interaction signatures: https://docs.discord.com/developers/interactions/receiving-and-responding
- Transactional email: https://resend.com/docs/api-reference/emails/send-email
- Email idempotency window: https://resend.com/docs/dashboard/emails/idempotency-keys

## Artwork

Four original images were created with the built-in image-generation tool and copied into `public/badges`: moon, stargazer, techhead and wolf. Prompt direction: premium sculpted cartoon/enamel collectible, circular rim, transparent background, no text; astronaut on lunar crescent, astronomer with telescope, gamer with controller, and suited wolf with symbolic money-bag eyes. These assets provide the display art; ownership and remaining supply come exclusively from database allocations.

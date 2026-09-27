# Discord member verification

The implementation is in `server/member-discord.ts`. It is inactive unless all configuration is present **and** `DISCORD_MEMBER_ENABLED=true`. Configuration readiness is not proof that Discord permissions work: completion requires successful live guild membership and role checks. No Discord application, bot installation, permission change, email delivery, or production deployment is performed by this module's creation.

## Required configuration

| Variable | Meaning |
| --- | --- |
| `MEMBER_PUBLIC_ORIGIN` | Exact HTTPS site origin, without a trailing slash or path. Never derive this from a request header. |
| `DISCORD_CLIENT_ID` | Defaults to the existing application ID `1553172093393440808`. |
| `DISCORD_CLIENT_SECRET` | Server-only secret for that application. |
| `DISCORD_GUILD_ID` | Defaults to the existing server ID `1552864798889353218`. |
| `DISCORD_BOT_TOKEN` | Server-only bot token belonging to the same application. |
| `DISCORD_VERIFIED_ROLE_ID` | The dedicated verified-member role, below the bot's role. |
| `DISCORD_TOKEN_ENCRYPTION_KEY` | Independently generated 32 random bytes encoded as standard padded base64. Store as a secret; never commit or print it. |
| `DISCORD_MEMBER_ENABLED` | Set to `true` only after actual server permissions, callback configuration, outbound mail, and the operational checks below are complete. Defaults off. |

Configure the application's OAuth redirect URI as exactly:

`<MEMBER_PUBLIC_ORIGIN>/api/member/discord/callback`

Only `identify` and `guilds.join` OAuth scopes are requested. Discord's email address is not required; the confirmation goes to the website member's previously verified email.

## Server preparation

1. Install the same application's bot through Discord's authorized install flow. It must have `CREATE_INSTANT_INVITE` for the Add Guild Member operation and `MANAGE_ROLES` for the dedicated verified-member role. Do not grant Administrator. Keep the bot below staff/admin roles.
2. Enable Discord membership screening. Verification waits for an explicit `pending: false` member response; missing screening state is treated as unknown, not completed.
3. Deny `VIEW_CHANNEL` for `@everyone` on member content categories. Grant it to the dedicated verified-member role. Audit child-channel overrides and every alternative role that could grant access. A shared invitation must never expose member content.
4. Remove `CREATE_INSTANT_INVITE` from ordinary members and revoke existing general-use invite links during the controlled rollout. Keep a minimal onboarding/rules area accessible to pending members if needed.
5. Confirm the website's existing members and recovery path before requiring the new flow. Existing Discord users must pass the same ownership/email verification; do not grant verified roles just because a public UserID matches.
6. Verify the mail provider and its transactional outbox worker. Queued is not delivered. The outbox contains sensitive confirmation links and must use the parent service's protected storage, retention and logging rules.

## Flow and route contract

Every member API request uses the site's signed member-request middleware. The unauthenticated OAuth callback performs no token exchange, guild join, role assignment, or quest completion.

| Route | Behavior |
| --- | --- |
| `POST /api/member/discord/start` | Requires active verified member and the first quest's eligibility. Stores a random, short-lived state hash bound to that member's authenticated session; returns `authorizationUrl`. |
| `GET /api/member/discord/callback` | Redirects to the fixed site `/members` route with `discord_code` and `discord_state` in the URL fragment. A browser redirect cannot supply the signed headers required by member APIs. |
| `POST /api/member/discord/complete` | Signed request with `{code,state}`. Exchanges only after matching the initiating member/session and claiming one-use state. Obtains the Discord ID from Discord's `users/@me` API. Stores an encrypted access token and queues email confirmation. |
| `POST /api/member/discord/confirm` | Signed request with `{token}` from the email's `discord_confirm` fragment. Claims a one-use, account-bound confirmation, then joins the server and checks screening. |
| `POST /api/member/discord/refresh` | Retries join/screening/role verification after email confirmation. This never substitutes for the email confirmation. |
| `GET /api/member/discord/status` | Returns `ready`, missing configuration names, current link state, linked Discord identity, and quest eligibility. Never returns tokens or secrets. |
| `POST /api/member/discord/unlink` | Requests role revocation and clears confirmation/OAuth secrets. Reports `revocation_pending` until Discord confirms the role is absent. |

The frontend should immediately remove callback/confirmation fragments from history and retain the parameters only briefly while completing the signed operation. OAuth completion requires the same authenticated session that began linking; if the session was replaced, restart authorization. Email confirmation may be completed by another enrolled browser authenticated as the same member. Do not perform confirmation on a GET request: email security scanners can visit links automatically.

Public UserIDs identify profiles. They are never passwords, bearer tokens, or proof of Discord ownership.

## Completion, identity and recovery

- Discord identity is one-to-one with the member record. The provider-supplied Discord ID is unique in the database; client-supplied IDs are ignored.
- Unlink revokes access but retains the identity mapping. Re-linking the same Discord account is supported; changing to another Discord account requires a separately reviewed recovery procedure. There is no automatic account reassignment endpoint.
- Email confirmation alone does not complete the Discord quest. The module must observe membership screening complete, successfully assign the configured role, fetch the member again, and confirm that role is present. Only then does it call `onDiscordVerified` inside a database savepoint.
- A rejected quest hook causes compensating role revocation. A concurrent unlink is held pending while an in-flight role grant owns a short lease; revocation runs after that grant settles. This prevents reporting revoked while a delayed grant restores access.
- The member's qualifying website state is rechecked after network operations. Disabling/deleting a member must also initiate or reconcile Discord role revocation.
- Expired or abandoned email confirmations can be recovered by unlinking the pending connection, waiting for revocation confirmation, and starting the same-account link again. The UI must expose this recovery path.
- OAuth tokens are encrypted using AES-256-GCM, with member and Discord IDs as authenticated context. They are retained for at most 15 minutes, removed after joining, and never used as permanent Discord credentials. The long-lived bot token remains in secret configuration. Refresh tokens are not persisted.

## Reconciliation worker

`mountMemberDiscord(app, options)` returns `{readiness, reconcile}`. Root integration must retain that controller and invoke `reconcile()` from a server-owned scheduled worker. Each call processes a bounded batch; it retries pending revocations and link completion, revokes roles for inactive members, and erases expired link secrets. Use a regular short interval and alert on old `revocation_pending`, `join_retry`, or `pending_screening` records. A long screening wait may be legitimate; distinguish it from transport failures.

The `discord_member_links` row is the durable retry queue. A process restart does not erase pending revocation. Network workers use a one-minute lease, allowing crashed operations to be reclaimed. Do not expose the reconciler as a public endpoint. `reconcile()` is inactive when readiness is false; expired secrets must therefore also be covered by the parent service's maintenance/retention process if the integration is disabled for an extended period.

Authorization for DD intake must join `discord_member_links` to the active, verified website member and require `state='verified'`. A Discord display name or public UserID is insufficient. The separate Discord interactions adapter owns signature verification and restricted-channel DD intake; this module does not mount an interactions endpoint.

## Remaining operational work

- Complete the real bot install and configure its secrets securely.
- Audit live channel/role permission inheritance and register the exact redirect URI.
- Run real email and Discord checks using a controlled member before enabling the integration.
- Schedule reconciliation and verify inactive-member revocation under a simulated provider outage.
- Establish reviewed account-recovery and deleted-member handling. The retained mapping must not be casually reassigned or silently cascade-deleted before access is revoked.
- Redact OAuth codes, email confirmation tokens, Authorization headers and query strings on callback routes from proxy/application logs. Keep private queues inaccessible to members.
- Role removal stops authorization to member channels only if no other role grants the same access. Actual server permissions, not website state alone, determine that boundary.

The module does not claim that these operational steps have occurred. It does not bypass Discord membership screening, mint NFTs, grant staff privileges, or post announcements.

## Verification

`npx vitest run tests/member-discord.test.ts` covers configuration fail-closed behavior, fixed callback redirect, member/session-bound OAuth state, concurrent replay, provider identity, encrypted token retention, email binding/expiry, screening and role checks, duplicate ownership, temporary API failures, inactive-member revocation, permanent identity recovery, rejected quest proof compensation, and revocation racing an in-flight grant.

Primary documentation:

- [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2)
- [Add Guild Member](https://docs.discord.com/developers/resources/guild#add-guild-member)
- [Discord permissions](https://docs.discord.com/developers/topics/permissions)

# SAM member quests — version 1

These are implementation rules, not claims that the integrations are configured or live.

## Admission and invitation ownership

Existing approved members verify their existing email and register a browser device. New members must redeem a random, one-use invitation bound to their email. Public UserIDs do not authenticate anyone. Each verified member has exactly ten lifetime successful-join slots. Unused slots can be revoked and reissued; consumed slots never return, including when the invited account is deleted. Invitations expire after seven days. Starting email verification reserves a link for twenty minutes, preventing routine rotation during verification; manual revocation remains available to its owner. Tokens are random 256-bit values, stored only as hashes by the invitation subsystem.

Each member has one immutable inviter. The system rejects self-referrals, ownership reassignment, cycles, recipient substitutions, expired tokens, and replay. Direct verified invite count and all-depth network reach are separate from research points. Disabled/deleted members do not count as current verified reach. Their original invitation consumption remains recorded. No referral adds research expertise points.

## Quest sequence

1. **Invite someone you trust:** one accepted, email-verified invitation. Ten available invitations is the cap, not this quest's requirement. The one-person completion threshold is an explicit initial product default because the original brief did not define it. Completion queues the Discord quest email once.
2. **Enter the observatory:** authenticated website account, Discord OAuth, confirmation through the already verified member email, and actual guild/role verification performed by the Discord integration. The integration calls `onDiscordVerified` only after these checks. Merely typing a valid public UserID is never enough. Completion queues the research quest email once.
3. **Build an evidence record:** net 500 research points. Every ten points changes numeric rank; reaching 500 completes the quest and queues one completion email. The displayed current rank and completion respond to later review reversals; past events remain auditable.

Completed referral quests are not revoked simply because an invitee later closes an account. The profile's current referral count may accordingly be lower than the completed quest threshold.

## Digital collectibles

- **First Man on the Moon, x200:** first 200 verified memberships, allocated by recorded email-verification timestamp and member ID to break ties. Existing unverified waitlist entries cannot consume a verified-member collectible. Each allocation has an immutable serial.
- **Discord Pioneer Collection, x100 total:** first 100 completed Discord quests reserve one selection across Stargazer, Techhead, and Wolf of Wall Street. Selecting a design is final; retrying the same choice is safe. Eligibility is reserved at completion, so a delayed design selection cannot cost a member their place.
- Deleting/disabling accounts never replenishes supply. Keep issuance records when deleting personal information. Display remaining inventory from committed allocations, not current member count.
- These are **digital collectible badges**, not NFTs. No blockchain token, market value, trading feature, or ownership on a chain is claimed by this implementation.

## Research ledger and titles

Only an authenticated trusted research callback may call `awardReview`. The calling integration must verify the service identity, SAMV2 validation receipt, evidence, and any independent-review requirements before constructing its authority object. This module does not expose a public points-award endpoint. Every award references a submission, immutable review ID, validation receipt, evidence IDs, reviewer, and reason. Positive awards require evidence references.

An award is **0, 1, or 3 total points per submission**. A replay is idempotent; reusing a review ID with different content fails. Appeals identify the exact current review they supersede. Upgrading +1 to +3 appends +2; reversing +3 to 0 appends -3. No review or ledger entry is silently removed.

Zero is appropriate for a duplicate, spam, unsupported material, or verified falsehood, with distinct explanations. Unverifiable does not mean false. One point rewards a useful supported contribution. Three points require substantive evidence-backed research and the independent quality review enforced by the research pipeline. Correctness is not judged by whether the stock later rises.

All five initial earned titles are unlimited; the catalog displays that rather than invented remaining supply:

| Title | Requirement |
| --- | --- |
| Signal Scout | Three current +3 reviews |
| Source Sleuth | Five current +3 reviews with at least two independent primary sources |
| Counterweight | Three current +3 reviews for substantiated rebuttals |
| First Response | Three current +3 reviews submitted within 30 minutes after a verifiable event |
| Clear Thinker | Five current +3 reviews using fewer than 1,200 characters |

Quality metadata must come from verified review records, not the submitting browser. Speed and brevity never independently generate points. Titles are recomputed from the current review decisions so invalidated work cannot retain a false qualification.

## Privacy, concurrency, timing, and integration

Member directory responses contain public UserID and research rank/title only. An authenticated member's profile exposes their own referral counts, quests, and awards, not emails or another person's private invitation tree. The member's invitation-management screen includes recipient emails they supplied, but never returns stored invitation tokens.

All mutations use SQLite savepoints and work inside the authentication/research outer transaction. Unique constraints protect invitation redemption, collection allocation, Discord identity, and review idempotency. Persist the SQLite database on a durable single-writer service volume; multiple independent SQLite files cannot enforce shared inventory. Never delete collectible/ledger records in a user-delete implementation; anonymize personal associations according to the account-deletion policy.

`questDeadline` must be a real configured ISO timestamp. Missing/invalid values produce `not_scheduled`; an elapsed timestamp produces `ended`. This timer does not silently expire invitation quotas, points, or reserved collectible eligibility. Both website and Discord should consume the same profile countdown. Readiness defaults to false and must reflect configured, usable email/Discord/research integrations.

Email delivery uses the durable mail outbox with unique event keys. Queued or provider-accepted email is not a promise of inbox delivery. There is no new quest invented after 500 points; completion email says future quests appear only when announced.

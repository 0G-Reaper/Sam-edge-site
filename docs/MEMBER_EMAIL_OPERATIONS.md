# Member email: delivery evidence and prelaunch verification

This release implements the receiving endpoint and operator delivery check. Configuration is not evidence of successful delivery. No provider account, sender domain or inbox has been verified merely by installing the code.

## Configure before the member cutover

1. Verify an operator-owned sending domain in Resend, including the DNS authentication records it supplies. Create a scoped sending credential for that domain. Keep credentials in protected service variables.
2. On the website service, configure `RESEND_API_KEY`, `MEMBER_EMAIL_FROM`, and `MEMBER_EMAIL_ENABLED=true`. Configure `MEMBER_EMAIL_PROBE_TO` as a mailbox the operator owns and can inspect. The application never accepts a probe recipient from an HTTP request.
3. In Resend, create a webhook for the website's exact canonical HTTPS origin at `/api/webhooks/resend`. Subscribe to `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, and `email.suppressed`. Store its separate signing secret as `RESEND_WEBHOOK_SECRET` on the website service. Use separate endpoints/secrets for staging and production.
4. Deploy the reviewed code while preserving the existing database volume. Leave `MEMBER_ACCESS_ENABLED` off for a first activation. Do not apply unrelated staged environment changes. The existing waitlist is not imported during the delivery check.
5. Using the existing administrator bearer credential, call `POST /api/admin/members/email-probe` with a JSON body containing one new UUID: `{ "probeId": "<new UUID>" }`. Keep the credential out of request URLs, chat, source control and command history. There is no public test-email form.
6. The durable worker processes the probe on its next 15-second tick. Before membership activation, it sends only `operator_delivery_probe` messages. It does not process ordinary member email, import members or advance quests. Repeating the same UUID returns the same outbox item; a different probe is limited to one per ten minutes across restarts. Unsent probes expire after fifteen minutes.
7. Check `GET /api/admin/members/email-probe/<probeId>` with the same administrator authentication. Compare the reference in the actual mailbox with the requested UUID. Verify both the signed delivery event and the message's real arrival, including spam-folder placement. A provider event alone does not prove inbox placement or human receipt.
8. Complete existing-member email verification, device recovery, backup restoration and the private staging journey before turning on members-only access. A successful email probe does not activate any of those gates automatically.

## What the status means

### Running the check without copying the administrator credential

An operator who controls the deployment can set `MEMBER_EMAIL_PROBE_ID` to one new UUID in protected service configuration and restart the reviewed service **after the live callback endpoint and provider webhook are ready**. On startup, a bounded check calls the same protected HTTP endpoints using the existing `ADMIN_TOKEN` internally. The target must be the configured canonical HTTPS origin; redirects are rejected. It refuses to send if membership is already active or any member has been imported. The recipient remains the existing server-configured probe mailbox.

The check lasts at most three minutes, uses the durable UUID deduplication and cooldown, and reports only the reference, outbox ID, signed-delivery timestamps and aggregate counts in service logs. A failure never logs credentials, email addresses, provider response bodies or raw exceptions. It does not stop the website. `member_email_probe_delivered` requires both a signed delivery receipt and membership remaining inactive; the original signup count must not decrease. A count check alone is not a database restore test.

Set `MEMBER_EMAIL_PROBE_ID` back to an empty value after the check. Restarts with the same UUID do not send a new copy. A successful old reference is evidence about that same message, not a fresh delivery test. Do not enable this check before the endpoint is deployed or use it after membership activation. Checking the actual mailbox remains a separate step.

`GET /api/admin/members/status` retains the existing queue counts in `email` and adds aggregate `emailDelivery` diagnostics. It does not return addresses, message text, verification codes, provider payloads or secrets.

| Observation | Meaning |
| --- | --- |
| `transportConfigured` | Sending is enabled and a key/sender are configured; this is not a domain-authentication check. |
| `webhookConfigured` | A signing secret has valid configuration; a real callback has not necessarily arrived. |
| `probeRecipientConfigured` | A valid destination is configured on the server; mailbox ownership still needs the operator's check. |
| Queue `accepted` | The API or a matched signed event proves the provider accepted the job. |
| Delivery `unconfirmed` / `sent` | No final delivery evidence yet. |
| `delivered_to_mail_server` | The provider reports recipient mail-server acceptance. It does not prove inbox placement or reading. |
| `delayed` | Temporary delivery trouble; the provider may keep trying. The application does not send another copy. |
| `failed` | The provider reports a sending failure. Investigate the sender, recipient, quota or provider configuration. |
| `bounced` / `complained` / `suppressed` | A permanent rejection, spam report or provider suppression. Subsequent automatic sends to this recipient are suppressed locally. |
| `awaitingDeliveryOver15Minutes` | Accepted messages still lacking final delivery evidence after fifteen minutes; investigate the webhook and provider logs. |
| `lastEventAt` | Time the application most recently received a valid event matching its own outbox. |

Delivery summaries preserve stronger evidence when events arrive out of order: late `sent` or `delivery_delayed` events do not erase delivery, and a complaint remains visible even if a delivery event arrives afterward. Permanent failures take precedence in an inconsistent event history. The complete matched event identities/types/timestamps remain available in the protected database for investigation.

Do not automatically remove recipient suppression or keep retrying rejected addresses. Verify the issue and the recipient's wishes before an operator considers recovery. This release provides no automated suppression-release endpoint. Application deletion does not remove provider-managed suppression or vendor logs.

## Failure and privacy behavior

- Svix verifies the signature and timestamp over the exact raw body before JSON parsing. Bodies are limited to 32 KiB. Invalid signatures/timestamps are rejected, and retries with the same event ID are idempotent. Reusing an event ID with different content is rejected.
- New sends carry a random outbox ID as a provider tag. This allows an event to reconcile a send even if it arrives before the API response or the response is lost. A matched event stops automatic duplicate delivery attempts.
- Old outbox rows retain the original untagged envelope when upgrading. Changing the payload of an already attempted send under the same idempotency key would break safe retries. Untagged legacy events can still match an already known provider ID. Legacy response-loss cases without a saved provider ID rely on the original bounded, idempotent send retry.
- The provider ID, recipient and local send attempt must agree. Unrelated, never-attempted, cancelled and deleted-member messages do not create event records. Open/click tracking is not used.
- The event table stores event/outbox/provider IDs, event type, timestamps and a payload hash. It does not retain raw provider payloads, email subjects or addresses. The existing outbox remains subject to the member-data deletion process.
- Deletion immediately removes matching email events. While Discord or SAMV2 cleanup is pending, callbacks for the disabled member or their address are ignored, including signup/login mail created before a member ID existed. Once deletion completes, missing outbox records prevent replay from recreating data.
- Provider-accepted email already in transit cannot be recalled. Suppression prevents future automatic attempts; it cannot cancel a request already accepted externally.
- Store and monitor provider-side webhook failures. After an outage, use the provider's replay controls rather than sending duplicate user emails. An endpoint disabled by the provider must be re-enabled there.

## Verification in this release

Automated checks use synthetic signed events and local SQLite, including the actual Svix verifier. They cover signature/body/timestamp rejection, duplicate events, out-of-order delivery, acceptance/response-loss races, bounces/complaints, additive legacy migration, deletion/replay, protected probes and keeping membership inactive during the probe. They do not claim a real Resend delivery or browser sign-in has occurred.

Official references: [signature verification](https://resend.com/docs/webhooks/verify-webhooks-requests), [event types](https://resend.com/docs/webhooks/event-types), [email tags](https://resend.com/docs/dashboard/emails/tags), [retries and replays](https://resend.com/docs/webhooks/retries-and-replays), [Svix verification](https://docs.svix.com/receiving/verifying-payloads/how).

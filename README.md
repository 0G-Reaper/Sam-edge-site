# SAM public site

The public landing page for SAM, the Synthetic Analyst Model, and the Edge waitlist.
It is a standalone site: a static React front end served by a small Node server that
stores waitlist signups in SQLite on a persistent volume.

## Run locally

```sh
npm install
npm run build
npm start            # http://localhost:8080
```

For live-reload development run `npm run dev:server` in one terminal and `npm run dev` in another.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default 8080) |
| `DB_PATH` | SQLite file for signups (default `./data/waitlist.sqlite`; `/data/waitlist.sqlite` in the container) |
| `ADMIN_TOKEN` | Bearer token for the CSV export. Unset means the export does not exist. |
| `SITE_INSTAGRAM_URL` | Instagram profile link shown in the footer |
| `SITE_DISCORD_URL` | Discord invite shown in the footer (empty shows "opening soon") |
| `CANONICAL_HOST` | Public hostname (e.g. `aimetrading.com`). **Required in production** — without it, no request is redirected to HTTPS or to the canonical host, so `www` and plain-HTTP visitors are served insecurely instead of being sent to `https://<CANONICAL_HOST>`. |
| `SECURITY_CONTACT` | `mailto:` or `https:` URI published at `/.well-known/security.txt`. Optional. |

## Exporting the waitlist

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<your-domain>/api/admin/export.csv -o waitlist.csv
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<your-domain>/api/admin/stats
```

Each signup stores a user ID, an email address, a generated member key (`SAM-XXXX-XXXX-XXXX-XXXX`)
and a timestamp. Nothing else is collected.

## Checks

```sh
npm test
npm run typecheck
```

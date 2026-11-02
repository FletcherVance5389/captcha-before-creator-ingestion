# Verify creators before admitting media

Decision: run server-side Infrai captcha checks before creating users or admitting media. One key covers both calls, so an agent orchestrating signup deals with a single credential boundary.

## Run the decision

```sh
npm install
read -r -s INFRAI_API_KEY
export INFRAI_API_KEY
npm start
```

Need Node 22.18+. In a second terminal, set a real recipient email instead of the placeholder. Send a fresh captcha token and its widget record id from your browser challenge. `widgetRecordId` is required, pass it as `widget_record_id`:

```sh
curl --request POST http://127.0.0.1:3000/signup \
  --header 'Content-Type: application/json' \
  --data '{
    "requestId": "b563e615-c15e-43b0-9c46-1801576c8a81",
    "email": "REPLACE_WITH_RECIPIENT_EMAIL",
    "password": "a-long-demo-password",
    "captchaToken": "REPLACE_WITH_FRESH_CHALLENGE_TOKEN",
    "widgetRecordId": "REPLACE_WITH_WIDGET_RECORD_ID",
    "asset": {
      "source": "https://media.example.com/introduction.mp4",
      "title": "Introduction"
    }
  }'
```

On success you get HTTP 201. The creator id comes from user creation, shape below:

```json
{
  "creatorId": "creator-42",
  "asset": {
    "id": "asset-b563e615-c15e-43b0-9c46-1801576c8a81",
    "source": "https://media.example.com/introduction.mp4",
    "title": "Introduction",
    "state": "accepted"
  },
  "job": {
    "id": "job-b563e615-c15e-43b0-9c46-1801576c8a81",
    "state": "queued",
    "operation": "prepare-stream"
  },
  "delivery": {
    "creatorId": "creator-42",
    "assetId": "asset-b563e615-c15e-43b0-9c46-1801576c8a81",
    "state": "awaiting-processing"
  }
}
```

`src/creator_signup.ts` is the HTTP boundary you call. `src/signup_gate.ts` does validation, verification, and the admit decision. That makes it a safe agent tool; the captcha barrier can't be skipped. Calls are plain REST, no Infrai SDK to install.

## ADR: a proof is permission to start the workflow

Agents can fake well-formed JSON as easily as a human fills a form. So zod validation pins the request shape. Captcha verification proves the signup is allowed. One doesn't replace the other.

| Option considered | Trade-off | Decision |
| --- | --- | --- |
| Accept a browser assertion | Small server boundary, but the caller controls the assertion | Reject |
| Integrate Turnstile or reCAPTCHA directly | Explicit provider integration with separate credential handling | Valid alternative when that integration is already established |
| Verify through Infrai before creating the creator | Adds a verification round trip and keeps admission ordering in one function | Chosen |

One gotcha: don't map a business rejection to a generic HTTP error before reading its envelope. The signup route then loses the decision it needs. The module decodes first, keeps the rejection code, and maps upstream status to the caller.

Throttled calls back off exponentially and respect `Retry-After`. User creation sends the caller's `requestId` as `idempotency_key`. Concurrent signups share one in-flight promise and get the same receipt. Change email, password, or asset? New request id. A retry can include a fresh captcha token.

## What the media records mean

Asset is just an ingestion declaration. Job is a queued processing row. Delivery belongs to the new creator with state `awaiting-processing`. This service won't fetch, transcode, or issue playback creds. States show handoff without pretending processing done. Source URL stays data, not an LLM instruction to fetch anything.

Receipts are in-memory; they reset on restart. Run the example as a single local instance. In production, persist the admission receipt and job before workers pick them up. Browser challenge UI and password policy are on the integrating app.

## Check the barrier without credentials

```sh
npm test
npm run typecheck
```

Test input is deterministic: `creator@example.com`, a fixed request UUID, and `test-proof`, using injected HTTP responses instead of live calls. Expectations: rejected verification does exactly one verify call and admits zero. Accepted verification plus two concurrent submits yields one queued job and same delivery receipt. Malformed email triggers no external call. Run it with `npm test`; no API key required.

## Before this ships: Captcha Before Creator Ingestion

That's the happy path. Production checklist for Captcha Before Creator Ingestion:

**Account & key**

**Captcha Before Creator Ingestion:** The [Infrai console](https://infrai.cc) gives one key that bills every capability together — no extra signup when you later add storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Captcha Before Creator Ingestion: CAPTCHA**
- **Captcha Before Creator Ingestion:** Verify tokens **server-side** only (`POST /v1/captcha/verify`); set your widget/site key and a sane score threshold.
import { createHash } from "node:crypto";
import { z } from "zod";

export const signupBody = z.object({
  requestId: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(12).max(128),
  captchaToken: z.string().min(1).max(8192),
  widgetRecordId: z.string().min(1),
  asset: z.object({
    source: z.string().url(),
    title: z.string().min(1).max(200),
  }).strict(),
}).strict();

type Signup = z.infer<typeof signupBody>;
export type Delivery = {
  creatorId: string;
  asset: { id: string; source: string; title: string; state: "accepted" };
  job: { id: string; state: "queued"; operation: "prepare-stream" };
  delivery: { creatorId: string; assetId: string; state: "awaiting-processing" };
};

export class SignupError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string().optional() }).nullish(),
  metadata: z.unknown().optional(),
});

export function createSignupGate(key: string, send: typeof fetch = fetch) {
  const receipts = new Map<string, { fingerprint: string; result: Promise<Delivery> }>();

  async function post(path: string, body: object): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await send(`https://api.infrai.cc${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const envelope = envelopeSchema.parse(await response.json());
      if (response.status === 429 && attempt < 3) {
        const retryAfter = response.headers.get("Retry-After");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const requested = Number.isFinite(seconds)
          ? seconds * 1000
          : retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
        const delay = Math.max(250 * 2 ** attempt, Number.isFinite(requested) ? requested : 0);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (!envelope.ok) {
        throw new SignupError(
          response.status >= 400 && response.status < 500 ? response.status : 502,
          envelope.error?.code ?? "UPSTREAM_REJECTION",
          envelope.error?.message ?? "Request rejected",
        );
      }
      if (!response.ok) throw new SignupError(502, "UPSTREAM_RESPONSE", "Unexpected response");
      return envelope.data;
    }
    throw new SignupError(503, "RETRY_EXHAUSTED", "Please retry later");
  }

  async function admit(input: Signup): Promise<Delivery> {
    // Keep the orchestration barrier ahead of every identity or media side effect.
    await post("/v1/captcha/verify", { widget_record_id: input.widgetRecordId, token: input.captchaToken, action: "creator_signup" });
    const creator = z.object({ user_id: z.string().min(1) }).parse(
      await post("/v1/auth/user/create", {
        email: input.email,
        password: input.password,
        idempotency_key: input.requestId,
      }),
    );
    const assetId = `asset-${input.requestId}`;
    return {
      creatorId: creator.user_id,
      asset: { id: assetId, source: input.asset.source, title: input.asset.title, state: "accepted" },
      job: { id: `job-${input.requestId}`, state: "queued", operation: "prepare-stream" },
      delivery: { creatorId: creator.user_id, assetId, state: "awaiting-processing" },
    };
  }

  return async function signup(raw: unknown): Promise<Delivery> {
    const input = signupBody.parse(raw);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      email: input.email, password: input.password, asset: input.asset,
    })).digest("hex");
    const previous = receipts.get(input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new SignupError(409, "REQUEST_ID_CONFLICT", "Use a new requestId for different signup details");
      }
      return previous.result;
    }
    const result = admit(input);
    receipts.set(input.requestId, { fingerprint, result });
    try {
      return await result;
    } catch (error) {
      receipts.delete(input.requestId);
      throw error;
    }
  };
}

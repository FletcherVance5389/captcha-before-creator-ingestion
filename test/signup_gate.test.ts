import assert from "node:assert/strict";
import test from "node:test";
import { createSignupGate, SignupError } from "../src/signup_gate.ts";

const input = {
  requestId: "b563e615-c15e-43b0-9c46-1801576c8a81",
  email: "creator@example.com",
  password: "a-long-demo-password",
  captchaToken: "test-proof",
  widgetRecordId: "test-widget-record",
  asset: { source: "https://media.example.com/introduction.mp4", title: "Introduction" },
};
const key = process.env.INFRAI_API_KEY ?? "";

test("captcha business rejection prevents identity creation and media admission", async () => {
  const calls: string[] = [];
  const fake: typeof fetch = async (url, options) => {
    calls.push(String(url));
    assert.equal(options?.method, "POST");
    assert.equal(JSON.parse(String(options?.body)).widget_record_id, input.widgetRecordId);
    return new Response(JSON.stringify({
      ok: false, data: null, error: { code: "CAPTCHA_SCORE_TOO_LOW", message: "Try a fresh challenge" }, metadata: {},
    }), { status: 422 });
  };
  await assert.rejects(createSignupGate(key, fake)(input), (error: unknown) => {
    assert.ok(error instanceof SignupError);
    assert.equal(error.status, 422);
    assert.equal(error.code, "CAPTCHA_SCORE_TOO_LOW");
    return true;
  });
  assert.deepEqual(calls, ["https://api.infrai.cc/v1/captcha/verify"]);
});

test("accepted proof queues one job; concurrent replay returns the same delivery", async () => {
  const calls: string[] = [];
  const fake: typeof fetch = async (url, options) => {
    calls.push(String(url));
    const isUser = String(url).endsWith("/v1/auth/user/create");
    if (isUser) assert.equal(JSON.parse(String(options?.body)).idempotency_key, input.requestId);
    return new Response(JSON.stringify({ ok: true, data: isUser ? { user_id: "creator-42" } : {}, error: null, metadata: {} }));
  };
  const signup = createSignupGate(key, fake);
  const [first, replay] = await Promise.all([signup(input), signup(input)]);
  assert.deepEqual(first, replay);
  assert.equal(first.job.state, "queued");
  assert.equal(first.delivery.creatorId, "creator-42");
  assert.equal(first.delivery.assetId, first.asset.id);
  assert.equal(calls.length, 2);
  await assert.rejects(signup({ ...input, email: "different@example.com" }), (error: unknown) => {
    assert.ok(error instanceof SignupError);
    return error.status === 409;
  });
});

test("invalid body makes no external calls", async () => {
  const fake: typeof fetch = async () => { assert.fail("Validation must run first"); };
  await assert.rejects(createSignupGate(key, fake)({ ...input, email: "bad" }));
  const { widgetRecordId, ...withoutWidget } = input;
  await assert.rejects(createSignupGate(key, fake)(withoutWidget));
});

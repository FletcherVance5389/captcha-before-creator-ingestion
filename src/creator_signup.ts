import { createServer } from "node:http";
import { ZodError } from "zod";
import { createSignupGate, SignupError } from "./signup_gate.ts";

const key = process.env.INFRAI_API_KEY;
if (!key) throw new Error("Set INFRAI_API_KEY before starting the signup service");
const signup = createSignupGate(key);

createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.method !== "POST" || request.url !== "/signup") {
    response.writeHead(404).end(JSON.stringify({ error: "Route not found" }));
    return;
  }
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 32_768) {
        throw new SignupError(413, "BODY_TOO_LARGE", "Body exceeds 32 KiB");
      }
    }
    const delivery = await signup(JSON.parse(body));
    response.writeHead(201).end(JSON.stringify(delivery));
  } catch (error) {
    const status = error instanceof SignupError ? error.status
      : error instanceof ZodError || error instanceof SyntaxError ? 400 : 502;
    response.writeHead(status).end(JSON.stringify({
      error: error instanceof SignupError ? error.code : status === 400 ? "INVALID_BODY" : "UPSTREAM_REQUEST",
      message: error instanceof SignupError ? error.message : status === 400 ? "Check signup fields" : "Request could not complete",
    }));
  }
}).listen(3000, "127.0.0.1", () => console.log("Creator signup listening on http://127.0.0.1:3000/signup"));

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { paymentPath } from "../src/middleware.js";
import type { PaymentPathConfig } from "../src/types.js";

const BASE_CONFIG: PaymentPathConfig = {
  price: "$1.00",
  payTo: "0xTestWallet",
  accepts: [
    {
      asset: "USDC",
      network: "eip155:8453",
      facilitatorUrl: "https://x402.stablecoin.xyz",
    },
    {
      asset: "SBC",
      network: "eip155:8453",
      facilitatorUrl: "https://x402.stablecoin.xyz",
    },
  ],
  fields: [
    { name: "sender", type: "string", required: true, description: "Agent or service identifier" },
    { name: "body", type: "string", required: true, description: "Message content" },
    { name: "reply_to", type: "email", required: false, description: "Email address for replies" },
  ],
  onFulfill: async (payload, _receipt) => {
    return { status: "delivered", sender: payload.body.sender };
  },
};

function makeRequest(
  opts: {
    method?: string;
    body?: Record<string, unknown>;
    paymentSignature?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };
  if (opts.paymentSignature) {
    headers["PAYMENT-SIGNATURE"] = opts.paymentSignature;
  }
  return new Request("https://example.com/contact", {
    method: opts.method ?? "POST",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

function encodePayment(payload: Record<string, unknown>): string {
  return btoa(JSON.stringify(payload));
}

let originalFetch: typeof globalThis.fetch;

describe("paymentPath", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // --- 402 Challenge ---

  it("returns 402 when no PAYMENT-SIGNATURE header is present", async () => {
    const req = makeRequest({ body: { sender: "test-agent", body: "hello" } });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 402);

    const json = await res.json();
    assert.equal(json.message, "Payment required");
    assert.equal(json.price, "$1.00");
    assert.equal(json.accepts.length, 2);
    assert.equal(json.accepts[0].asset, "USDC");
    assert.equal(json.accepts[1].asset, "SBC");
  });

  it("includes field schema in 402 response", async () => {
    const req = makeRequest();
    const res = await paymentPath(req, BASE_CONFIG);
    const json = await res.json();

    assert.ok(json.fields);
    assert.equal(json.fields.length, 3);
    assert.equal(json.fields[0].name, "sender");
    assert.equal(json.fields[0].required, true);
    assert.equal(json.fields[2].name, "reply_to");
    assert.equal(json.fields[2].required, false);
  });

  it("includes PAYMENT-REQUIRED header in 402 response", async () => {
    const req = makeRequest();
    const res = await paymentPath(req, BASE_CONFIG);

    const header = res.headers.get("PAYMENT-REQUIRED");
    assert.ok(header, "PAYMENT-REQUIRED header should be present");

    const decoded = JSON.parse(atob(header));
    assert.equal(decoded.x402Version, 2);
    assert.ok(Array.isArray(decoded.accepts));
    assert.equal(decoded.accepts[0].maxAmountRequired, "1000000");
    assert.equal(decoded.accepts[0].payTo, "0xTestWallet");
  });

  it("omits fields from 402 body when none configured", async () => {
    const configNoFields = { ...BASE_CONFIG, fields: undefined };
    const req = makeRequest();
    const res = await paymentPath(req, configNoFields);
    const json = await res.json();

    assert.equal(json.fields, undefined);
  });

  // --- CORS ---

  it("returns 204 for OPTIONS preflight", async () => {
    const req = makeRequest({ method: "OPTIONS" });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 204);
    assert.ok(res.headers.get("Access-Control-Allow-Origin"));
    assert.ok(res.headers.get("Access-Control-Allow-Headers")?.includes("PAYMENT-SIGNATURE"));
  });

  // --- Invalid payment header ---

  it("returns 400 for malformed PAYMENT-SIGNATURE", async () => {
    const req = makeRequest({
      body: { sender: "test", body: "hi" },
      paymentSignature: "not-valid-base64!!!",
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.ok(json.error.includes("Invalid PAYMENT-SIGNATURE"));
  });

  // --- Field validation ---

  it("returns 422 when required fields are missing", async () => {
    const payment = encodePayment({ network: "eip155:8453", scheme: "exact" });

    globalThis.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ valid: true, payer: "0xAgent" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    const req = makeRequest({
      body: { sender: "test-agent" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 422);
    const json = await res.json();
    assert.ok(json.fields.includes("body is required"));
  });

  it("passes validation when all required fields present", async () => {
    const payment = encodePayment({ network: "eip155:8453", scheme: "exact" });

    globalThis.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ valid: true, payer: "0xAgent" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    const req = makeRequest({
      body: { sender: "test-agent", body: "hello world" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    // Should pass validation (may fail at settle, but not at 422)
    assert.notEqual(res.status, 422);
  });

  // --- Full flow with mocked facilitator ---

  it("completes full verify → fulfill → settle flow", async () => {
    const payment = encodePayment({
      x402Version: 2,
      scheme: "exact",
      network: "eip155:8453",
      payload: { permit: "signed-data" },
    });

    let fetchCallCount = 0;
    globalThis.fetch = mock.fn(async (input: string | URL | globalThis.Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCallCount++;

      if (url.includes("/verify")) {
        return new Response(JSON.stringify({ valid: true, payer: "0xAgentWallet" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/settle")) {
        return new Response(
          JSON.stringify({
            success: true,
            txHash: "0xabc123def456",
            network: "eip155:8453",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const req = makeRequest({
      body: { sender: "claude-agent", body: "Hello, I'd like to discuss a partnership." },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 200);

    const json = await res.json();
    assert.equal(json.status, "delivered");
    assert.equal(json.sender, "claude-agent");
    assert.ok(json.receipt);
    assert.equal(json.receipt.txHash, "0xabc123def456");
    assert.equal(json.receipt.from, "0xAgentWallet");
    assert.equal(json.receipt.to, "0xTestWallet");

    const paymentResponse = res.headers.get("PAYMENT-RESPONSE");
    assert.ok(paymentResponse);
    const decoded = JSON.parse(atob(paymentResponse));
    assert.equal(decoded.success, true);
    assert.equal(decoded.txHash, "0xabc123def456");

    assert.equal(fetchCallCount, 2, "should call /verify and /settle");
  });

  // --- Facilitator errors ---

  it("returns 402 when facilitator says payment is invalid", async () => {
    const payment = encodePayment({ network: "eip155:8453" });

    globalThis.fetch = mock.fn(async () =>
      new Response(
        JSON.stringify({ valid: false, invalidReason: "Permit expired" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as typeof fetch;

    const req = makeRequest({
      body: { sender: "agent", body: "hi" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 402);
    const json = await res.json();
    assert.equal(json.reason, "Permit expired");
  });

  it("returns 502 when facilitator /verify is unreachable", async () => {
    const payment = encodePayment({ network: "eip155:8453" });

    globalThis.fetch = mock.fn(async () => {
      throw new Error("Network error");
    }) as typeof fetch;

    const req = makeRequest({
      body: { sender: "agent", body: "hi" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 502);
    const json = await res.json();
    assert.ok(json.error.includes("verification failed"));
  });

  it("returns 502 when facilitator /settle fails after fulfillment", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    let callIndex = 0;

    globalThis.fetch = mock.fn(async () => {
      callIndex++;
      if (callIndex === 1) {
        return new Response(JSON.stringify({ valid: true, payer: "0xAgent" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("Settlement network error");
    }) as typeof fetch;

    const req = makeRequest({
      body: { sender: "agent", body: "hi" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 502);
    const json = await res.json();
    assert.ok(json.error.includes("Settlement failed"));
  });

  // --- onFulfill rejection ---

  it("returns 500 when onFulfill throws", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    let callIndex = 0;

    globalThis.fetch = mock.fn(async () => {
      callIndex++;
      if (callIndex === 1) {
        return new Response(JSON.stringify({ isValid: true, payer: "0xAgent" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true, txHash: "0xabc" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const rejectConfig: PaymentPathConfig = {
      ...BASE_CONFIG,
      onFulfill: async () => {
        throw new Error("Email service unavailable");
      },
    };

    const req = makeRequest({
      body: { sender: "agent", body: "hi" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, rejectConfig);

    assert.equal(res.status, 500);
    const json = await res.json();
    assert.ok(json.error.includes("Fulfillment failed"));
  });

  // --- Price parsing ---

  it("converts price to atomic units in payment requirements", async () => {
    const configs = [
      { price: "$1.00", expected: "1000000" },
      { price: "$0.50", expected: "500000" },
      { price: "$10.00", expected: "10000000" },
      { price: "$0.01", expected: "10000" },
    ];

    for (const { price, expected } of configs) {
      const req = makeRequest();
      const res = await paymentPath(req, { ...BASE_CONFIG, price });
      const header = res.headers.get("PAYMENT-REQUIRED")!;
      const decoded = JSON.parse(atob(header));
      assert.equal(
        decoded.accepts[0].maxAmountRequired,
        expected,
        `Price ${price} should convert to ${expected}`,
      );
    }
  });
});

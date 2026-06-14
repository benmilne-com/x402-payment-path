import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { paymentPath } from "../src/middleware.js";
import type { PaymentPathConfig, DeduplicationStore } from "../src/types.js";

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
    { name: "callback", type: "url", required: false, description: "Webhook URL" },
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

function mockFacilitator(overrides?: {
  verifyResponse?: Record<string, unknown>;
  settleResponse?: Record<string, unknown>;
  verifyStatus?: number;
  settleStatus?: number;
}) {
  let callIndex = 0;
  globalThis.fetch = mock.fn(async (input: string | URL | globalThis.Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    callIndex++;

    if (url.includes("/verify")) {
      return new Response(
        JSON.stringify(overrides?.verifyResponse ?? { valid: true, payer: "0xAgentWallet" }),
        { status: overrides?.verifyStatus ?? 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("/settle")) {
      return new Response(
        JSON.stringify(overrides?.settleResponse ?? { success: true, txHash: "0xabc123def456", network: "eip155:8453" }),
        { status: overrides?.settleStatus ?? 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
}

function createMemoryDedup(): DeduplicationStore & { seen: Set<string> } {
  const seen = new Set<string>();
  return {
    seen,
    async has(key: string) { return seen.has(key); },
    async add(key: string) { seen.add(key); },
  };
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
    assert.equal(json.fields.length, 4);
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

  // --- Method restriction ---

  it("returns 405 for GET requests", async () => {
    const req = makeRequest({ method: "GET" });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 405);
    assert.equal(res.headers.get("Allow"), "POST, OPTIONS");
    const json = await res.json();
    assert.equal(json.error, "Method not allowed");
  });

  it("returns 405 for PUT requests", async () => {
    const req = makeRequest({ method: "PUT" });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 405);
  });

  it("returns 405 for DELETE requests", async () => {
    const req = makeRequest({ method: "DELETE" });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 405);
  });

  // --- CORS ---

  it("returns 204 for OPTIONS preflight when corsOrigin is set", async () => {
    const req = makeRequest({ method: "OPTIONS" });
    const res = await paymentPath(req, { ...BASE_CONFIG, corsOrigin: "*" });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.ok(res.headers.get("Access-Control-Allow-Headers")?.includes("PAYMENT-SIGNATURE"));
  });

  it("returns 204 without CORS headers when corsOrigin is not set", async () => {
    const req = makeRequest({ method: "OPTIONS" });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  });

  it("does not emit CORS headers on non-OPTIONS when corsOrigin is not set", async () => {
    const req = makeRequest({ body: { sender: "test", body: "hi" } });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  });

  it("emits specific CORS origin when configured", async () => {
    const req = makeRequest({ body: { sender: "test", body: "hi" } });
    const res = await paymentPath(req, { ...BASE_CONFIG, corsOrigin: "https://myapp.com" });

    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://myapp.com");
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
    mockFacilitator();

    const req = makeRequest({
      body: { sender: "test-agent" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 422);
    const json = await res.json();
    assert.ok(json.fields.includes("body is required"));
  });

  it("rejects non-string values for declared fields", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    mockFacilitator();

    const req = makeRequest({
      body: { sender: 12345, body: "hello" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 422);
    const json = await res.json();
    assert.ok(json.fields.some((f: string) => f.includes("sender") && f.includes("string")));
  });

  it("rejects invalid email fields", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    mockFacilitator();

    const req = makeRequest({
      body: { sender: "agent", body: "hello", reply_to: "not-an-email" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 422);
    const json = await res.json();
    assert.ok(json.fields.some((f: string) => f.includes("reply_to") && f.includes("email")));
  });

  it("accepts valid email fields", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    mockFacilitator();

    const req = makeRequest({
      body: { sender: "agent", body: "hello", reply_to: "test@example.com" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.notEqual(res.status, 422);
  });

  it("rejects invalid URL fields", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    mockFacilitator();

    const req = makeRequest({
      body: { sender: "agent", body: "hello", callback: "javascript:alert(1)" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 422);
    const json = await res.json();
    assert.ok(json.fields.some((f: string) => f.includes("callback") && f.includes("http")));
  });

  it("rejects non-URL strings for URL fields", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    mockFacilitator();

    const req = makeRequest({
      body: { sender: "agent", body: "hello", callback: "not a url at all" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 422);
    const json = await res.json();
    assert.ok(json.fields.some((f: string) => f.includes("callback") && f.includes("valid URL")));
  });

  it("accepts valid URL fields", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    mockFacilitator();

    const req = makeRequest({
      body: { sender: "agent", body: "hello", callback: "https://example.com/webhook" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.notEqual(res.status, 422);
  });

  // --- Prototype pollution protection ---

  it("strips __proto__ from request body before fulfillment", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    mockFacilitator();

    let capturedBody: Record<string, unknown> | undefined;
    const spyConfig: PaymentPathConfig = {
      ...BASE_CONFIG,
      onFulfill: async (payload) => {
        capturedBody = payload.body;
        return { status: "ok" };
      },
    };

    const req = makeRequest({
      body: { sender: "agent", body: "hello", __proto__: { isAdmin: true } },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, spyConfig);

    assert.equal(res.status, 200);
    assert.ok(capturedBody);
    assert.equal((capturedBody as any).__proto__?.isAdmin, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(capturedBody, "__proto__"), false);
  });

  it("strips constructor and prototype keys from nested objects", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    mockFacilitator();

    let capturedBody: Record<string, unknown> | undefined;
    const spyConfig: PaymentPathConfig = {
      ...BASE_CONFIG,
      fields: undefined,
      onFulfill: async (payload) => {
        capturedBody = payload.body;
        return { status: "ok" };
      },
    };

    const req = makeRequest({
      body: { nested: { constructor: { prototype: { isAdmin: true } } }, ok: true },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, spyConfig);

    assert.equal(res.status, 200);
    const nested = capturedBody?.nested as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(nested ?? {}, "constructor"), false);
  });

  // --- Replay protection ---

  it("rejects duplicate payment signatures when dedup store is configured", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    mockFacilitator();

    const dedup = createMemoryDedup();
    const dedupConfig = { ...BASE_CONFIG, deduplicationStore: dedup };

    const req1 = makeRequest({
      body: { sender: "agent", body: "hello" },
      paymentSignature: payment,
    });
    const res1 = await paymentPath(req1, dedupConfig);
    assert.equal(res1.status, 200);

    const req2 = makeRequest({
      body: { sender: "agent", body: "hello again" },
      paymentSignature: payment,
    });
    const res2 = await paymentPath(req2, dedupConfig);

    assert.equal(res2.status, 409);
    const json = await res2.json();
    assert.ok(json.error.includes("Duplicate"));
  });

  it("allows different payment signatures through dedup store", async () => {
    mockFacilitator();

    const dedup = createMemoryDedup();
    const dedupConfig = { ...BASE_CONFIG, deduplicationStore: dedup };

    const req1 = makeRequest({
      body: { sender: "agent", body: "hello" },
      paymentSignature: encodePayment({ network: "eip155:8453", nonce: 1 }),
    });
    const res1 = await paymentPath(req1, dedupConfig);
    assert.equal(res1.status, 200);

    const req2 = makeRequest({
      body: { sender: "agent", body: "hello" },
      paymentSignature: encodePayment({ network: "eip155:8453", nonce: 2 }),
    });
    const res2 = await paymentPath(req2, dedupConfig);
    assert.equal(res2.status, 200);
  });

  // --- Body size limit (streaming) ---

  it("rejects oversized bodies", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    const tinyConfig = { ...BASE_CONFIG, maxBodyBytes: 50 };

    const req = makeRequest({
      body: { sender: "agent", body: "x".repeat(200) },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, tinyConfig);

    assert.equal(res.status, 413);
    const json = await res.json();
    assert.ok(json.error.includes("too large"));
  });

  // --- Error detail stripping ---

  it("does not leak internal error details on verify failure", async () => {
    const payment = encodePayment({ network: "eip155:8453" });

    globalThis.fetch = mock.fn(async () => {
      throw new Error("ECONNREFUSED 10.0.0.5:443 internal-service.cluster.local");
    }) as typeof fetch;

    const req = makeRequest({
      body: { sender: "agent", body: "hi" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 502);
    const json = await res.json();
    assert.equal(json.error, "Payment verification failed");
    assert.equal(json.detail, undefined);
  });

  it("does not leak internal error details on settle failure", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    let callIndex = 0;

    globalThis.fetch = mock.fn(async () => {
      callIndex++;
      if (callIndex === 1) {
        return new Response(JSON.stringify({ valid: true, payer: "0xAgent" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("Settlement timeout internal-rpc.cluster:8545");
    }) as typeof fetch;

    const req = makeRequest({
      body: { sender: "agent", body: "hi" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, BASE_CONFIG);

    assert.equal(res.status, 502);
    const json = await res.json();
    assert.equal(json.error, "Settlement failed");
    assert.equal(json.detail, undefined);
  });

  it("does not leak internal error details on fulfill failure but includes receipt", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    mockFacilitator();

    const failConfig: PaymentPathConfig = {
      ...BASE_CONFIG,
      onFulfill: async () => {
        throw new Error("Database connection string: postgres://admin:secret@10.0.0.3/db");
      },
    };

    const req = makeRequest({
      body: { sender: "agent", body: "hi" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, failConfig);

    assert.equal(res.status, 500);
    const json = await res.json();
    assert.ok(json.error.includes("Fulfillment failed"));
    assert.equal(json.detail, undefined);
    assert.ok(json.receipt);
    assert.ok(json.receipt.txHash);
  });

  // --- Fulfillment failure callback ---

  it("calls onFulfillmentFailure when onFulfill throws", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    mockFacilitator();

    let failureCalled = false;
    let capturedReceipt: unknown;

    const failConfig: PaymentPathConfig = {
      ...BASE_CONFIG,
      onFulfill: async () => {
        throw new Error("Email service down");
      },
      onFulfillmentFailure: async (_err, _payload, receipt) => {
        failureCalled = true;
        capturedReceipt = receipt;
      },
    };

    const req = makeRequest({
      body: { sender: "agent", body: "hi" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, failConfig);

    assert.equal(res.status, 500);
    assert.ok(failureCalled, "onFulfillmentFailure should have been called");
    assert.ok(capturedReceipt);
  });

  it("does not crash if onFulfillmentFailure itself throws", async () => {
    const payment = encodePayment({ network: "eip155:8453" });
    mockFacilitator();

    const failConfig: PaymentPathConfig = {
      ...BASE_CONFIG,
      onFulfill: async () => {
        throw new Error("Fulfillment failed");
      },
      onFulfillmentFailure: async () => {
        throw new Error("Dead letter queue also failed");
      },
    };

    const req = makeRequest({
      body: { sender: "agent", body: "hi" },
      paymentSignature: payment,
    });
    const res = await paymentPath(req, failConfig);

    assert.equal(res.status, 500);
    const json = await res.json();
    assert.ok(json.error.includes("Fulfillment failed"));
  });

  // --- Full flow with mocked facilitator ---

  it("completes full verify → settle → fulfill flow", async () => {
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

  it("returns 502 when facilitator /settle fails", async () => {
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

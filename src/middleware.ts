import type {
  PaymentPathConfig,
  FulfillmentPayload,
  PaymentReceipt,
} from "./types.js";
import { FacilitatorClient } from "./facilitator.js";

const DEFAULT_MAX_BODY_BYTES = 65_536;

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Gate a request behind x402 stablecoin payment.
 *
 * - Non-POST/OPTIONS → 405
 * - No PAYMENT-SIGNATURE header → 402 with payment requirements + field schema
 * - Valid PAYMENT-SIGNATURE → verify, settle, fulfill, return receipt
 * - Invalid payment → 400
 */
export async function paymentPath(
  request: Request,
  config: PaymentPathConfig,
): Promise<Response> {
  const corsOrigin = config.corsOrigin;

  if (request.method === "OPTIONS") {
    if (!corsOrigin) return new Response(null, { status: 204 });
    return corsResponse(204, corsOrigin);
  }

  if (request.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed" },
      405,
      corsOrigin,
      { Allow: "POST, OPTIONS" },
    );
  }

  const paymentHeader = request.headers.get("PAYMENT-SIGNATURE")
    ?? request.headers.get("X-PAYMENT");

  if (!paymentHeader) {
    return buildPaymentRequired(config);
  }

  let paymentPayload: Record<string, unknown>;
  try {
    paymentPayload = JSON.parse(
      atob(paymentHeader),
    ) as Record<string, unknown>;
  } catch {
    return jsonResponse(
      { error: "Invalid PAYMENT-SIGNATURE header: not valid base64-encoded JSON" },
      400,
      corsOrigin,
    );
  }

  // Replay protection: hash the payment header and check the dedup store
  if (config.deduplicationStore) {
    const sigHash = await hashPaymentSignature(paymentHeader);
    if (await config.deduplicationStore.has(sigHash)) {
      return jsonResponse(
        { error: "Duplicate payment signature" },
        409,
        corsOrigin,
      );
    }
    await config.deduplicationStore.add(sigHash);
  }

  const maxBody = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  let rawBody: string;
  try {
    rawBody = await readLimitedBody(request, maxBody);
  } catch {
    return jsonResponse(
      { error: `Request body too large (max ${maxBody} bytes)` },
      413,
      corsOrigin,
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    body = {};
  }

  stripDangerousKeys(body);

  const fieldErrors = validateFields(body, config.fields);
  if (fieldErrors.length > 0) {
    return jsonResponse({ error: "Validation failed", fields: fieldErrors }, 422, corsOrigin);
  }

  const accepted = paymentPayload.accepted as Record<string, unknown> | undefined;
  const paymentNetwork = (accepted?.network as string)
    ?? (paymentPayload.network as string)
    ?? "";

  const matched = findMatchingAsset(config, paymentNetwork);
  if (!matched) {
    return buildPaymentRequired(config);
  }

  const requirement = buildSingleRequirement(matched, config);

  const facilitator = new FacilitatorClient(matched.facilitatorUrl);

  let verifyResult;
  try {
    verifyResult = await facilitator.verify(paymentPayload, requirement);
  } catch {
    return jsonResponse(
      { error: "Payment verification failed" },
      502,
      corsOrigin,
    );
  }

  const isPaymentValid = verifyResult.isValid ?? verifyResult.valid ?? false;
  if (!isPaymentValid) {
    return jsonResponse(
      { error: "Payment invalid", reason: verifyResult.invalidReason ?? "unknown" },
      402,
      corsOrigin,
    );
  }

  let settleResult;
  try {
    settleResult = await facilitator.settle(paymentPayload, requirement);
  } catch {
    return jsonResponse(
      { error: "Settlement failed" },
      502,
      corsOrigin,
    );
  }

  const receipt: PaymentReceipt = {
    txHash: settleResult.txHash ?? settleResult.transaction ?? "",
    network: settleResult.network ?? matched.network,
    asset: matched.asset,
    amount: parsePriceToAtomic(config.price, matched.decimals ?? 6),
    from: verifyResult.payer ?? "",
    to: matched.payTo ?? config.payTo,
  };

  const fulfillmentPayload: FulfillmentPayload = {
    body,
    headers: Object.fromEntries(request.headers.entries()),
    ip: request.headers.get("CF-Connecting-IP")
      ?? request.headers.get("X-Forwarded-For")
      ?? undefined,
    timestamp: new Date().toISOString(),
  };

  let fulfillResult: unknown;
  try {
    fulfillResult = await config.onFulfill(fulfillmentPayload, receipt);
  } catch (err) {
    if (config.onFulfillmentFailure) {
      try {
        await config.onFulfillmentFailure(err, fulfillmentPayload, receipt);
      } catch {
        // Best-effort — the failure handler itself failed
      }
    }
    return jsonResponse(
      { error: "Fulfillment failed after settlement", receipt },
      500,
      corsOrigin,
    );
  }

  const responseBody = {
    ...(typeof fulfillResult === "object" && fulfillResult !== null
      ? fulfillResult
      : { result: fulfillResult }),
    receipt,
  };

  const paymentResponse = btoa(JSON.stringify({
    success: true,
    txHash: receipt.txHash,
    network: receipt.network,
  }));

  return jsonResponse(responseBody, 200, corsOrigin, {
    "PAYMENT-RESPONSE": paymentResponse,
  });
}

function buildPaymentRequired(config: PaymentPathConfig): Response {
  const paymentRequirements = buildPaymentRequirements(config);
  const encodedRequirements = btoa(JSON.stringify(paymentRequirements));

  const body = {
    message: "Payment required",
    price: config.price,
    accepts: config.accepts.map((a) => ({
      asset: a.asset,
      network: a.network,
      facilitatorUrl: a.facilitatorUrl,
      ...(a.payTo ? { payTo: a.payTo } : {}),
    })),
    payTo: config.payTo,
    ...(config.fields ? { fields: config.fields } : {}),
  };

  return jsonResponse(body, 402, config.corsOrigin, {
    "PAYMENT-REQUIRED": encodedRequirements,
  });
}

function buildPaymentRequirements(
  config: PaymentPathConfig,
): Record<string, unknown> {
  return {
    x402Version: 2,
    accepts: config.accepts.map((a) => buildSingleRequirement(a, config)),
  };
}

/** Build a flat requirement for one asset, matching the x402 facilitator's expected shape. */
function buildSingleRequirement(
  asset: PaymentPathConfig["accepts"][number],
  config: PaymentPathConfig,
): Record<string, unknown> {
  return {
    scheme: "exact",
    network: asset.network,
    maxAmountRequired: parsePriceToAtomic(config.price, asset.decimals ?? 6),
    asset: asset.asset,
    payTo: asset.payTo ?? config.payTo,
    facilitatorUrl: asset.facilitatorUrl,
    maxTimeoutSeconds: 300,
    ...(asset.facilitatorAddress ? { facilitator: asset.facilitatorAddress } : {}),
    ...(asset.extra ? { extra: asset.extra } : {}),
  };
}

/** CAIP-2 conversion table for matching client payment network to config. */
const NETWORK_TO_CAIP2: Record<string, string> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
  radius: "eip155:723487",
  "radius-testnet": "eip155:72344",
  solana: "solana:mainnet-beta",
  "solana-devnet": "solana:devnet",
};

function findMatchingAsset(
  config: PaymentPathConfig,
  paymentNetwork: string,
): PaymentPathConfig["accepts"][number] | undefined {
  const direct = config.accepts.find((a) => a.network === paymentNetwork);
  if (direct) return direct;
  return config.accepts.find((a) => NETWORK_TO_CAIP2[a.network] === paymentNetwork);
}

function validateFields(
  body: Record<string, unknown>,
  fields?: PaymentPathConfig["fields"],
): string[] {
  if (!fields) return [];
  const errors: string[] = [];
  for (const field of fields) {
    const value = body[field.name];

    if (field.required && (value === undefined || value === null || value === "")) {
      errors.push(`${field.name} is required`);
      continue;
    }

    if (value === undefined || value === null) continue;

    if (typeof value !== "string") {
      errors.push(`${field.name} must be a string`);
      continue;
    }

    if (field.maxLength && value.length > field.maxLength) {
      errors.push(`${field.name} exceeds max length of ${field.maxLength}`);
    }

    if (field.type === "email" && !EMAIL_RE.test(value)) {
      errors.push(`${field.name} is not a valid email address`);
    }

    if (field.type === "url") {
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          errors.push(`${field.name} must use http or https`);
        }
      } catch {
        errors.push(`${field.name} is not a valid URL`);
      }
    }
  }
  return errors;
}

/** Recursively strip prototype-pollution keys from a parsed JSON object. */
function stripDangerousKeys(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) {
      delete obj[key];
    } else if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
      stripDangerousKeys(obj[key] as Record<string, unknown>);
    }
  }
}

/**
 * Read request body with a hard byte limit. Reads the stream incrementally
 * and throws if the body exceeds maxBytes — never buffers the full oversized
 * payload in memory.
 */
async function readLimitedBody(request: Request, maxBytes: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "{}";

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      reader.cancel();
      throw new Error("Body too large");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** SHA-256 hash of the payment signature header for deduplication. */
async function hashPaymentSignature(header: string): Promise<string> {
  const data = new TextEncoder().encode(header);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Convert "$1.00" to atomic units for the given decimal precision. */
function parsePriceToAtomic(price: string, decimals: number = 6): string {
  const cleaned = price.replace(/[^0-9.]/g, "");
  const [whole = "0", frac = ""] = cleaned.split(".");
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  const raw = `${whole}${padded}`.replace(/^0+/, "");
  return raw || "0";
}

function jsonResponse(
  data: unknown,
  status: number,
  corsOrigin?: string,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  };

  if (corsOrigin) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT";
    headers["Access-Control-Expose-Headers"] = "PAYMENT-REQUIRED, PAYMENT-RESPONSE";
  }

  return new Response(JSON.stringify(data, null, 2), { status, headers });
}

function corsResponse(status: number, origin: string): Response {
  return new Response(null, {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT",
      "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
    },
  });
}

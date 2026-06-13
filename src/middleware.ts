import type {
  PaymentPathConfig,
  FulfillmentPayload,
  PaymentReceipt,
} from "./types.js";
import { FacilitatorClient } from "./facilitator.js";

/**
 * Gate a request behind x402 stablecoin payment.
 *
 * - No PAYMENT-SIGNATURE header → 402 with payment requirements + field schema
 * - Valid PAYMENT-SIGNATURE → verify, fulfill, settle, return receipt
 * - Invalid payment → 400
 */
export async function paymentPath(
  request: Request,
  config: PaymentPathConfig,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return corsResponse(204);
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
    );
  }

  const contentLength = parseInt(request.headers.get("Content-Length") ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse(
      { error: `Request body too large (max ${MAX_BODY_BYTES} bytes)` },
      413,
    );
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    rawBody = "{}";
  }

  if (rawBody.length > MAX_BODY_BYTES) {
    return jsonResponse(
      { error: `Request body too large (max ${MAX_BODY_BYTES} bytes)` },
      413,
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const fieldErrors = validateFields(body, config.fields);
  if (fieldErrors.length > 0) {
    return jsonResponse({ error: "Validation failed", fields: fieldErrors }, 422);
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
  } catch (err) {
    return jsonResponse(
      { error: "Payment verification failed", detail: String(err) },
      502,
    );
  }

  const isPaymentValid = verifyResult.isValid ?? verifyResult.valid ?? false;
  if (!isPaymentValid) {
    return jsonResponse(
      { error: "Payment invalid", reason: verifyResult.invalidReason ?? "unknown" },
      402,
    );
  }

  let settleResult;
  try {
    settleResult = await facilitator.settle(paymentPayload, requirement);
  } catch (err) {
    return jsonResponse(
      { error: "Settlement failed", detail: String(err) },
      502,
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
    return jsonResponse(
      { error: "Fulfillment failed after settlement", detail: String(err), receipt },
      500,
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

  return jsonResponse(responseBody, 200, {
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

  return jsonResponse(body, 402, {
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

/** Default max request body size: 64 KB. */
const MAX_BODY_BYTES = 65_536;

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

    if (value !== undefined && value !== null && typeof value === "string") {
      if (field.maxLength && value.length > field.maxLength) {
        errors.push(`${field.name} exceeds max length of ${field.maxLength}`);
      }
    }
  }
  return errors;
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
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT",
      "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
      ...extraHeaders,
    },
  });
}

function corsResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT",
      "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
    },
  });
}

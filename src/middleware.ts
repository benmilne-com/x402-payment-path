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

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const fieldErrors = validateFields(body, config.fields);
  if (fieldErrors.length > 0) {
    return jsonResponse({ error: "Validation failed", fields: fieldErrors }, 422);
  }

  const paymentRequirements = buildPaymentRequirements(config);

  const facilitatorUrl = detectFacilitator(paymentPayload, config);
  const facilitator = new FacilitatorClient(facilitatorUrl);

  let verifyResult;
  try {
    verifyResult = await facilitator.verify(paymentPayload, paymentRequirements);
  } catch (err) {
    return jsonResponse(
      { error: "Payment verification failed", detail: String(err) },
      502,
    );
  }

  if (!verifyResult.valid) {
    return jsonResponse(
      { error: "Payment invalid", reason: verifyResult.invalidReason ?? "unknown" },
      402,
    );
  }

  const fulfillmentPayload: FulfillmentPayload = {
    body,
    headers: Object.fromEntries(request.headers.entries()),
    ip: request.headers.get("CF-Connecting-IP")
      ?? request.headers.get("X-Forwarded-For")
      ?? undefined,
    timestamp: new Date().toISOString(),
  };

  const network = (paymentPayload.network as string) ?? "";
  const pendingReceipt: PaymentReceipt = {
    txHash: "",
    network,
    asset: "",
    amount: "",
    from: verifyResult.payer ?? "",
    to: config.payTo,
  };

  let fulfillResult: unknown;
  try {
    fulfillResult = await config.onFulfill(fulfillmentPayload, pendingReceipt);
  } catch (err) {
    return jsonResponse(
      { error: "Fulfillment rejected", detail: String(err) },
      500,
    );
  }

  let settleResult;
  try {
    settleResult = await facilitator.settle(paymentPayload, paymentRequirements);
  } catch (err) {
    return jsonResponse(
      {
        error: "Settlement failed after fulfillment",
        detail: String(err),
        fulfillment: fulfillResult,
      },
      502,
    );
  }

  const receipt: PaymentReceipt = {
    txHash: settleResult.txHash ?? "",
    network: settleResult.network ?? network,
    asset: pendingReceipt.asset,
    amount: pendingReceipt.amount,
    from: pendingReceipt.from,
    to: config.payTo,
  };

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
    accepts: config.accepts.map((a) => ({
      scheme: "exact",
      network: a.network,
      maxAmountRequired: parsePriceToAtomic(config.price),
      asset: a.asset,
      payTo: a.payTo ?? config.payTo,
      facilitatorUrl: a.facilitatorUrl,
    })),
  };
}

function detectFacilitator(
  payload: Record<string, unknown>,
  config: PaymentPathConfig,
): string {
  const network = payload.network as string | undefined;
  const match = config.accepts.find((a) => a.network === network);
  if (match) return match.facilitatorUrl;
  return config.accepts[0]?.facilitatorUrl ?? "https://x402.stablecoin.xyz";
}

function validateFields(
  body: Record<string, unknown>,
  fields?: PaymentPathConfig["fields"],
): string[] {
  if (!fields) return [];
  const errors: string[] = [];
  for (const field of fields) {
    if (!field.required) continue;
    const value = body[field.name];
    if (value === undefined || value === null || value === "") {
      errors.push(`${field.name} is required`);
    }
  }
  return errors;
}

/** Convert "$1.00" → "1000000" (USDC 6 decimals). */
function parsePriceToAtomic(price: string): string {
  const cleaned = price.replace(/[^0-9.]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return "0";
  return Math.round(num * 1_000_000).toString();
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

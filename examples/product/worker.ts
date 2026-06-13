/**
 * Example: Agent product purchase on Cloudflare Workers.
 *
 * An agent pays $5 in USDC to receive a time-limited download URL.
 *
 * Deploy with: npx wrangler deploy
 */
import { paymentPath, type PaymentPathConfig } from "x402-payment-path";
import { SignJWT } from "jose";

interface Env {
  DOWNLOAD_SECRET: string;
  R2_BUCKET: R2Bucket;
}

const config: PaymentPathConfig = {
  price: "$5.00",
  payTo: "0xYourWalletAddress",
  accepts: [
    {
      asset: "USDC",
      network: "eip155:8453",
      facilitatorUrl: "https://x402.stablecoin.xyz",
    },
  ],
  onFulfill: async () => {
    throw new Error("onFulfill must be bound to env at runtime");
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/buy" && request.method === "POST") {
      return paymentPath(request, {
        ...config,
        onFulfill: async (_payload, receipt) => {
          const secret = new TextEncoder().encode(env.DOWNLOAD_SECRET);
          const token = await new SignJWT({ file: "the-value-layer.pdf" })
            .setProtectedHeader({ alg: "HS256" })
            .setExpirationTime("1h")
            .sign(secret);

          return {
            downloadUrl: `${url.origin}/download?token=${token}`,
            expiresIn: 3600,
            txHash: receipt.txHash,
          };
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

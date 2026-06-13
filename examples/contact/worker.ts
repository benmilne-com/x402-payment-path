/**
 * Example: Agent contact endpoint on Cloudflare Workers.
 *
 * An agent pays $1 in USDC or SBC to send a message.
 * The message is delivered via Cloudflare Email Service.
 *
 * Deploy with: npx wrangler deploy
 */
import { paymentPath, type PaymentPathConfig } from "x402-payment-path";

interface Env {
  EMAIL: {
    send(message: {
      to: string;
      from: string;
      subject: string;
      text: string;
    }): Promise<void>;
  };
}

const config: PaymentPathConfig = {
  price: "$1.00",
  payTo: "0xYourWalletAddress",
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
    {
      name: "sender",
      type: "string",
      required: true,
      description: "Agent or service identifier",
    },
    {
      name: "body",
      type: "string",
      required: true,
      description: "Message content",
    },
    {
      name: "reply_to",
      type: "email",
      required: false,
      description: "Email address for replies",
    },
    {
      name: "callback",
      type: "url",
      required: false,
      description: "Webhook endpoint for responses",
    },
  ],
  onFulfill: async () => {
    throw new Error("onFulfill must be bound to env at runtime");
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/contact" && request.method === "POST") {
      return paymentPath(request, {
        ...config,
        onFulfill: async (payload, receipt) => {
          const { sender, body } = payload.body as Record<string, string>;

          await env.EMAIL.send({
            to: "you@yourdomain.com",
            from: "contact@yourdomain.com",
            subject: `x402 message from ${sender}`,
            text: [
              body,
              "",
              `Sender: ${sender}`,
              `Wallet: ${receipt.from}`,
              `Tx: ${receipt.txHash}`,
              `Network: ${receipt.network}`,
              `Time: ${payload.timestamp}`,
            ].join("\n"),
          });

          return { status: "delivered", txHash: receipt.txHash };
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

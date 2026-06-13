#!/usr/bin/env node

/**
 * End-to-end test: send a paid x402 message to benmilne.com/contact/send
 *
 * Usage:
 *   node test/e2e-contact.mjs usdc    # USDC on Base
 *   node test/e2e-contact.mjs sbc     # SBC on Base
 *   node test/e2e-contact.mjs solana  # SBC on Solana
 *
 * Requires funded wallets — see test/.env.test
 */

import { config } from "dotenv";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createX402Client, viemSignerAdapter } from "@stablecoin.xyz/x402/evm";
import { createSolanaX402Client, rawKeypairSigner } from "@stablecoin.xyz/x402/solana";
import { Keypair } from "@solana/web3.js";

config({ path: new URL(".env.test", import.meta.url).pathname });

const TARGET = "https://benmilne.com/contact/send";

const mode = process.argv[2] || "usdc";

async function testEvm(asset) {
  const key = process.env.EVM_PRIVATE_KEY;
  if (!key) throw new Error("EVM_PRIVATE_KEY not set in test/.env.test");

  const account = privateKeyToAccount(key);
  console.log(`\nWallet: ${account.address}`);
  console.log(`Asset:  ${asset} on Base`);
  console.log(`Target: ${TARGET}\n`);

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  const client = createX402Client({
    signer: viemSignerAdapter(walletClient),
    skipBalanceCheck: true,
  });

  console.log("Sending paid message...\n");

  const res = await client.fetch(TARGET, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: `e2e-test-agent (${asset})`,
      body: `End-to-end test: ${asset} on Base. Timestamp: ${new Date().toISOString()}`,
    }),
    preferredNetwork: "base",
  });

  console.log(`HTTP ${res.status}`);
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));

  if (res.status === 200 && body.receipt?.txHash) {
    console.log(`\nSettlement tx: https://basescan.org/tx/${body.receipt.txHash}`);
  }

  return res.status;
}

async function testSolana() {
  const keyStr = process.env.SOL_PRIVATE_KEY;
  if (!keyStr) throw new Error("SOL_PRIVATE_KEY not set in test/.env.test");

  const bs58Decode = (str) => {
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let result = 0n;
    for (const c of str) {
      result = result * 58n + BigInt(ALPHABET.indexOf(c));
    }
    const bytes = [];
    while (result > 0n) {
      bytes.unshift(Number(result & 0xffn));
      result >>= 8n;
    }
    for (const c of str) {
      if (c === "1") bytes.unshift(0);
      else break;
    }
    return new Uint8Array(bytes);
  };

  const secretKey = bs58Decode(keyStr);
  const keypair = Keypair.fromSecretKey(secretKey);

  console.log(`\nWallet: ${keypair.publicKey.toBase58()}`);
  console.log(`Asset:  SBC on Solana`);
  console.log(`Target: ${TARGET}\n`);

  const client = createSolanaX402Client({
    signer: rawKeypairSigner(secretKey),
  });

  console.log("Sending paid message...\n");

  const res = await client.fetch(TARGET, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: "e2e-test-agent (SBC/Solana)",
      body: `End-to-end test: SBC on Solana. Timestamp: ${new Date().toISOString()}`,
    }),
  });

  console.log(`HTTP ${res.status}`);
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));

  if (res.status === 200 && body.receipt?.txHash) {
    console.log(`\nSettlement tx: https://solscan.io/tx/${body.receipt.txHash}`);
  }

  return res.status;
}

console.log("=".repeat(60));
console.log(`x402 E2E Test — ${mode.toUpperCase()}`);
console.log("=".repeat(60));

try {
  let status;
  if (mode === "usdc") {
    status = await testEvm("USDC");
  } else if (mode === "sbc") {
    status = await testEvm("SBC");
  } else if (mode === "solana") {
    status = await testSolana();
  } else {
    console.error(`Unknown mode: ${mode}. Use: usdc, sbc, or solana`);
    process.exit(1);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Result: ${status === 200 ? "SUCCESS" : `FAILED (HTTP ${status})`}`);
  console.log("=".repeat(60));

  process.exit(status === 200 ? 0 : 1);
} catch (err) {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
}

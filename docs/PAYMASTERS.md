# Paymasters (Gasless Transactions)

This document describes how to add gasless UX to x402 payment paths. **Not implemented in v1** — documented for reference and future integration.

## What Is a Paymaster?

A paymaster is an ERC-4337 Account Abstraction component that pays gas fees on behalf of the sender. Without a paymaster, the agent's wallet needs the chain's native gas token (ETH on Base, SOL on Solana) in addition to the stablecoin.

With a paymaster, the agent only needs the stablecoin. The paymaster covers gas, either by charging a fee in the stablecoin or sponsoring it entirely.

## Available Paymasters

### USDC on Base: Coinbase CDP Paymaster

Coinbase Developer Platform operates a paymaster that accepts gas payment in USDC.

- **Contract:** `0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c` (Base mainnet)
- **Mode:** ERC-20 gas payment (agent pays gas in USDC, paymaster converts to ETH)
- **Requires:** CDP API key from [cdp.coinbase.com](https://cdp.coinbase.com)
- **Requires:** Agent wallet must be an ERC-4337 smart account (not a standard EOA)

### SBC on Base: Stablecoin Inc. Paymaster

Stablecoin Inc. operates a paymaster for SBC transactions.

- **Dashboard:** [dashboard.stablecoin.xyz](https://dashboard.stablecoin.xyz)
- **Requires:** API key from the dashboard
- **Requires:** Agent wallet must be an ERC-4337 smart account

## How Paymasters Interact with x402

The paymaster operates at the **agent's end**, not the server's end. Your `paymentPath()` configuration doesn't change — the agent's wallet software decides whether to use a paymaster when constructing the payment signature.

```
Agent wallet (with paymaster) → signs permit → POST to your server → facilitator settles
Agent wallet (without paymaster) → signs permit → POST to your server → facilitator settles
```

From the server's perspective, both flows look identical. The `PAYMENT-SIGNATURE` header contains the same ERC-2612 permit regardless of how the agent paid gas.

## When to Care About Paymasters

You, as the server operator, don't need to configure anything for paymasters. However, you might want to:

1. **Document that your endpoint supports gasless agents** — mention in your API docs that the x402 flow is paymaster-compatible
2. **Recommend a paymaster** — if your primary audience uses a specific stablecoin, point them to the relevant paymaster
3. **Test with gasless agents** — ensure your endpoint works when the payer is a smart account (contract address) rather than an EOA

## Future Integration

A future version of this SDK may include utilities for:

- Detecting whether a payer is an EOA or smart account
- Recommending paymasters in the 402 response body
- Sponsored gas (server-side paymaster funding)

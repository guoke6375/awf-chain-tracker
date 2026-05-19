# AWF Chain Tracker

A small self-hosted tracker for Animal Welfare Fund on Ethereum.

It monitors ETH sent from the AWF token contract to the welfare wallet:

- Token: `0x12a77658112Cf42914cB614D13653ed5852DA1e5`
- Wallet: `0xbAd06a3CA84E4E2b489974d8918B5f7387e6dB8E`
- Start block: `25076000`

## Run locally

```powershell
$env:ETHERSCAN_API_KEY="YOUR_KEY"
node server.js
```

Or on Windows:

```powershell
.\run-local.ps1 -EtherscanApiKey "YOUR_KEY"
```

Then open:

```text
http://localhost:4173
```

## Data sources

Recommended:

```powershell
$env:ETHERSCAN_API_KEY="YOUR_KEY"
```

Alternative, if you have a trace-capable Ethereum RPC:

```powershell
$env:RPC_TRACE_URL="https://your-trace-rpc.example"
```

Do not put private API keys in `public/app.js`. Keep them on the server.

## Useful environment variables

- `PORT`: local port, default `4173`
- `ETHERSCAN_API_KEY`: Etherscan V2 key
- `RPC_TRACE_URL`: trace-capable RPC endpoint
- `AWF_TOKEN`: override token contract
- `AWF_DONATION_WALLET`: override donation wallet
- `AWF_START_BLOCK`: override first scan block
- `CACHE_TTL_MS`: cache freshness, default 5 minutes
- `TRACE_CHUNK`: trace scan chunk size, default 2000 blocks

## Deploy on Render

1. Push this folder to a GitHub repository.
2. In Render, create a new Web Service from that repository.
3. Use:
   - Build command: `npm install`
   - Start command: `node server.js`
   - Health check path: `/healthz`
4. Add an environment variable:
   - `ETHERSCAN_API_KEY`: your Etherscan API key
5. Deploy. Render will provide an `onrender.com` URL.

You can add a custom domain later in the Render service settings.

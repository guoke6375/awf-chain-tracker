import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const DATA_DIR = join(__dirname, "data");
const CACHE_FILE = join(DATA_DIR, "awf-cache.json");

const PORT = Number(process.env.PORT || 4173);
const TOKEN = (process.env.AWF_TOKEN || "0x12a77658112Cf42914cB614D13653ed5852DA1e5").toLowerCase();
const DONATION = (process.env.AWF_DONATION_WALLET || "0xbAd06a3CA84E4E2b489974d8918B5f7387e6dB8E").toLowerCase();
const DEPLOY_BLOCK = Number(process.env.AWF_START_BLOCK || 25076000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const RPC_TRACE_URL = process.env.RPC_TRACE_URL || "";
const TRACE_CHUNK = Number(process.env.TRACE_CHUNK || 2000);
const VITALIK_TX = "0x7ba349c2a0b93977e40ba05cb60798ea18ed218f1022ce121881a371a0393bc3";
const CACHE_VERSION = 3;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const execFileAsync = promisify(execFile);
let refreshPromise = null;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(text);
}

function weiToEthString(value) {
  const wei = BigInt(value || "0");
  const whole = wei / 1000000000000000000n;
  const frac = wei % 1000000000000000000n;
  const fs = frac.toString().padStart(18, "0").replace(/0+$/, "");
  return fs ? `${whole}.${fs}` : whole.toString();
}

function addWei(a, b) {
  return (BigInt(a || "0") + BigInt(b || "0")).toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          accept: "application/json",
          "user-agent": "awf-chain-tracker/1.0",
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      await sleep(400 * (attempt + 1));
    }
  }

  if (process.platform === "win32" && typeof url === "string" && !options.method) {
    const encodedUrl = Buffer.from(url, "utf8").toString("base64");
    const command = [
      "$ProgressPreference='SilentlyContinue';",
      `$u = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUrl}'));`,
      "$uri = [uri]::new($u);",
      "Invoke-RestMethod -Uri $uri -UseBasicParsing | ConvertTo-Json -Depth 100 -Compress"
    ].join(" ");
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", command], {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024
    });
    return JSON.parse(stdout);
  }

  throw lastError;
}

async function readCache() {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function saveCache(cache) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function etherscanRows(action, startBlock = DEPLOY_BLOCK) {
  if (!ETHERSCAN_API_KEY) {
    throw new Error("Missing ETHERSCAN_API_KEY. Add it to the environment or configure RPC_TRACE_URL.");
  }

  const allRows = [];
  const offset = 1000;

  for (let page = 1; ; page += 1) {
    const url = new URL("https://api.etherscan.io/v2/api");
    url.searchParams.set("chainid", "1");
    url.searchParams.set("module", "account");
    url.searchParams.set("action", action);
    url.searchParams.set("address", DONATION);
    url.searchParams.set("startblock", String(startBlock));
    url.searchParams.set("endblock", "99999999");
    url.searchParams.set("page", String(page));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sort", "asc");
    url.searchParams.set("apikey", ETHERSCAN_API_KEY);

    const payload = await fetchJson(url.toString());
    if (payload.status === "0" && !Array.isArray(payload.result)) {
      throw new Error(payload.result || payload.message || "Etherscan request failed");
    }

    const pageRows = payload.result || [];
    allRows.push(...pageRows);
    if (pageRows.length < offset) break;
  }

  return allRows;
}

async function etherscanTransfers() {
  const [internalRows, normalRows] = await Promise.all([
    etherscanRows("txlistinternal", DEPLOY_BLOCK),
    etherscanRows("txlist", 0)
  ]);

  const normalize = (tx, kind) => ({
    hash: tx.hash,
    blockNumber: Number(tx.blockNumber),
    timeStamp: Number(tx.timeStamp || 0),
    valueWei: String(tx.value),
    from: (tx.from || "").toLowerCase(),
    to: (tx.to || "").toLowerCase(),
    isError: tx.isError,
    kind,
    source: "etherscan"
  });

  const rows = [...internalRows.map((tx) => normalize(tx, "internal")), ...normalRows.map((tx) => normalize(tx, "normal"))]
    .filter((tx) => tx.valueWei && tx.valueWei !== "0" && tx.hash && tx.from)
    .map((tx) => ({
      ...tx,
      direction: tx.isError === "1" && tx.to === DONATION
        ? "failed-in"
        : tx.to === DONATION
          ? "in"
          : tx.from === DONATION
            ? "out"
            : "other",
      category: tx.from === TOKEN ? "awf-direct" : tx.hash.toLowerCase() === VITALIK_TX ? "vitalik" : "other-wallet-inflow"
    }));

  return rows.filter((tx) =>
    tx.direction === "in" ||
    tx.direction === "out" ||
    tx.direction === "failed-in"
  );
}

function inflowRows(transfers) {
  return transfers.filter((tx) =>
      tx.to === DONATION &&
      tx.valueWei &&
      tx.valueWei !== "0" &&
      tx.isError !== "1" &&
      tx.hash &&
      tx.from
  );
}

async function rpc(method, params) {
  const response = await fetch(RPC_TRACE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "RPC request failed");
  return payload.result;
}

async function traceTransfers() {
  if (!RPC_TRACE_URL) {
    throw new Error("Missing RPC_TRACE_URL. Use a trace-capable Ethereum RPC endpoint.");
  }

  const latestHex = await rpc("eth_blockNumber", []);
  const latest = Number.parseInt(latestHex, 16);
  const rows = [];

  for (let from = DEPLOY_BLOCK; from < latest; from += TRACE_CHUNK) {
    const to = Math.min(from + TRACE_CHUNK - 1, latest - 1);
    const traces = await rpc("trace_filter", [{
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
      fromAddress: [TOKEN],
      toAddress: [DONATION]
    }]);

    for (const trace of traces || []) {
      const action = trace.action || {};
      if (
        trace.type === "call" &&
        !trace.error &&
        (action.from || "").toLowerCase() === TOKEN &&
        (action.to || "").toLowerCase() === DONATION &&
        action.value &&
        action.value !== "0x" &&
        action.value !== "0x0"
      ) {
        rows.push({
          hash: trace.transactionHash,
          blockNumber: Number(trace.blockNumber),
          timeStamp: 0,
          valueWei: BigInt(action.value).toString(),
          source: "trace"
        });
      }
    }
  }

  return rows;
}

function summarize(transfers, status = "ok", warning = "") {
  const inflows = inflowRows(transfers);
  const outflows = transfers.filter((row) => row.direction === "out");
  const failedInflows = transfers.filter((row) => row.direction === "failed-in");
  const sorted = [...inflows].sort((a, b) => b.blockNumber - a.blockNumber);
  const totalWei = inflows.reduce((sum, row) => addWei(sum, row.valueWei), "0");
  const withdrawnWei = outflows.reduce((sum, row) => addWei(sum, row.valueWei), "0");
  const failedInflowsWei = failedInflows.reduce((sum, row) => addWei(sum, row.valueWei), "0");
  const balanceWei = (BigInt(totalWei) - BigInt(withdrawnWei)).toString();
  const direct = inflows.filter((row) => row.category === "awf-direct");
  const vitalik = inflows.filter((row) => row.category === "vitalik");
  const other = inflows.filter((row) => row.category === "other-wallet-inflow");
  const directWei = direct.reduce((sum, row) => addWei(sum, row.valueWei), "0");
  const vitalikWei = vitalik.reduce((sum, row) => addWei(sum, row.valueWei), "0");
  const otherWei = other.reduce((sum, row) => addWei(sum, row.valueWei), "0");
  const tradingRaisedWei = addWei(directWei, otherWei);
  return {
    status,
    cacheVersion: CACHE_VERSION,
    warning,
    token: TOKEN,
    donationWallet: DONATION,
    startBlock: DEPLOY_BLOCK,
    updatedAt: new Date().toISOString(),
    count: sorted.length,
    totalWei,
    totalEth: weiToEthString(totalWei),
    metrics: {
      headline: "All ETH received by the welfare wallet",
      awfDirectCount: direct.length,
      awfDirectWei: directWei,
      awfDirectEth: weiToEthString(directWei),
      vitalikCount: vitalik.length,
      vitalikWei,
      vitalikEth: weiToEthString(vitalikWei),
      otherInflowCount: other.length,
      otherInflowWei: otherWei,
      otherInflowEth: weiToEthString(otherWei),
      tradingRaisedWei,
      tradingRaisedEth: weiToEthString(tradingRaisedWei),
      withdrawnCount: outflows.length,
      withdrawnWei,
      withdrawnEth: weiToEthString(withdrawnWei),
      balanceWei,
      balanceEth: weiToEthString(balanceWei),
      excludedFailedInflowCount: failedInflows.length,
      excludedFailedInflowWei: failedInflowsWei,
      excludedFailedInflowEth: weiToEthString(failedInflowsWei)
    },
    transfers: sorted.slice(0, 100).map((row) => ({
      ...row,
      valueEth: weiToEthString(row.valueWei)
    }))
  };
}

async function refreshData() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const oldCache = await readCache();
    try {
      const transfers = ETHERSCAN_API_KEY ? await etherscanTransfers() : await traceTransfers();
      const next = summarize(transfers);
      await saveCache(next);
      return next;
    } catch (error) {
      if (oldCache) {
        return {
          ...oldCache,
          status: "stale",
          warning: error.message || String(error)
        };
      }
      throw error;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/healthz") {
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname !== "/api/summary") {
    json(res, 404, { error: "Not found" });
    return;
  }

  const force = url.searchParams.get("refresh") === "1";
  const cached = await readCache();
  const freshEnough = cached &&
    cached.cacheVersion === CACHE_VERSION &&
    Date.now() - Date.parse(cached.updatedAt || 0) < CACHE_TTL_MS;

  try {
    const data = freshEnough && !force ? cached : await refreshData();
    json(res, 200, data);
  } catch (error) {
    json(res, 500, {
      status: "error",
      error: error.message || String(error),
      token: TOKEN,
      donationWallet: DONATION,
      startBlock: DEPLOY_BLOCK
    });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalized = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, normalized);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] || "application/octet-stream",
      "cache-control": "public, max-age=60"
    });
    res.end(content);
  } catch {
    const fallback = await readFile(join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(fallback);
  }
}

createServer((req, res) => {
  if (req.url?.startsWith("/api/") || req.url?.startsWith("/healthz")) {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`AWF tracker running at http://localhost:${PORT}`);
  if (!ETHERSCAN_API_KEY && !RPC_TRACE_URL) {
    console.log("Set ETHERSCAN_API_KEY or RPC_TRACE_URL to load live chain data.");
  }
});

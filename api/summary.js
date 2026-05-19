const TOKEN = "0x12a77658112cf42914cb614d13653ed5852da1e5";
const DONATION = "0xbad06a3ca84e4e2b489974d8918b5f7387e6db8e";
const DEPLOY_BLOCK = 25076000;
const VITALIK_TX = "0x7ba349c2a0b93977e40ba05cb60798ea18ed218f1022ce121881a371a0393bc3";
const CACHE_TTL_MS = 5 * 60 * 1000;

let memoryCache = null;

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

async function etherscanRows(action, startBlock, apiKey) {
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
    url.searchParams.set("apikey", apiKey);

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "awf-chain-tracker/1.0"
      }
    });
    const payload = await response.json();
    if (payload.status === "0" && !Array.isArray(payload.result)) {
      throw new Error(payload.result || payload.message || "Etherscan request failed");
    }

    const pageRows = payload.result || [];
    allRows.push(...pageRows);
    if (pageRows.length < offset) break;
  }

  return allRows;
}

function normalize(tx, kind) {
  const from = (tx.from || "").toLowerCase();
  const to = (tx.to || "").toLowerCase();
  return {
    hash: tx.hash,
    blockNumber: Number(tx.blockNumber),
    timeStamp: Number(tx.timeStamp || 0),
    valueWei: String(tx.value),
    from,
    to,
    isError: tx.isError,
    kind,
    source: "etherscan",
    direction: tx.isError === "1" && to === DONATION
      ? "failed-in"
      : to === DONATION
        ? "in"
        : from === DONATION
          ? "out"
          : "other",
    category: from === TOKEN ? "awf-direct" : (tx.hash || "").toLowerCase() === VITALIK_TX ? "vitalik" : "other-wallet-inflow"
  };
}

function summarize(rows) {
  const relevant = rows
    .filter((tx) => tx.valueWei && tx.valueWei !== "0" && tx.hash && tx.from)
    .filter((tx) => tx.direction === "in" || tx.direction === "out" || tx.direction === "failed-in");

  const inflows = relevant.filter((row) => row.direction === "in" && row.isError !== "1");
  const outflows = relevant.filter((row) => row.direction === "out" && row.isError !== "1");
  const failedInflows = relevant.filter((row) => row.direction === "failed-in");
  const sorted = [...inflows].sort((a, b) => b.blockNumber - a.blockNumber);

  const totalWei = inflows.reduce((sum, row) => addWei(sum, row.valueWei), "0");
  const withdrawnWei = outflows.reduce((sum, row) => addWei(sum, row.valueWei), "0");
  const balanceWei = (BigInt(totalWei) - BigInt(withdrawnWei)).toString();
  const direct = inflows.filter((row) => row.category === "awf-direct");
  const vitalik = inflows.filter((row) => row.category === "vitalik");
  const other = inflows.filter((row) => row.category === "other-wallet-inflow");
  const directWei = direct.reduce((sum, row) => addWei(sum, row.valueWei), "0");
  const vitalikWei = vitalik.reduce((sum, row) => addWei(sum, row.valueWei), "0");
  const otherWei = other.reduce((sum, row) => addWei(sum, row.valueWei), "0");
  const tradingRaisedWei = addWei(directWei, otherWei);
  const failedInflowsWei = failedInflows.reduce((sum, row) => addWei(sum, row.valueWei), "0");

  return {
    status: "ok",
    warning: "",
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
    transfers: sorted.slice(0, 2500).map((row) => ({
      ...row,
      valueEth: weiToEthString(row.valueWei)
    }))
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      status: "error",
      error: "Missing ETHERSCAN_API_KEY",
      token: TOKEN,
      donationWallet: DONATION,
      startBlock: DEPLOY_BLOCK
    });
    return;
  }

  if (memoryCache && Date.now() - memoryCache.loadedAt < CACHE_TTL_MS && req.query.refresh !== "1") {
    res.status(200).json(memoryCache.data);
    return;
  }

  try {
    const [internalRows, normalRows] = await Promise.all([
      etherscanRows("txlistinternal", DEPLOY_BLOCK, apiKey),
      etherscanRows("txlist", 0, apiKey)
    ]);
    const rows = [
      ...internalRows.map((tx) => normalize(tx, "internal")),
      ...normalRows.map((tx) => normalize(tx, "normal"))
    ];
    const data = summarize(rows);
    memoryCache = { loadedAt: Date.now(), data };
    res.status(200).json(data);
  } catch (error) {
    if (memoryCache) {
      res.status(200).json({
        ...memoryCache.data,
        status: "stale",
        warning: error.message || String(error)
      });
      return;
    }

    res.status(500).json({
      status: "error",
      error: error.message || String(error),
      token: TOKEN,
      donationWallet: DONATION,
      startBlock: DEPLOY_BLOCK
    });
  }
}

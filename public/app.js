const $ = (id) => document.getElementById(id);

const ADDRESSES = {
  wallet: "0xbAd06a3CA84E4E2b489974d8918B5f7387e6dB8E",
  token: "0x12a77658112Cf42914cB614D13653ed5852DA1e5"
};

const LINKS = {
  wallet: `https://etherscan.io/address/${ADDRESSES.wallet}`,
  token: `https://etherscan.io/token/${ADDRESSES.token}`,
  telegram: "https://t.me/AWFzhongwen"
};

const fmtEth = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return value || "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
};

const shortHash = (hash) => {
  if (!hash || hash.length < 18) return hash || "--";
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
};

const fmtDate = (isoOrSeconds) => {
  if (!isoOrSeconds) return "--";
  const date = typeof isoOrSeconds === "number"
    ? new Date(isoOrSeconds * 1000)
    : new Date(isoOrSeconds);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString();
};

function renderRows(transfers) {
  const tbody = $("rows");
  if (!transfers.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">No matching transfers found yet.</td></tr>';
    return;
  }

  tbody.innerHTML = transfers.map((tx) => {
    const time = tx.timeStamp ? fmtDate(tx.timeStamp) : `Block ${tx.blockNumber}`;
    return `
      <tr>
        <td>${time}</td>
        <td>${tx.blockNumber}</td>
        <td class="amount-cell">${fmtEth(tx.valueEth)} ETH</td>
        <td><a href="https://etherscan.io/tx/${tx.hash}" target="_blank" rel="noreferrer">${shortHash(tx.hash)}</a></td>
      </tr>
    `;
  }).join("");
}

async function loadSummary(force = false) {
  $("refresh").disabled = true;
  $("status-line").textContent = force ? "Refreshing chain data..." : "Loading chain data...";
  $("status-line").classList.remove("is-warning");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), force ? 90000 : 20000);
    const response = await fetch(`/api/summary${force ? "?refresh=1" : ""}`, {
      cache: "no-store",
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await response.json();
    if (!response.ok) {
      $("token-address").textContent = data.token || "--";
      $("wallet-address").textContent = data.donationWallet || "--";
      throw new Error(data.error || "Could not load tracker data");
    }

    $("total-eth").textContent = fmtEth(data.totalEth);
    $("transfer-count").textContent = data.count.toLocaleString();
    $("updated-at").textContent = fmtDate(data.updatedAt);
    $("source").textContent = data.transfers[0]?.source || "chain";
    $("trading-raised").textContent = fmtEth(data.metrics?.tradingRaisedEth);
    $("vitalik-eth").textContent = fmtEth(data.metrics?.vitalikEth);
    $("withdrawn-eth").textContent = fmtEth(data.metrics?.withdrawnEth);
    $("balance-eth").textContent = fmtEth(data.metrics?.balanceEth);
    $("balance-card-eth").textContent = fmtEth(data.metrics?.balanceEth);
    $("audit-note").textContent = `Counting only successful on-chain ETH transfers. Excluded ${data.metrics?.excludedFailedInflowCount || 0} failed/reverted traces totaling ${fmtEth(data.metrics?.excludedFailedInflowEth)} ETH.`;
    $("token-address").textContent = data.token;
    $("wallet-address").textContent = data.donationWallet;

    if (data.status === "stale") {
      $("status-line").textContent = `Showing cached data. Live refresh failed: ${data.warning}`;
      $("status-line").classList.add("is-warning");
    } else {
      $("status-line").textContent = "Live data loaded from Ethereum.";
    }

    renderRows(data.transfers || []);
  } catch (error) {
    $("status-line").textContent = error.name === "AbortError"
      ? "Chain data is taking longer than usual. Try Refresh in a moment."
      : error.message;
    $("status-line").classList.add("is-warning");
    $("rows").innerHTML = '<tr><td colspan="4" class="empty">Configure ETHERSCAN_API_KEY or RPC_TRACE_URL on the server to load live data.</td></tr>';
  } finally {
    $("refresh").disabled = false;
  }
}

$("refresh").addEventListener("click", () => loadSummary(true));

document.querySelectorAll("[data-open]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.dataset.open;
    if (LINKS[target]) window.location.href = LINKS[target];
  });
});

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = button.dataset.copy;
    const value = ADDRESSES[target];
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      const old = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = old;
      }, 1200);
    } catch {
      window.prompt("Copy address", value);
    }
  });
});

loadSummary();

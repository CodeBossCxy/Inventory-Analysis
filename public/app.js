const $ = (id) => document.getElementById(id);

const valuationLabels = {
  Total_Cost: "Inventory valuation (cost)",
  Total_Cost_Orig: "Inventory valuation (beginning cost)",
  Total_Qty: "Inventory qty (end)",
  Total_Qty_Orig: "Inventory qty (beginning)",
};

let chart = null;
let lastResult = null; // { partNo, data, valuationKey }

function setStatus(msg, kind = "info") {
  const el = $("status");
  if (!msg) {
    el.className = "status hidden";
    el.textContent = "";
    return;
  }
  el.className = `status ${kind}`;
  el.textContent = msg;
}

function fmt(n, money = false) {
  if (n == null || Number.isNaN(n)) return "";
  const opts = money
    ? { style: "currency", currency: "USD", maximumFractionDigits: 0 }
    : { maximumFractionDigits: 0 };
  return new Intl.NumberFormat("en-US", opts).format(n);
}

async function run() {
  const partNo = $("partNo").value.trim();
  const weeks = $("weeks").value;
  const valuationKey = $("valuation").value;

  if (!partNo) {
    setStatus("Please enter a part number.", "error");
    return;
  }

  $("run").disabled = true;
  setStatus(`Fetching ${weeks} weeks for "${partNo}" from Plex…`, "info");

  try {
    const url = `/api/inventory?partNo=${encodeURIComponent(partNo)}&weeks=${encodeURIComponent(weeks)}`;
    const resp = await fetch(url);
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || `Request failed (${resp.status})`);

    lastResult = { partNo: json.partNo, data: json.data, valuationKey };
    render(json.data, valuationKey);
    $("exportCsv").disabled = json.data.length === 0;
    $("exportPng").disabled = json.data.length === 0;
    setStatus(
      `${json.data.length} weeks · part "${json.partNo}" · pulled ${new Date(json.generatedAt).toLocaleString()}`,
      "info"
    );
  } catch (err) {
    setStatus(String(err.message || err), "error");
  } finally {
    $("run").disabled = false;
  }
}

function render(data, valuationKey) {
  const labels = data.map((d) => d.YearWeek_Label);
  const received = data.map((d) => d.Received);
  const depletedNeg = data.map((d) => d.Depleted_Neg);
  const netChange = data.map((d) => d.Net_Change);
  const valuation = data.map((d) => d[valuationKey]);

  const isMoney = valuationKey.startsWith("Total_Cost");

  const datasets = [
    {
      type: "bar",
      label: "Received",
      data: received,
      backgroundColor: "rgba(22, 163, 74, 0.75)",
      yAxisID: "yQty",
      order: 3,
    },
    {
      type: "bar",
      label: "Depleted",
      data: depletedNeg,
      backgroundColor: "rgba(220, 38, 38, 0.75)",
      yAxisID: "yQty",
      order: 3,
    },
    {
      type: "line",
      label: "Net change",
      data: netChange,
      borderColor: "rgba(100, 116, 139, 0.9)",
      borderDash: [5, 4],
      pointRadius: 2,
      tension: 0.25,
      yAxisID: "yQty",
      order: 2,
    },
    {
      type: "line",
      label: valuationLabels[valuationKey] || "Valuation",
      data: valuation,
      borderColor: "rgba(29, 78, 216, 1)",
      backgroundColor: "rgba(29, 78, 216, 0.1)",
      borderWidth: 2,
      pointRadius: 3,
      tension: 0.25,
      fill: true,
      yAxisID: "yVal",
      order: 1,
    },
  ];

  const config = {
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      stacked: false,
      scales: {
        x: { stacked: true, grid: { display: false } },
        yQty: {
          type: "linear",
          position: "left",
          stacked: true,
          title: { display: true, text: "Quantity (received / −depleted)" },
          grid: { color: "rgba(0,0,0,0.05)" },
        },
        yVal: {
          type: "linear",
          position: "right",
          title: { display: true, text: isMoney ? "Valuation (USD)" : "Quantity" },
          grid: { drawOnChartArea: false },
          ticks: {
            callback: (v) => (isMoney ? "$" + Intl.NumberFormat("en-US", { notation: "compact" }).format(v) : v),
          },
        },
      },
      plugins: {
        legend: { position: "top" },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const money = ctx.dataset.yAxisID === "yVal" && isMoney;
              return `${ctx.dataset.label}: ${fmt(ctx.parsed.y, money)}`;
            },
          },
        },
      },
    },
  };

  if (chart) chart.destroy();
  chart = new Chart($("chart"), config);

  // table
  const tbody = $("dataTable").querySelector("tbody");
  tbody.innerHTML = data
    .map(
      (d) => `<tr>
        <td>${d.YearWeek_Label}<br><small style="color:#6b7280">${d.Week_Start_Date}</small></td>
        <td class="num">${fmt(d.Received)}</td>
        <td class="num">${fmt(d.Depleted)}</td>
        <td class="num">${fmt(d.Net_Change)}</td>
        <td class="num">${fmt(d.Total_Qty)}</td>
        <td class="num">${fmt(d[valuationKey], isMoney)}</td>
      </tr>`
    )
    .join("");
  $("dataTable").classList.remove("hidden");
}

// ---- Export -------------------------------------------------------------
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function safeName(s) {
  return s.replace(/[^a-z0-9._-]+/gi, "_");
}

function exportCsv() {
  if (!lastResult) return;
  const { partNo, data, valuationKey } = lastResult;

  // Full detail export — every column the API returns, not just the on-screen table.
  const columns = [
    "YearWeek_Label",
    "Week_Start_Date",
    "Year",
    "Week_No",
    "Received",
    "Depleted",
    "Net_Change",
    "Total_Qty_Orig",
    "Total_Qty",
    "Total_Cost_Orig",
    "Total_Cost",
    "Qty_Recv",
    "Qty_BOM",
    "Qty_Scrap",
    "Qty_Ship",
  ];

  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [columns.join(",")];
  for (const d of data) lines.push(columns.map((c) => esc(d[c])).join(","));

  // BOM so Excel reads UTF-8 correctly.
  const blob = new Blob(["﻿" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const today = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `inventory_${safeName(partNo)}_${data.length}wk_${today}.csv`);
}

function exportPng() {
  if (!chart) return;
  // Flatten onto a white background (canvas is transparent by default).
  const src = chart.canvas;
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0);

  out.toBlob((blob) => {
    const today = new Date().toISOString().slice(0, 10);
    const part = lastResult ? safeName(lastResult.partNo) : "chart";
    triggerDownload(blob, `inventory_${part}_${today}.png`);
  });
}

$("exportCsv").addEventListener("click", exportCsv);
$("exportPng").addEventListener("click", exportPng);

$("run").addEventListener("click", run);
$("partNo").addEventListener("keydown", (e) => {
  if (e.key === "Enter") run();
});

// Auto-run on load with defaults.
run();

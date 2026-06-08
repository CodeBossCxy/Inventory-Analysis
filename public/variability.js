const $ = (id) => document.getElementById(id);

let chart = null;
let lastResult = null; // { weeks, materials, usable }

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

const money0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const num2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const weeks = $("weeks").value;
  $("run").disabled = true;
  setStatus(`Starting analysis for ${weeks} weeks…`, "info");

  try {
    // 1) Kick off the background job.
    const startResp = await fetch(`/api/variability/start?weeks=${encodeURIComponent(weeks)}`, {
      method: "POST",
    });
    const startJson = await startResp.json();
    if (!startResp.ok) throw new Error(startJson.error || `Failed to start (${startResp.status})`);
    const jobId = startJson.jobId;

    // 2) Poll until done. First run is slow (warming the cache); later runs fly.
    let json = null;
    while (true) {
      await sleep(1200);
      const sResp = await fetch(`/api/variability/status?jobId=${encodeURIComponent(jobId)}`);
      const s = await sResp.json();
      if (!sResp.ok) throw new Error(s.error || `Status check failed (${sResp.status})`);

      if (s.state === "running") {
        const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
        setStatus(`Pulling material × week data from Plex… ${s.done}/${s.total} (${pct}%)`, "info");
        continue;
      }
      if (s.state === "error") throw new Error(s.error || "Analysis failed.");
      json = s.result; // done
      break;
    }

    // Keep only materials with a defined CV on both axes (i.e. real activity).
    const usable = json.materials.filter(
      (m) => m.cv_receipts != null && m.cv_depletion != null
    );
    lastResult = { ...json, usable };

    if (usable.length === 0) {
      setStatus("No materials had enough receipt + depletion activity in this window.", "error");
      if (chart) { chart.destroy(); chart = null; }
      $("dataTable").classList.add("hidden");
      return;
    }

    render(usable);

    const skipped = json.materials.length - usable.length;
    $("exportCsv").disabled = false;
    $("exportPng").disabled = false;
    setStatus(
      `${usable.length} materials plotted · ${json.weeks} weeks · ` +
        `${skipped} excluded (no/!enough activity) · pulled ${new Date(json.generatedAt).toLocaleString()}`,
      "info"
    );
  } catch (err) {
    setStatus(String(err.message || err), "error");
  } finally {
    $("run").disabled = false;
  }
}

// Scale inventory $ to a bubble radius so AREA is proportional to $.
function radiusScaler(materials) {
  const maxInv = Math.max(...materials.map((m) => Math.max(m.inventory, 0)), 1);
  const MIN_R = 5;
  const MAX_R = 38;
  return (inv) => {
    const v = Math.max(inv, 0);
    return MIN_R + (MAX_R - MIN_R) * Math.sqrt(v / maxInv);
  };
}

// Inline plugin: draw each material's name just above its bubble.
const bubbleLabels = {
  id: "bubbleLabels",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = "10px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = "#374151";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    chart.data.datasets.forEach((ds, di) => {
      if (ds.type === "line") return; // skip the reference line
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      meta.data.forEach((el, i) => {
        const p = ds.data[i];
        if (!p || p.name === undefined) return;
        ctx.fillText(p.name, el.x, el.y - (el.options?.radius ?? 5) - 2);
      });
    });
    ctx.restore();
  },
};

function render(materials) {
  const radiusFor = radiusScaler(materials);

  const points = materials.map((m) => ({
    x: m.cv_depletion,
    y: m.cv_receipts,
    r: radiusFor(m.inventory),
    code: m.code,
    name: m.name,
    inventory: m.inventory,
    ratio: m.cv_depletion > 0 ? m.cv_receipts / m.cv_depletion : null,
  }));

  // Split into two series so the legend can explain the colors:
  // suspects (receipts more erratic than demand) vs. the rest.
  const suspects = points.filter((p) => p.y > p.x);
  const onTrack = points.filter((p) => p.y <= p.x);

  const axisMax =
    Math.max(...points.flatMap((p) => [p.x, p.y]), 0.1) * 1.1;

  const config = {
    type: "bubble",
    data: {
      datasets: [
        {
          type: "line",
          label: "Reference line (receipts as steady as demand)",
          data: [
            { x: 0, y: 0 },
            { x: axisMax, y: axisMax },
          ],
          borderColor: "rgba(100,116,139,0.8)",
          borderDash: [6, 5],
          borderWidth: 1.5,
          pointRadius: 0,
          pointStyle: "line",
          fill: false,
          order: 1,
        },
        {
          label: "Receipts more erratic than demand",
          data: suspects,
          backgroundColor: "rgba(220, 38, 38, 0.55)",
          borderColor: "rgba(220, 38, 38, 0.9)",
          borderWidth: 1.5,
          order: 2,
        },
        {
          label: "Receipts track demand",
          data: onTrack,
          backgroundColor: "rgba(29, 78, 216, 0.45)",
          borderColor: "rgba(29, 78, 216, 0.8)",
          borderWidth: 1.5,
          order: 2,
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: {
          type: "linear",
          min: 0,
          max: axisMax,
          title: { display: true, text: "CV of weekly depletion  (demand variability →)" },
          grid: { color: "rgba(0,0,0,0.05)" },
        },
        y: {
          type: "linear",
          min: 0,
          max: axisMax,
          title: { display: true, text: "CV of weekly receipts  (purchasing variability →)" },
          grid: { color: "rgba(0,0,0,0.05)" },
        },
      },
      plugins: {
        legend: {
          position: "top",
          labels: {
            usePointStyle: true,
            boxHeight: 8,
          },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const p = ctx.raw;
              if (p.code === undefined) return null; // the reference line
              return [
                `${p.code}- ${p.name}`,
                `CV receipts (Y): ${num2.format(p.y)}`,
                `CV depletion (X): ${num2.format(p.x)}`,
                `Ratio Y÷X: ${p.ratio == null ? "—" : num2.format(p.ratio)}`,
                `Inventory: ${money0.format(p.inventory)}`,
                p.y > p.x ? "⚠ receipts lumpier than demand" : "✓ receipts track demand",
              ];
            },
          },
        },
      },
    },
  };

  if (chart) chart.destroy();
  chart = new Chart($("chart"), { ...config, plugins: [bubbleLabels] });

  renderTable(materials);
}

function renderTable(materials) {
  // Rank by how much lumpier receipts are than demand (Y÷X), worst first.
  const rows = materials
    .map((m) => ({
      ...m,
      ratio: m.cv_depletion > 0 ? m.cv_receipts / m.cv_depletion : Infinity,
    }))
    .sort((a, b) => b.ratio - a.ratio);

  const tbody = $("dataTable").querySelector("tbody");
  tbody.innerHTML = rows
    .map((m) => {
      const suspect = m.cv_receipts > m.cv_depletion;
      return `<tr style="${suspect ? "background:#fff5f5" : ""}">
        <td><strong>${m.code}-</strong> ${m.name}</td>
        <td class="num">${num2.format(m.cv_receipts)}</td>
        <td class="num">${num2.format(m.cv_depletion)}</td>
        <td class="num" style="color:${suspect ? "#dc2626" : "#16a34a"};font-weight:600">
          ${Number.isFinite(m.ratio) ? num2.format(m.ratio) : "∞"}</td>
        <td class="num">${money0.format(m.inventory)}</td>
      </tr>`;
    })
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

function exportCsv() {
  if (!lastResult) return;
  const cols = [
    "code",
    "name",
    "partNo",
    "cv_receipts",
    "cv_depletion",
    "mean_receipts",
    "mean_depletion",
    "inventory",
    "errors",
  ];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const m of lastResult.materials) lines.push(cols.map((c) => esc(m[c])).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const today = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `purchasing_variability_${lastResult.weeks}wk_${today}.csv`);
}

function exportPng() {
  if (!chart) return;
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
    triggerDownload(blob, `purchasing_variability_${today}.png`);
  });
}

$("run").addEventListener("click", run);
$("exportCsv").addEventListener("click", exportCsv);
$("exportPng").addEventListener("click", exportPng);

run();

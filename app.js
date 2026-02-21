import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.worker.min.mjs";

const SAVE_REQUEST_TIMEOUT_MS = 12000;
const AVAILABILITY_REQUEST_TIMEOUT_MS = 8000;
const MAX_PRESERVE_TIME_MS = 45000;
const MAX_CONCURRENT_SAVES = 5;
const WORKER_STAGGER_MS = 350;

const manuscriptInput = document.getElementById("manuscript");
const dropZone = document.getElementById("dropZone");
const browseBtn = document.getElementById("browseBtn");
const heroPanel = dropZone.closest(".hero");

const reviewPanel = document.getElementById("reviewPanel");
const linkList = document.getElementById("linkList");
const statusEl = document.getElementById("status");

const archiveBtn = document.getElementById("archiveBtn");
const retryBtn = document.getElementById("retryBtn");
const downloadBtn = document.getElementById("downloadBtn");
const addUrlInput = document.getElementById("addUrlInput");
const addUrlBtn = document.getElementById("addUrlBtn");

const progressPanel = document.getElementById("progressPanel");
const progressLabel = document.getElementById("progressLabel");
const progressPercent = document.getElementById("progressPercent");
const progressBar = document.getElementById("progressBar");

const stepEls = Array.from(document.querySelectorAll(".step"));

let items = [];
let itemIdCounter = 0;
let isExtracting = false;
let isArchiving = false;
let hasArchiveRun = false;

browseBtn.addEventListener("click", () => manuscriptInput.click());

dropZone.addEventListener("click", (event) => {
  if (event.target === browseBtn) {
    return;
  }
  manuscriptInput.click();
});

dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    manuscriptInput.click();
  }
});

["dragenter", "dragover"].forEach((type) => {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((type) => {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
});

dropZone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) {
    return;
  }

  const transfer = new DataTransfer();
  transfer.items.add(file);
  manuscriptInput.files = transfer.files;
  onFileSelected();
});

manuscriptInput.addEventListener("change", onFileSelected);
archiveBtn.addEventListener("click", () => runArchive(getIncludedItems(), "Archiving included links"));
retryBtn.addEventListener("click", () => runArchive(getIncludedUnresolvedItems(), "Retrying unresolved links"));
downloadBtn.addEventListener("click", onDownloadCsv);
addUrlBtn.addEventListener("click", onAddManualUrl);
addUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    onAddManualUrl();
  }
});

linkList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const id = Number(target.dataset.id);
  if (!Number.isInteger(id)) {
    return;
  }

  const row = items.find((entry) => entry.id === id);
  if (!row || isArchiving) {
    return;
  }

  if (target.dataset.action === "toggle-include") {
    if (row.included) {
      row.included = false;
      row.skipReason = row.skipReason || "manual";
      row.status = "skipped";
      row.archivedUrl = "";
      updateStatus("Link marked to skip.");
    } else {
      row.included = true;
      row.skipReason = null;
      row.status = "ready";
      updateStatus("Link marked for archiving.");
    }

    hasArchiveRun = items.some((item) => item.status === "saved");
    render();
  }
});

async function onExtract() {
  const file = manuscriptInput.files?.[0];
  if (!file) {
    updateStatus("Choose a file first.", true);
    return;
  }

  if (isExtracting || isArchiving) {
    return;
  }

  isExtracting = true;
  setProgress("Extracting links...", 5);
  updateActionStates();

  try {
    const urls = await extractUrlsFromFile(file, (pct) => setProgress("Extracting links...", pct));
    const unique = Array.from(new Set(urls.map(normalizeUrl).filter(Boolean)));

    items = unique.map((url) => createItem(url, "extracted"));
    hasArchiveRun = false;

    heroPanel.classList.add("hidden");
    reviewPanel.classList.remove("hidden");
    stepTo(2);

    const doiSkipped = items.filter((row) => row.skipReason === "doi").length;
    if (items.length === 0) {
      updateStatus("No external HTTP(S) links found. Add URLs manually.", true);
    } else if (doiSkipped > 0) {
      updateStatus(`Found ${items.length} links. ${doiSkipped} DOI link(s) were auto-skipped.`);
    } else {
      updateStatus(`Found ${items.length} links. Ready to archive.`);
    }

    setProgress("Extraction complete", 100);
    render();
  } catch (error) {
    console.error(error);
    updateStatus(`Extraction failed: ${error.message}`, true);
    hideProgressSoon();
  } finally {
    isExtracting = false;
    updateActionStates();
  }
}

async function runArchive(targetItems, label) {
  if (isArchiving) {
    return;
  }

  if (targetItems.length === 0) {
    updateStatus("No included links to archive. Unskip at least one link first.", true);
    return;
  }

  isArchiving = true;
  stepTo(3);

  for (const row of targetItems) {
    row.archivedUrl = "";
    row.status = "ready";
  }

  setProgress(`${label}...`, 0);
  updateStatus(`${label} (${Math.min(MAX_CONCURRENT_SAVES, targetItems.length)} at a time)`);
  render();
  updateActionStates();

  let completed = 0;
  const total = targetItems.length;
  let queueIndex = 0;
  const workers = Math.min(MAX_CONCURRENT_SAVES, total);

  const worker = async (workerIndex) => {
    if (workerIndex > 0) {
      await sleep(workerIndex * WORKER_STAGGER_MS);
    }

    while (queueIndex < total) {
      const idx = queueIndex;
      queueIndex += 1;

      const row = targetItems[idx];
      row.status = "saving";
      render();

      try {
        const outcome = await preserveUrl(row.originalUrl);
        row.archivedUrl = outcome.archivedUrl;
        row.status = outcome.status;
      } catch (error) {
        row.status = "save request failed";
        console.error(`Archive failed: ${row.originalUrl}`, error);
      }

      completed += 1;
      const pct = Math.round((completed / total) * 100);
      setProgress(`${label}...`, pct);
      updateStatus(`Archiving ${completed}/${total} complete.`);
      render();
    }
  };

  await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));

  hasArchiveRun = true;
  isArchiving = false;

  const included = getIncludedItems();
  const saved = included.filter((row) => row.status === "saved").length;
  const unresolved = included.filter((row) => isUnresolved(row.status)).length;
  const timedOut = included.filter((row) => row.status === "timed out").length;
  const failed = included.filter((row) => row.status === "save request failed").length;

  if (unresolved > 0) {
    updateStatus(
      `Archive run finished. ${saved}/${included.length} included links archived. ${unresolved} unresolved (${timedOut} timed out, ${failed} failed). Use Retry Unresolved.`,
      true
    );
  } else {
    updateStatus(`Archive run finished. ${saved}/${included.length} included links archived.`);
  }

  setProgress("Archiving complete", 100);
  stepTo(4);
  render();
  updateActionStates();
}

function onAddManualUrl() {
  if (isArchiving || isExtracting) {
    return;
  }

  const corrected = normalizeUrl(addUrlInput.value);
  if (!corrected) {
    updateStatus("Enter a valid URL (we accept example.org and will auto-fix common typos).", true);
    return;
  }

  const exists = items.some((row) => row.originalUrl === corrected);
  if (exists) {
    updateStatus("That link is already listed.", true);
    return;
  }

  items.push(createItem(corrected, "manual"));
  addUrlInput.value = "";
  reviewPanel.classList.remove("hidden");
  stepTo(2);
  updateStatus("Manual link added.");
  render();
}

function onDownloadCsv() {
  if (!hasArchiveRun || items.length === 0) {
    return;
  }

  const csvRows = [["original_url", "preserved_link", "status", "included", "skip_reason"]];
  for (const row of items) {
    csvRows.push([row.originalUrl, row.archivedUrl, row.status, String(row.included), row.skipReason ?? ""]);
  }

  const csvText = csvRows
    .map((line) => line.map(escapeCsvCell).join(","))
    .join("\n");

  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "archivelinks-results.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function createItem(url, source) {
  const parsed = new URL(url);
  const doi = isDoiUrl(parsed);

  return {
    id: ++itemIdCounter,
    originalUrl: url,
    archivedUrl: "",
    status: doi ? "skipped" : "ready",
    included: !doi,
    skipReason: doi ? "doi" : null,
    source,
    domain: parsed.hostname,
    path: parsed.pathname || "/"
  };
}

function onFileSelected() {
  const file = manuscriptInput.files?.[0];
  if (!file) {
    return;
  }
  onExtract();
}

function render() {
  updateActionStates();

  if (items.length === 0) {
    linkList.innerHTML = `<div class="empty-state">No links yet. Extract from a manuscript or add manually.</div>`;
    return;
  }

  const included = items.filter((r) => r.included).length;
  const saved = items.filter((r) => r.status === "saved").length;
  const header = `<div class="link-list-header">
    <span class="link-count">${items.length} links${saved > 0 ? ` · ${saved} archived` : ""} · ${included} included</span>
  </div>`;

  linkList.innerHTML = header + items.map(renderCard).join("");
}

function renderCard(row) {
  const statusClass = statusClassFor(row.status);
  const label = statusLabel(row.status, row.included);
  const toggleLabel = row.included ? "Skip" : "Include";
  const showToggle = !isArchiving && !hasArchiveRun;

  const archivedHtml = row.archivedUrl
    ? `<a class="archived-link" href="${escapeHtml(row.archivedUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.archivedUrl)}</a>`
    : "";

  return `
    <div class="link-row${row.included ? "" : " is-skipped"}" data-id="${row.id}">
      <span class="status-dot ${statusClass}" title="${escapeHtml(label)}"></span>
      <div class="link-content">
        <a class="source-link" href="${escapeHtml(row.originalUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.originalUrl)}</a>
        ${archivedHtml ? `<span class="archived-row">${archivedHtml}</span>` : ""}
      </div>
      ${showToggle ? `<button type="button" class="toggle-btn${row.included ? "" : " is-skipped"}" data-action="toggle-include" data-id="${row.id}">${toggleLabel}</button>` : ""}
    </div>
  `;
}

function updateActionStates() {
  const hasItems = items.length > 0;
  const hasIncluded = getIncludedItems().length > 0;
  const hasUnresolvedIncluded = getIncludedUnresolvedItems().length > 0;

  addUrlBtn.disabled = isExtracting || isArchiving;
  addUrlInput.disabled = isExtracting || isArchiving;

  archiveBtn.disabled = isExtracting || isArchiving || !hasIncluded;
  retryBtn.disabled = isExtracting || isArchiving || !hasUnresolvedIncluded;
  downloadBtn.disabled = isExtracting || isArchiving || !hasArchiveRun || !hasItems;
}

function updateStatus(message, warning = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("is-warning", warning);
}

function setProgress(label, percent) {
  progressPanel.classList.remove("hidden");
  progressLabel.textContent = label;
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  progressPercent.textContent = `${clamped}%`;
  progressBar.style.width = `${clamped}%`;
}

function hideProgressSoon() {
  setTimeout(() => {
    if (isExtracting || isArchiving) {
      return;
    }
    progressPanel.classList.add("hidden");
  }, 1200);
}

function stepTo(step) {
  for (const stepEl of stepEls) {
    const n = Number(stepEl.dataset.step);
    stepEl.classList.toggle("is-active", n === step);
    stepEl.classList.toggle("is-complete", n < step);
  }
}

function statusClassFor(status) {
  if (status === "saved") return "is-success";
  if (status === "saving") return "is-pending";
  if (status === "not yet indexed" || status === "timed out") return "is-warning";
  if (status === "save request failed") return "is-danger";
  if (status === "skipped") return "is-neutral";
  return "is-neutral";
}

function statusLabel(status, included) {
  if (!included || status === "skipped") return "Skipped";
  if (status === "ready") return "To Be Archived";
  if (status === "saving") return "Archiving";
  if (status === "saved") return "Archived";
  if (status === "not yet indexed") return "Not Indexed Yet";
  if (status === "timed out") return "Timed Out";
  if (status === "save request failed") return "Archive Failed";
  return status;
}

function isUnresolved(status) {
  return status === "not yet indexed" || status === "timed out" || status === "save request failed";
}

function getIncludedItems() {
  return items.filter((row) => row.included);
}

function getIncludedUnresolvedItems() {
  return items.filter((row) => row.included && isUnresolved(row.status));
}

function isDoiUrl(parsedUrl) {
  const host = parsedUrl.hostname.toLowerCase();
  if (host === "doi.org" || host.endsWith(".doi.org")) {
    return true;
  }

  const combined = `${parsedUrl.hostname}${parsedUrl.pathname}`.toLowerCase();
  return combined.includes("doi.org/") || /^\/(doi\/)?10\.\d{4,9}\//.test(parsedUrl.pathname.toLowerCase());
}

async function extractUrlsFromFile(file, onProgress) {
  const ext = file.name.toLowerCase().split(".").pop();

  if (ext === "pdf") {
    return extractUrlsFromPdf(file, onProgress);
  }

  if (ext === "docx") {
    const urls = await extractUrlsFromDocx(file);
    onProgress?.(100);
    return urls;
  }

  throw new Error("Unsupported file type. Use .pdf or .docx.");
}

async function extractUrlsFromPdf(file, onProgress) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const found = [];

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const annotations = await page.getAnnotations();

    for (const ann of annotations) {
      if (ann.url) found.push(ann.url);
      if (ann.unsafeUrl) found.push(ann.unsafeUrl);
    }

    const pct = Math.round((pageNo / pdf.numPages) * 100);
    onProgress?.(pct);
  }

  return found;
}

async function extractUrlsFromDocx(file) {
  if (!window.mammoth) {
    throw new Error("DOCX parser failed to load. Refresh and try again.");
  }

  const arrayBuffer = await file.arrayBuffer();
  const html = await window.mammoth
    .convertToHtml({ arrayBuffer })
    .then((result) => result.value);

  const doc = new DOMParser().parseFromString(html, "text/html");
  const anchors = Array.from(doc.querySelectorAll("a[href]"));
  return anchors.map((a) => a.getAttribute("href"));
}

function normalizeUrl(input) {
  if (!input || typeof input !== "string") {
    return null;
  }

  let candidate = input.trim();
  candidate = candidate.replace(/\s+/g, "");
  candidate = candidate.replace(/^hxxps?:\/\//i, (s) => s.toLowerCase().replace("hxxp", "http"));
  candidate = candidate.replace(/[),.;:]+$/, "");

  if (!candidate) {
    return null;
  }

  if (candidate.startsWith("www.")) {
    candidate = `https://${candidate}`;
  }

  if (!/^https?:\/\//i.test(candidate) && /^[\w.-]+\.[a-z]{2,}/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }

    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

async function preserveUrl(originalUrl) {
  const saveEndpoint = `https://web.archive.org/save/${encodeURIComponent(originalUrl)}`;
  let saveAttempted = false;

  try {
    await fetchWithTimeout(
      saveEndpoint,
      { method: "GET", mode: "no-cors", cache: "no-store" },
      SAVE_REQUEST_TIMEOUT_MS
    );
    saveAttempted = true;
  } catch {
    await triggerImageRequest(saveEndpoint, SAVE_REQUEST_TIMEOUT_MS);
    saveAttempted = true;
  }

  const availability = await pollForArchivedUrl(originalUrl, MAX_PRESERVE_TIME_MS);

  if (availability.archivedUrl) {
    return { archivedUrl: availability.archivedUrl, status: "saved" };
  }

  if (availability.timedOut) {
    return { archivedUrl: "", status: "timed out" };
  }

  if (saveAttempted) {
    return { archivedUrl: "", status: "not yet indexed" };
  }

  return { archivedUrl: "", status: "save request failed" };
}

async function pollForArchivedUrl(originalUrl, maxDurationMs) {
  const attempts = 8;
  const delayMs = 3000;
  const startedAt = Date.now();

  for (let i = 0; i < attempts; i += 1) {
    if (Date.now() - startedAt > maxDurationMs) {
      return { archivedUrl: "", timedOut: true };
    }

    const availabilityEndpoint = `https://archive.org/wayback/available?url=${encodeURIComponent(originalUrl)}`;

    try {
      const response = await fetchWithTimeout(
        availabilityEndpoint,
        { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" },
        AVAILABILITY_REQUEST_TIMEOUT_MS
      );

      if (response.ok) {
        const data = await response.json();
        const closest = data?.archived_snapshots?.closest;

        if (closest?.available && closest?.url) {
          return {
            archivedUrl: closest.url.replace("http://", "https://"),
            timedOut: false
          };
        }
      }
    } catch (error) {
      console.warn("Availability check failed", error);
    }

    await sleep(delayMs);
  }

  return { archivedUrl: "", timedOut: false };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function triggerImageRequest(url, timeoutMs) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(), timeoutMs);

    img.onload = () => {
      clearTimeout(timer);
      resolve();
    };

    img.onerror = () => {
      clearTimeout(timer);
      resolve();
    };

    img.src = url;
  });
}

function escapeCsvCell(value) {
  const v = value ?? "";
  return `"${String(v).replaceAll('"', '""')}"`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

stepTo(1);
render();
updateActionStates();

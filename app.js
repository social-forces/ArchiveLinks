import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.worker.min.mjs";

const manuscriptInput = document.getElementById("manuscript");
const extractBtn = document.getElementById("extractBtn");
const preserveBtn = document.getElementById("preserveBtn");
const downloadBtn = document.getElementById("downloadBtn");
const addUrlBtn = document.getElementById("addUrlBtn");
const addUrlInput = document.getElementById("addUrlInput");
const phase2Panel = document.getElementById("phase2Panel");
const statusEl = document.getElementById("status");
const resultsBody = document.getElementById("resultsBody");

const SAVE_REQUEST_TIMEOUT_MS = 12000;
const AVAILABILITY_REQUEST_TIMEOUT_MS = 8000;
const MAX_PRESERVE_TIME_MS = 45000;

let results = [];
let isPreserving = false;
let hasPreserved = false;

manuscriptInput.addEventListener("change", () => {
  const file = manuscriptInput.files?.[0];
  resetWorkflow();

  if (!file) {
    setStatus("No file selected.");
    return;
  }

  setStatus(`Selected: ${file.name}`);
});

extractBtn.addEventListener("click", async () => {
  const file = manuscriptInput.files?.[0];
  if (!file) {
    setStatus("Choose a manuscript first.", true);
    return;
  }

  try {
    setStatus("Extracting links from document...");
    const extractedUrls = await extractUrlsFromFile(file);

    results = extractedUrls.map((url) => ({
      originalUrl: url,
      archivedUrl: "",
      status: "ready"
    }));

    phase2Panel.classList.remove("hidden");
    hasPreserved = false;
    isPreserving = false;

    renderResults();
    updateActionStates();

    if (extractedUrls.length === 0) {
      setStatus("No external HTTP(S) links found. Add any missing links manually in Phase 2.", true);
      return;
    }

    setStatus(`Found ${extractedUrls.length} unique external links. Review, edit, then preserve.`);
  } catch (error) {
    console.error(error);
    setStatus(`Extraction failed: ${error.message}`, true);
    updateActionStates();
  }
});

addUrlBtn.addEventListener("click", addManualUrl);
addUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addManualUrl();
  }
});

resultsBody.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.dataset.action !== "remove") {
    return;
  }

  if (isPreserving) {
    return;
  }

  const idx = Number(target.dataset.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= results.length) {
    return;
  }

  if (hasPreserved) {
    invalidatePreservation();
  }

  results.splice(idx, 1);
  renderResults();
  updateActionStates();

  if (results.length === 0) {
    setStatus("Link list is empty. Add URLs manually before preserving.", true);
  } else {
    setStatus(`Removed link. ${results.length} link(s) ready.`);
  }
});

preserveBtn.addEventListener("click", async () => {
  if (results.length === 0) {
    setStatus("No URLs to preserve. Add links first.", true);
    return;
  }

  isPreserving = true;
  hasPreserved = false;
  updateActionStates();

  for (const item of results) {
    item.archivedUrl = "";
    item.status = "ready";
  }

  renderResults();
  setStatus(`Submitting ${results.length} links to Wayback Machine...`);

  for (let i = 0; i < results.length; i += 1) {
    const item = results[i];
    item.status = "saving";
    renderResults();

    try {
      const outcome = await preserveUrl(item.originalUrl);
      item.archivedUrl = outcome.archivedUrl;
      item.status = outcome.status;
    } catch (error) {
      item.status = "save request failed";
      console.error(`Failed to save ${item.originalUrl}:`, error);
    }

    renderResults();
  }

  const savedCount = results.filter((r) => r.status === "saved").length;
  const timedOutCount = results.filter((r) => r.status === "timed out").length;
  const failedCount = results.filter((r) => r.status === "save request failed").length;
  const unresolved = results.length - savedCount;

  if (unresolved > 0) {
    setStatus(
      `Done. Saved ${savedCount}/${results.length}. ${unresolved} unresolved (${timedOutCount} timed out, ${failedCount} failed). Retry unresolved links.`,
      true
    );
  } else {
    setStatus(`Done. Saved ${savedCount}/${results.length} links.`);
  }

  isPreserving = false;
  hasPreserved = true;
  updateActionStates();
  renderResults();
});

downloadBtn.addEventListener("click", () => {
  if (results.length === 0 || !hasPreserved) {
    return;
  }

  const csvRows = [["original_url", "preserved_link", "status"]];

  for (const row of results) {
    csvRows.push([row.originalUrl, row.archivedUrl, row.status]);
  }

  const csvText = csvRows
    .map((line) => line.map(escapeCsvCell).join(","))
    .join("\n");

  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "citation-preservation-results.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});

function addManualUrl() {
  if (isPreserving) {
    return;
  }

  const candidate = normalizeUrl(addUrlInput.value);
  if (!candidate) {
    setStatus("Enter a valid HTTP(S) URL to add.", true);
    return;
  }

  const duplicate = results.some((r) => r.originalUrl === candidate);
  if (duplicate) {
    setStatus("That URL is already in the list.", true);
    return;
  }

  if (hasPreserved) {
    invalidatePreservation();
  }

  results.push({
    originalUrl: candidate,
    archivedUrl: "",
    status: "ready"
  });

  addUrlInput.value = "";
  renderResults();
  updateActionStates();
  setStatus(`Added URL. ${results.length} link(s) ready.`);
}

function invalidatePreservation() {
  for (const row of results) {
    row.archivedUrl = "";
    row.status = "ready";
  }
  hasPreserved = false;
}

function resetWorkflow() {
  results = [];
  isPreserving = false;
  hasPreserved = false;
  phase2Panel.classList.add("hidden");
  addUrlInput.value = "";
  renderResults();
  updateActionStates();
}

function updateActionStates() {
  const hasLinks = results.length > 0;

  preserveBtn.disabled = isPreserving || !hasLinks;
  addUrlBtn.disabled = isPreserving;
  addUrlInput.disabled = isPreserving;
  downloadBtn.disabled = isPreserving || !hasLinks || !hasPreserved;
}

function setStatus(message, isWarning = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("warning", isWarning);
}

function renderResults() {
  resultsBody.innerHTML = "";

  results.forEach((row, idx) => {
    const tr = document.createElement("tr");

    tr.appendChild(cell(String(idx + 1)));
    tr.appendChild(linkCell(row.originalUrl));

    if (row.archivedUrl) {
      tr.appendChild(linkCell(row.archivedUrl));
    } else {
      tr.appendChild(cell("-"));
    }

    tr.appendChild(cell(row.status));

    const actionTd = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-btn";
    removeBtn.dataset.action = "remove";
    removeBtn.dataset.index = String(idx);
    removeBtn.textContent = "x";
    removeBtn.disabled = isPreserving;
    actionTd.appendChild(removeBtn);

    tr.appendChild(actionTd);
    resultsBody.appendChild(tr);
  });
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function linkCell(url) {
  const td = document.createElement("td");
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = url;
  td.appendChild(a);
  return td;
}

async function extractUrlsFromFile(file) {
  const ext = file.name.toLowerCase().split(".").pop();

  let rawUrls = [];
  if (ext === "pdf") {
    rawUrls = await extractUrlsFromPdf(file);
  } else if (ext === "docx") {
    rawUrls = await extractUrlsFromDocx(file);
  } else {
    throw new Error("Unsupported file type. Use .pdf or .docx.");
  }

  const cleaned = rawUrls
    .map(normalizeUrl)
    .filter(Boolean);

  return Array.from(new Set(cleaned));
}

async function extractUrlsFromPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const found = [];

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const annotations = await page.getAnnotations();

    for (const ann of annotations) {
      if (ann.url) {
        found.push(ann.url);
      }
      if (ann.unsafeUrl) {
        found.push(ann.unsafeUrl);
      }
    }
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
  candidate = candidate.replace(/[),.;:]+$/, "");

  if (!candidate) {
    return null;
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

  let saveRequestAttempted = false;

  try {
    await fetchWithTimeout(
      saveEndpoint,
      {
        method: "GET",
        mode: "no-cors",
        cache: "no-store"
      },
      SAVE_REQUEST_TIMEOUT_MS
    );
    saveRequestAttempted = true;
  } catch {
    await triggerImageRequest(saveEndpoint);
    saveRequestAttempted = true;
  }

  const availability = await pollForArchivedUrl(originalUrl, MAX_PRESERVE_TIME_MS);
  if (availability.archivedUrl) {
    return { archivedUrl: availability.archivedUrl, status: "saved" };
  }

  if (availability.timedOut) {
    return { archivedUrl: "", status: "timed out" };
  }

  if (saveRequestAttempted) {
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
        {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store"
        },
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
      console.warn("Availability check failed:", error);
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

function escapeCsvCell(value) {
  const v = value ?? "";
  return `"${String(v).replaceAll('"', '""')}"`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function triggerImageRequest(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
  });
}

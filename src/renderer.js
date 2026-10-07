const $ = (s) => document.querySelector(s);
const api = window.s3;
const state = {
  profiles: [],
  profile: null,
  bucket: "",
  prefix: "",
  tokens: [null],
  page: 0,
  listing: null,
  request: 0,
  jobs: [],
  view: "browser",
  busy: false,
  details: null,
  detailsOffset: 0,
  selection: new Map(),
  searchQuery: null,
  sort: "name",
  sortDirection: 1,
  locations: { bookmarks: [], recent: [] },
  uploadContext: null,
};
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const bytes = (n) => {
  if (!n) return "0 B";
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][i]}`;
};
let toastTimer;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 8000);
}
function act(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      toast(e.message);
    }
  };
}
function view(name) {
  state.view = name;
  $("#browser-view").hidden = name !== "browser";
  $("#queue-view").hidden = name !== "queue";
  $("#browse-nav").classList.toggle("active", name === "browser");
  $("#queue-nav").classList.toggle("active", name === "queue");
  if (name === "queue") refreshJobs().catch((e) => toast(e.message));
}
function renderConnections() {
  $("#connections").innerHTML = state.profiles
    .map(
      (p) =>
        `<button class="connection-item ${p.id === state.profile?.id ? "selected" : ""}" data-id="${esc(p.id)}"><span class="mini-icon">◈</span><span><b>${esc(p.name)}</b><small>${esc(p.provider)}${p.locked ? " · Locked" : !p.remember ? " · Session" : ""}</small></span></button>`,
    )
    .join("");
  for (const el of $("#connections").children)
    el.onclick = act(() => selectConnection(el.dataset.id));
}
function storageNoun(provider = state.profile?.provider) {
  return ["OpenStack Swift", "Azure Blob Storage"].includes(provider)
    ? "container"
    : "bucket";
}
async function selectConnection(id) {
  state.selection.clear();
  state.searchQuery = null;
  state.profile = state.profiles.find((p) => p.id === id);
  state.bucket = "";
  state.prefix = "";
  state.listing = null;
  state.request++;
  renderConnections();
  view("browser");
  $("#welcome").hidden = true;
  $("#browser").hidden = false;
  $("#workspace-name").textContent = state.profile.name;
  $("#connection-name").textContent = state.profile.name;
  $("#endpoint-label").textContent =
    state.profile.endpoint ||
    (state.profile.provider === "Azure Blob Storage"
      ? "Azure Blob Storage · Account endpoint"
      : state.profile.provider === "Google Cloud Storage"
        ? `Google Cloud Storage${state.profile.projectId ? ` · ${state.profile.projectId}` : ""}`
        : state.profile.provider === "OpenStack Swift"
          ? "OpenStack Swift · Keystone"
          : "Amazon S3 · Regional endpoint");
  $("#provider-label").textContent = state.profile.provider;
  $("#refresh-swift").hidden =
    state.profile.provider !== "OpenStack Swift" ||
    state.profile.swiftAuth === "keystone";
  $("#refresh-swift").disabled = !!state.profile.locked;
  const noun = storageNoun();
  $("#bucket-label").textContent = noun.toUpperCase();
  $("#bucket-select").setAttribute("aria-label", `Choose ${noun}`);
  $("#list-buckets").textContent = `↻ List ${noun}s`;
  $("#direct-bucket").placeholder = `Or enter a ${noun} name`;
  $("#direct-bucket").setAttribute("aria-label", `${noun} name`);
  $("#open-bucket").textContent = `Open ${noun} →`;
  $("#bucket-select").innerHTML = `<option value="">Select a ${noun}</option>`;
  $("#direct-bucket").value = state.profile.bucket || "";
  renderFiles();
  if (state.profile.bucket) await openBucket(state.profile.bucket);
  else await listBuckets();
}
async function listBuckets() {
  if (!state.profile) return;
  const id = state.profile.id;
  $("#list-buckets").disabled = true;
  try {
    const buckets = await api.buckets(id);
    if (state.profile?.id !== id) return;
    $("#bucket-select").innerHTML =
      `<option value="">Select a ${storageNoun()}</option>` +
      buckets
        .map((b) => `<option value="${esc(b)}">${esc(b)}</option>`)
        .join("");
    $("#bucket-select").value = state.bucket;
    if (!buckets.length)
      $("#browser-status").textContent =
        `No ${storageNoun()}s returned. You can also open a ${storageNoun()} by name.`;
  } catch (e) {
    if (state.profile?.id === id)
      $("#browser-status").textContent =
        `Could not list ${storageNoun()}s: ${e.message}. Enter a ${storageNoun()} name to open it directly.`;
  } finally {
    $("#list-buckets").disabled = false;
  }
}
async function openBucket(bucket) {
  if (!bucket.trim()) return;
  state.bucket = bucket.trim();
  if (![...$("#bucket-select").options].some((o) => o.value === state.bucket)) {
    $("#bucket-select").add(new Option(state.bucket, state.bucket));
  }
  $("#direct-bucket").value = state.bucket;
  $("#bucket-select").value = state.bucket;
  await navigate("");
}
async function navigate(prefix) {
  state.prefix = prefix;
  state.searchQuery = null;
  state.selection.clear();
  $("#prefix-input").value = prefix;
  state.page = 0;
  state.tokens = [null];
  $("#search").value = "";
  await loadFiles();
  if (state.profile && state.bucket) await visitLocation();
}
async function loadFiles() {
  if (!state.profile || !state.bucket) return;
  const request = ++state.request;
  state.selection.clear();
  state.listing = null;
  renderFiles();
  $("#browser-status").textContent = "Loading objects…";
  try {
    const listing =
      state.searchQuery !== null
        ? await api["objects:search"]({
            ...locationContext(),
            query: state.searchQuery,
            token: state.tokens[state.page],
          })
        : await api.browse(
            state.profile.id,
            state.bucket,
            state.prefix,
            state.tokens[state.page],
          );
    if (request !== state.request) return;
    state.listing = listing;
    renderFiles();
  } catch (e) {
    if (request === state.request) {
      renderFiles();
      $("#browser-status").textContent =
        `Unable to open this location: ${e.message}`;
    }
  }
}
function renderFiles() {
  let accumulated = "";
  const crumbs = [
    { label: state.bucket || `Select a ${storageNoun()}`, prefix: "" },
  ];
  for (const part of state.prefix.split("/").slice(0, -1)) {
    accumulated += part + "/";
    crumbs.push({ label: part || "(empty segment)", prefix: accumulated });
  }
  $("#breadcrumbs").innerHTML = crumbs
    .map(
      (c, i) =>
        `${i ? "<span>/</span>" : ""}<button data-index="${i}">${i ? "" : "▣ "}${esc(c.label)}</button>`,
    )
    .join("");
  for (const b of $("#breadcrumbs").querySelectorAll("button"))
    b.onclick = act(() => navigate(crumbs[+b.dataset.index].prefix));
  const filter = $("#search").value.toLowerCase();
  const rows = state.listing
    ? [
        ...state.listing.folders.map((key) => ({ key, folder: true })),
        ...state.listing.objects
          .filter((o) => !o.key.endsWith("/"))
          .map((o) => ({ ...o, folder: false })),
      ].filter((o) =>
        o.key.slice(state.prefix.length).toLowerCase().includes(filter),
      )
    : [];
  rows.sort(
    (a, b) =>
      Number(b.folder) - Number(a.folder) ||
      state.sortDirection *
        (state.sort === "size"
          ? (a.size || 0) - (b.size || 0)
          : state.sort === "date"
            ? (Date.parse(a.modified) || 0) - (Date.parse(b.modified) || 0)
            : a.key.localeCompare(b.key)),
  );
  state.visibleRows = rows;
  $("#files").innerHTML = rows
    .map(
      (o, i) =>
        `<tr class="${state.selection.has(o.key) ? "selected-row" : ""}"><td class="selection-cell"><input type="checkbox" data-select="${i}" aria-label="Select ${esc(o.key)}" ${state.selection.has(o.key) ? "checked" : ""} /></td><td><button class="file-name" data-open="${i}" title="${esc(o.key)}"><span class="file-icon ${o.folder ? "" : "document"}">${o.folder ? "▰" : "▤"}</span><span>${esc(o.key.slice(state.prefix.length).replace(/\/$/, ""))}</span></button></td><td>${o.folder ? "—" : bytes(o.size)}</td><td>${o.modified ? esc(new Date(o.modified).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })) : "—"}</td><td>${o.folder ? "" : `<button class="download" data-download="${i}" aria-label="Download ${esc(o.key)}" title="Download">↓</button>`}</td></tr>`,
    )
    .join("");
  for (const b of $("#files").querySelectorAll("[data-open]"))
    b.onclick = act(() => {
      const o = rows[+b.dataset.open];
      return o.folder ? navigate(o.key) : openObject(o.key);
    });
  for (const b of $("#files").querySelectorAll("[data-download]"))
    b.onclick = act(() => download(rows[+b.dataset.download].key));
  for (const input of $("#files").querySelectorAll("[data-select]"))
    input.onchange = () => {
      const row = rows[+input.dataset.select];
      if (input.checked)
        state.selection.set(row.key, { key: row.key, folder: row.folder });
      else state.selection.delete(row.key);
      renderSelection();
    };
  renderSelection();
  $("#clear-search").hidden = state.searchQuery === null;
  $("#browser-status").textContent = !state.bucket
    ? `Select a ${storageNoun()} or enter its name to start browsing.`
    : state.listing && !rows.length
      ? filter
        ? "No matching objects on this page."
        : state.searchQuery !== null
          ? "No matches in this search batch. Use Next to continue if available."
          : "This folder is empty. Upload a folder or files to get started."
      : "";
  $("#file-count").textContent =
    `${rows.length} items · sorted within this page${state.searchQuery !== null ? ` · recursive search: ${state.searchQuery} · ${state.listing?.scanned || 0} keys scanned` : filter ? " · filtered" : ""}`;
  $("#page-number").textContent = `Page ${state.page + 1}`;
  $("#previous").disabled = state.page === 0 || !state.listing;
  $("#next").disabled = !state.listing?.token;
}
function newConnection() {
  $("#connection-error").textContent = "";
  $("#connection-dialog").showModal();
}
function newUpload() {
  if (!state.profile) {
    newConnection();
    return;
  }
  if (!state.bucket) {
    view("browser");
    toast(`Open a destination ${storageNoun()} first.`);
    return;
  }
  state.uploadContext = locationContext();
  $("#upload-title").textContent = `Upload to your ${storageNoun()}`;
  $("#upload-prefix").placeholder = `Leave empty for ${storageNoun()} root`;
  $("#upload-prefix").value = state.prefix;
  $("#upload-destination").textContent =
    `${state.profile.name} / ${state.bucket}`;
  $("#upload-error").textContent = "";
  updateExample();
  $("#upload-dialog").showModal();
}
function updateExample() {
  const p = $("#upload-prefix").value;
  $("#example").textContent =
    `${p}${p && !p.endsWith("/") ? "/" : ""}Photos/2026/image.jpg`;
}
async function refreshJobs() {
  state.jobs = await api.jobs();
  const queueStatus = await api["queue:status"]();
  if (!$("#queue-auto").disabled) $("#queue-auto").checked = queueStatus.auto;
  $("#queue-count").textContent = state.jobs.filter(
    (j) => j.state !== "complete",
  ).length;
  if (state.view !== "queue") return;
  if (!state.jobs.length) {
    $("#jobs").innerHTML =
      '<div class="empty-queue"><h2>A place for your next big move.</h2><p>Open a bucket and choose Upload to prepare your first batch.</p></div>';
    return;
  }
  // Keep existing buttons stable while polling so keyboard focus and clicks are preserved.
  for (const old of [...$("#jobs").children])
    if (!state.jobs.some((j) => `job-${j.id}` === old.id)) old.remove();
  for (const j of state.jobs) {
    let el = document.getElementById(`job-${j.id}`);
    const profile = state.profiles.find((p) => p.id === j.profile);
    if (!el) {
      el = document.createElement("article");
      el.className = "job";
      el.id = `job-${j.id}`;
      el.innerHTML = `<div class="job-head"><span class="connection-orb">⇧</span><div><h3></h3><small></small></div><span class="state"></span></div><progress max="100" value="0"></progress><div class="job-stats"><span></span><span></span></div><div class="active-file"></div><div class="job-warning"></div><div class="job-error"></div><div class="job-actions"><button class="primary" data-action="start">Start upload</button><button data-action="pause">Pause</button><button data-action="retry">Retry failed</button><button data-action="details">Details</button><button data-action="settings">Settings</button><button data-action="report">Export failures</button><button data-action="cancel" class="danger">Cancel</button><button class="remove" data-action="remove">Remove batch</button></div>`;
      $("#jobs").append(el);
      for (const b of el.querySelectorAll("[data-action]"))
        b.onclick = act(async () => {
          b.disabled = true;
          try {
            const action = b.dataset.action;
            if (action === "details") {
              state.details = j.id;
              state.detailsOffset = 0;
              $("#details-dialog").showModal();
              await loadDetails();
            } else if (action === "settings") {
              transferSettings(state.jobs.find((job) => job.id === j.id));
            } else if (action === "report") await api["queue:export"](j.id);
            else if (action === "cancel") {
              if (
                confirm(
                  "Cancel this batch? Completed transfers remain. Unfinished files will stop.",
                )
              )
                await api["queue:cancel"](j.id);
            } else if (action === "retry") {
              await api.retry(j.id);
              await api.start(j.id);
            } else if (action === "pause") await api.pause();
            else if (action === "remove") {
              if (
                confirm(
                  "Remove this batch from the local queue? Uploaded objects will remain in storage.",
                )
              )
                await api.remove(j.id);
            } else await api.start(j.id);
            await refreshJobs();
          } finally {
            b.disabled = false;
          }
        });
    }
    el.querySelector("h3").textContent = `${j.bucket}/${j.prefix}`;
    el.querySelector(".connection-orb").textContent =
      j.kind === "download" ? "⇩" : "⇧";
    el.querySelector(".job-head small").textContent =
      `${j.sync ? "Sync" : j.kind === "download" ? "Download" : "Upload"} · ${profile?.name || "Connection unavailable"} · ${new Date(j.created).toLocaleString()} · ${j.concurrency} workers · ${j.overwrite ? "Replace existing" : "Skip existing"}`;
    const label = el.querySelector(".state");
    label.className = `state ${j.state}`;
    label.textContent = j.state;
    const finished = j.done + j.skipped;
    const activeBytes = j.active.reduce((s, e) => s + e.loaded, 0);
    el.querySelector("progress").value = j.bytes
      ? Math.min(100, ((j.completedBytes + activeBytes) / j.bytes) * 100)
      : j.total
        ? (finished / j.total) * 100
        : 0;
    const stats = el.querySelectorAll(".job-stats span");
    stats[0].textContent = `${finished.toLocaleString()} / ${j.total.toLocaleString()} objects · ${j.skipped.toLocaleString()} skipped · ${j.failed.toLocaleString()} failed`;
    stats[1].textContent = `${bytes(j.completedBytes + activeBytes)} / ${bytes(j.bytes)} · ${bytes(j.speed || 0)}/s · ETA ${j.eta == null ? "—" : duration(j.eta)}`;
    el.querySelector(".active-file").textContent = j.active.length
      ? `${j.kind === "download" ? "↓" : "↑"} ${j.active[0].key}${j.active.length > 1 ? ` · +${j.active.length - 1} active` : ""}`
      : "";
    el.querySelector(".job-warning").textContent = j.warnings
      ? `${j.warnings} symlinks or special files were skipped during scanning.`
      : "";
    el.querySelector(".job-error").textContent =
      j.error ||
      (!profile
        ? "This connection was session-only or has been removed. Create a new connection and batch to upload unfinished files."
        : "");
    el.querySelector("[data-action=start]").hidden =
      !["paused", "failed", "queued"].includes(j.state) ||
      !!j.error ||
      !profile;
    el.querySelector("[data-action=start]").textContent = finished
      ? `Resume ${j.kind || "upload"}`
      : `Start ${j.kind || "upload"}`;
    el.querySelector("[data-action=cancel]").hidden = [
      "complete",
      "cancelled",
      "canceled",
    ].includes(j.state);
    el.querySelector("[data-action=settings]").hidden = [
      "running",
      "scanning",
    ].includes(j.state);
    el.querySelector("[data-action=pause]").hidden = j.state !== "running";
    el.querySelector("[data-action=retry]").hidden =
      (!j.failed && j.cleanupState !== "failed") ||
      j.state === "running" ||
      (!!j.error && j.cleanupState !== "failed") ||
      !profile;
    el.querySelector("[data-action=retry]").textContent =
      j.cleanupState === "failed" ? "Retry sync cleanup" : "Retry failed";
    el.querySelector("[data-action=remove]").hidden = [
      "running",
      "scanning",
    ].includes(j.state);
  }
}
async function loadDetails() {
  const id = state.details,
    offset = state.detailsOffset,
    filter = $("#details-filter").value;
  const rows = await api.entries(id, filter, offset);
  if (
    id !== state.details ||
    offset !== state.detailsOffset ||
    filter !== $("#details-filter").value
  )
    return;
  $("#details-page").textContent = `Page ${state.detailsOffset / 100 + 1}`;
  $("#details-prev").disabled = !state.detailsOffset;
  $("#details-next").disabled = rows.length < 100;
  $("#details-list").innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<div class="detail-row">${esc(r.key)}<small>${esc(r.state)} · ${bytes(r.size)}</small>${r.error ? `<p>${esc(r.error)}</p>` : ""}</div>`,
        )
        .join("")
    : "<p>No objects in this view.</p>";
}
$("#browse-nav").onclick = () => view("browser");
$("#queue-nav").onclick = () => view("queue");
for (const id of ["#add-small", "#add-connection", "#connect-first"])
  $(id).onclick = newConnection;
for (const id of ["#upload-top", "#queue-upload"]) $(id).onclick = newUpload;
for (const b of document.querySelectorAll("[data-close]"))
  b.onclick = () => document.getElementById(b.dataset.close).close();
function updateAuthenticationFields() {
  const kind =
    $("#provider").value === "OpenStack Swift"
      ? "swift"
      : $("#provider").value === "Azure Blob Storage"
        ? "azure"
        : $("#provider").value === "Google Cloud Storage"
          ? "gcs"
          : "s3";
  const mode = $("#" + kind + "-auth")?.value;
  for (const group of document.querySelectorAll("[data-auth-fields]")) {
    const [provider, modes] = group.dataset.authFields.split(":");
    const active = provider === kind && modes.split(",").includes(mode);
    group.hidden = !active;
    for (const input of group.querySelectorAll("input, textarea, select")) {
      input.disabled = !active;
      input.required = active && input.dataset.required !== undefined;
    }
  }
  const endpointHidden =
    kind === "gcs" ||
    (kind === "swift" && mode === "keystone") ||
    (kind === "azure" && mode === "connectionString");
  $("#endpoint-field").hidden = endpointHidden;
  $("#endpoint").disabled = endpointHidden;
  $("#endpoint").required =
    !endpointHidden &&
    (kind === "swift" ||
      (kind === "s3" && $("#provider").value !== "Amazon S3"));
  $("[name=projectId]").required = kind === "gcs" && mode !== "json";
}
for (const kind of ["swift", "azure", "gcs"])
  $("#" + kind + "-auth").onchange = updateAuthenticationFields;
$("#provider").onchange = () => {
  const p = $("#provider").value;
  const kind =
    p === "OpenStack Swift"
      ? "swift"
      : p === "Azure Blob Storage"
        ? "azure"
        : p === "Google Cloud Storage"
          ? "gcs"
          : "s3";
  for (const group of document.querySelectorAll("[data-provider-fields]")) {
    const active = group.dataset.providerFields === kind;
    group.hidden = !active;
    for (const input of group.querySelectorAll("input, textarea, select")) {
      if (input.required) input.dataset.required = "";
      input.disabled = !active;
      input.required = active && input.dataset.required !== undefined;
    }
  }
  $("#endpoint-field").hidden = kind === "gcs";
  $("#endpoint").disabled = kind === "gcs";
  $("#endpoint").required =
    kind === "swift" || (kind === "s3" && p !== "Amazon S3");
  $("#endpoint-title").textContent =
    kind === "swift"
      ? "Account storage URL"
      : kind === "azure"
        ? "Blob service URL (optional)"
        : "Endpoint URL";
  $("#default-bucket-label").textContent =
    `Default ${storageNoun(p)} (optional)`;
  $("#default-bucket").placeholder = `my-${storageNoun(p)}`;
  $("#region").value = p === "Cloudflare R2" ? "auto" : "us-east-1";
  $("#path-style").checked = ["Ceph", "MinIO", "Custom S3"].includes(p);
  $("#endpoint").placeholder =
    kind === "swift"
      ? "https://swift.example.com/v1/AUTH_account"
      : kind === "azure"
        ? "Default: https://ACCOUNT.blob.core.windows.net"
        : p === "Cloudflare R2"
          ? "https://ACCOUNT_ID.r2.cloudflarestorage.com"
          : p === "Amazon S3"
            ? "Leave empty for the default AWS endpoint"
            : "https://s3.example.com";
  $("#endpoint-help").textContent =
    kind === "swift"
      ? "Use the account storage URL from the service catalog, including /v1/AUTH_account; do not use the Keystone authentication URL."
      : kind === "azure"
        ? "Leave empty for public Azure, or enter your Blob service endpoint for a sovereign cloud or emulator."
        : p === "Cloudflare R2"
          ? "Use the S3 API endpoint from your Cloudflare dashboard."
          : "Use the S3 API endpoint, including https:// and an optional port.";
  $("#provider-help").textContent =
    kind === "swift"
      ? "Use an existing token or sign in through Keystone for automatic token refresh. A configured account TempURL key enables download links."
      : kind === "azure"
        ? "Connect with an account key, SAS token, or connection string. Containers appear in the browser like S3 buckets."
        : kind === "gcs"
          ? "Use a service account JSON key, a key file, or Application Default Credentials configured on this device. A project ID is needed to list buckets."
          : "Connect using S3 API credentials.";
  updateAuthenticationFields();
};
$("#provider").onchange();
$("#connection-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(e.target));
    data.pathStyle = $("#path-style").checked;
    data.remember = $("#remember").checked;
    state.profiles = await api["connection:add"](data);
    $("#connection-dialog").close();
    const remember = $("#remember").checked;
    e.target.reset();
    $("#remember").checked = remember;
    $("#provider").onchange();
    await selectConnection(state.profiles.at(-1).id);
  } catch (e) {
    $("#connection-error").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
$("#refresh-swift").onclick = () => {
  $("#swift-token-form").reset();
  $("#swift-token-error").textContent = "";
  $("#swift-token-connection").textContent = state.profile.name;
  $("#swift-token-form").dataset.profile = state.profile.id;
  $("#swift-token-dialog").showModal();
};
$("#swift-token-dialog").addEventListener("close", () =>
  $("#swift-token-form").reset(),
);
$("#swift-token-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const id = event.target.dataset.profile;
    state.profiles = await api["connection:refresh-swift"]({
      id,
      token: $("#swift-token").value,
    });
    if (state.profile?.id === id)
      state.profile = state.profiles.find((profile) => profile.id === id);
    renderConnections();
    $("#swift-token-form").reset();
    $("#swift-token-dialog").close();
    toast("Swift token updated. You can resume your queued batches.");
    if (state.profile?.id === id) {
      if (state.bucket) await loadFiles();
      else await listBuckets();
    }
  } catch (error) {
    $("#swift-token-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$("#forget").onclick = act(async () => {
  if (!confirm(`Remove ${state.profile.name} from this device?`)) return;
  state.profiles = await api["connection:remove"](state.profile.id);
  state.profile = null;
  state.bucket = "";
  state.request++;
  renderConnections();
  $("#browser").hidden = true;
  $("#welcome").hidden = false;
  $("#workspace-name").textContent = "Overview";
});
$("#bucket-form").onsubmit = act(async (e) => {
  e.preventDefault();
  await openBucket($("#direct-bucket").value);
});
$("#bucket-select").onchange = act(() => openBucket($("#bucket-select").value));
$("#list-buckets").onclick = act(listBuckets);
$("#refresh").onclick = act(loadFiles);
$("#search").oninput = renderFiles;
$("#previous").onclick = act(async () => {
  if (state.page > 0) {
    state.page--;
    await loadFiles();
  }
});
$("#next").onclick = act(async () => {
  if (state.listing?.token) {
    state.tokens[++state.page] = state.listing.token;
    await loadFiles();
  }
});
$("#upload-prefix").oninput = updateExample;
$("#upload-form").onsubmit = async (e) => {
  e.preventDefault();
  const b = e.submitter;
  b.disabled = true;
  const data = Object.fromEntries(new FormData(e.target));
  try {
    const promise = api.scan({
      ...data,
      folder: data.folder === "true",
      overwrite: data.overwrite === "true",
      concurrency: Number(data.concurrency),
      profile: state.uploadContext.profile,
      bucket: state.uploadContext.bucket,
    });
    $("#upload-dialog").close();
    view("queue");
    toast("Choose your source. Large folder scans may take a moment.");
    const id = await promise;
    await refreshJobs();
    if (id) toast("Scan complete. Review your batch and choose Start upload.");
  } catch (e) {
    toast(`Scan failed: ${e.message}`);
    await refreshJobs();
  } finally {
    b.disabled = false;
  }
};
$("#details-filter").onchange = act(async () => {
  state.detailsOffset = 0;
  await loadDetails();
});
$("#details-prev").onclick = act(async () => {
  state.detailsOffset = Math.max(0, state.detailsOffset - 100);
  await loadDetails();
});
$("#details-next").onclick = act(async () => {
  state.detailsOffset += 100;
  await loadDetails();
});
// workflows.js supplies loadLocations; wait for both scripts to finish loading.
window.addEventListener(
  "DOMContentLoaded",
  act(async () => {
    const initial = await api.init();
    state.profiles = initial.profiles;
    $("#remember").checked = initial.secure;
    $("#keyring-note").textContent = initial.secure
      ? "Saved credentials are encrypted using your operating system’s secure storage."
      : "No secure OS keyring detected. Connections can be used for this session without saving credentials.";
    renderConnections();
    await loadLocations();
    $("#queue-auto").checked = (await api["queue:status"]()).auto;
    await refreshJobs();
  }),
  { once: true },
);
let polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    await refreshJobs();
  } catch (e) {
    toast(e.message);
  } finally {
    polling = false;
  }
}, 1200);

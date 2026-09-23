// Additional browser workflows share the renderer's state and escaping helpers.
const locationContext = () => ({
  profile: state.profile?.id,
  bucket: state.bucket,
  prefix: state.prefix,
});
const sameLocation = (ctx) =>
  ctx.profile === state.profile?.id &&
  ctx.bucket === state.bucket &&
  ctx.prefix === state.prefix;
const duration = (seconds) =>
  seconds < 60
    ? `${Math.ceil(seconds)}s`
    : seconds < 3600
      ? `${Math.ceil(seconds / 60)}m`
      : `${(seconds / 3600).toFixed(1)}h`;
let workflowGeneration = 0;
let objectGeneration = 0;
function workflow(title, html) {
  workflowGeneration++;
  $("#workflow-title").textContent = title;
  $("#workflow-body").innerHTML = html;
  $("#workflow-error").textContent = "";
  if (!$("#workflow-dialog").open) $("#workflow-dialog").showModal();
  return workflowGeneration;
}
function modalAction(selector, fn, error = "#workflow-error") {
  const button = $(selector);
  let pending = false;
  button.onclick = async (event) => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    const previousLabel = button.textContent;
    button.textContent = "Working…";
    const dialog = button.closest("dialog");
    const controls = [
      ...dialog.querySelectorAll("button,input,select,textarea"),
    ].map((el) => [el, el.disabled]);
    controls.forEach(([el]) => (el.disabled = true));
    const preventClose = (event) => event.preventDefault();
    dialog.addEventListener("cancel", preventClose);
    $(error).textContent = "";
    try {
      await fn();
    } catch (e) {
      $(error).textContent = e.message;
    } finally {
      pending = false;
      button.textContent = previousLabel;
      controls.forEach(([el, disabled]) => (el.disabled = disabled));
      dialog.removeEventListener("cancel", preventClose);
    }
  };
}
function requireLocation() {
  if (!state.profile || !state.bucket) {
    toast("Open a bucket first.");
    return false;
  }
  return true;
}
function renderSelection() {
  for (const input of $("#files").querySelectorAll("[data-select]"))
    input.closest("tr").classList.toggle("selected-row", input.checked);
  const count = state.selection.size;
  $("#selection-count").textContent = `${count} selected`;
  for (const name of ["download", "copy", "move", "delete"])
    $("#bulk-" + name).disabled = !count;
  const rows = state.visibleRows || [];
  const selected = rows.filter((row) => state.selection.has(row.key)).length;
  $("#select-all").disabled = !rows.length;
  $("#select-all").checked = rows.length > 0 && selected === rows.length;
  $("#select-all").indeterminate = selected > 0 && selected < rows.length;
  for (const name of [
    "create-folder",
    "sync-open",
    "multipart-open",
    "bookmark",
  ])
    $("#" + name).disabled = !state.bucket;
}
$("#select-all").onchange = () => {
  for (const row of state.visibleRows || []) {
    if ($("#select-all").checked)
      state.selection.set(row.key, { key: row.key, folder: row.folder });
    else state.selection.delete(row.key);
  }
  renderFiles();
};
for (const button of document.querySelectorAll("[data-sort]"))
  button.onclick = () => {
    state.sortDirection =
      state.sort === button.dataset.sort ? -state.sortDirection : 1;
    state.sort = button.dataset.sort;
    for (const header of document.querySelectorAll("[data-sort]"))
      header
        .closest("th")
        .setAttribute(
          "aria-sort",
          header === button
            ? state.sortDirection === 1
              ? "ascending"
              : "descending"
            : "none",
        );
    renderFiles();
  };
$("#prefix-form").onsubmit = act(async (event) => {
  event.preventDefault();
  if (!requireLocation()) return;
  const prefix = $("#prefix-input").value;
  await navigate(prefix && !prefix.endsWith("/") ? prefix + "/" : prefix);
});
$("#recursive-search").onclick = act(async () => {
  if (!requireLocation()) return;
  const query = $("#search").value.trim();
  if (!query) {
    toast("Enter a search term, then choose Search prefix.");
    return;
  }
  state.searchQuery = query;
  state.tokens = [null];
  state.page = 0;
  await loadFiles();
});
$("#clear-search").onclick = act(() => navigate(state.prefix));
async function loadLocations() {
  state.locations = await api["locations:get"]();
  renderLocations();
}
function renderLocations() {
  const rows = [
    ...(state.locations.bookmarks || []).map((l) => ({ ...l, saved: true })),
    ...(state.locations.recent || []).slice(0, 6),
  ];
  $("#locations").innerHTML =
    rows
      .map(
        (l, i) =>
          `<button data-location="${i}" title="${esc(state.profiles.find((p) => p.id === l.profile)?.name || "Unavailable connection")} / ${esc(l.bucket)}/${esc(l.prefix)}"><span>${l.saved ? "★" : "◷"}</span><span>${esc(l.bucket)}/${esc(l.prefix)}</span></button>`,
      )
      .join("") ||
    '<p class="form-note">Bookmark a bucket or folder to keep it here.</p>';
  for (const button of $("#locations").querySelectorAll("button"))
    button.onclick = act(async () => {
      const loc = rows[+button.dataset.location];
      if (!state.profiles.some((p) => p.id === loc.profile)) {
        toast("This location’s connection is no longer available.");
        return;
      }
      if (state.profile?.id !== loc.profile)
        await selectConnection(loc.profile);
      await openBucket(loc.bucket);
      if (loc.prefix) await navigate(loc.prefix);
    });
  const ctx = locationContext();
  $("#bookmark").textContent = (state.locations.bookmarks || []).some(
    (l) =>
      l.profile === ctx.profile &&
      l.bucket === ctx.bucket &&
      l.prefix === ctx.prefix,
  )
    ? "★ Bookmarked"
    : "☆ Bookmark";
}
async function visitLocation() {
  state.locations = await api["locations:visit"](locationContext());
  renderLocations();
}
$("#bookmark").onclick = act(async () => {
  if (!requireLocation()) return;
  state.locations = await api["locations:bookmark"](locationContext());
  renderLocations();
});
async function download(key) {
  return queueDownloads([{ key, folder: false }]);
}
function queueDownloads(selection) {
  const ctx = locationContext();
  workflow(
    "Download selected objects",
    `<p class="destination">${esc(ctx.bucket)}/${esc(ctx.prefix)}</p><p>${selection.length} selected items. Folders include all objects beneath them, across every page. Relative paths are preserved inside the chosen local folder.</p><label>Existing local files<select id="download-overwrite"><option value="false">Skip existing files</option><option value="true">Replace existing files</option></select></label><div class="modal-footer"><button id="download-choose" class="primary">Choose destination & queue →</button></div>`,
  );
  modalAction("#download-choose", async () => {
    const id = await api["download:queue"]({
      ...ctx,
      selection,
      overwrite: $("#download-overwrite").value === "true",
      concurrency: 6,
    });
    if (!id) return;
    $("#workflow-dialog").close();
    view("queue");
    await refreshJobs();
    toast("Download queued. Review the batch, then start it.");
  });
}
$("#bulk-download").onclick = () =>
  queueDownloads([...state.selection.values()]);
$("#create-folder").onclick = () => {
  if (!requireLocation()) return;
  const ctx = locationContext();
  workflow(
    "Create folder",
    `<p class="destination">${esc(ctx.bucket)}/${esc(ctx.prefix)}</p><label>Folder name<input id="folder-name" placeholder="new-folder" /></label><div class="modal-footer"><button id="folder-create" class="primary">Create folder</button></div>`,
  );
  modalAction("#folder-create", async () => {
    const name = $("#folder-name").value.trim();
    if (!name || name.includes("/") || name === "." || name === "..")
      throw Error("Enter a single folder name without slashes.");
    await api["folder:create"]({ ...ctx, prefix: ctx.prefix + name + "/" });
    $("#workflow-dialog").close();
    if (sameLocation(ctx)) await loadFiles();
    toast("Folder created.");
  });
};
for (const action of ["copy", "move", "delete"])
  $("#bulk-" + action).onclick = () => previewOperation(action);
function previewOperation(action) {
  if (!state.selection.size) return;
  const ctx = locationContext(),
    selection = [...state.selection.values()];
  workflow(
    `${action[0].toUpperCase() + action.slice(1)} selected objects`,
    `<p class="destination">${esc(ctx.bucket)}/${esc(ctx.prefix)}</p><p>${selection.length} selected items. Folder selections expand to every object below the prefix.</p>${action === "delete" ? '<p class="warning">Deletion cannot be undone in buckets without versioning.</p>' : `<label>Destination bucket<input id="operation-bucket" value="${esc(ctx.bucket)}" /></label><label>Destination prefix<input id="operation-prefix" placeholder="destination/" /></label><p class="form-note">Paths relative to the current prefix are preserved. Existing destination objects are never replaced; conflicts fail safely.</p>`}<div class="modal-footer"><button id="operation-preview" class="primary">Preview exact changes →</button></div>`,
  );
  modalAction("#operation-preview", async () => {
    const options = { ...ctx, sourcePrefix: ctx.prefix, selection, action };
    if (action !== "delete") {
      options.destinationBucket = $("#operation-bucket").value.trim();
      options.destinationPrefix = $("#operation-prefix").value;
      if (!options.destinationBucket)
        throw Error("Enter a destination bucket.");
    }
    const { token, plan } = await api["operations:preview"](options);
    const items = plan.items || [];
    workflow(
      "Review " + action,
      `<p class="destination">${esc(ctx.bucket)}/${esc(ctx.prefix)}</p><p>${items.length} objects will be ${action === "copy" ? "copied" : action === "move" ? "moved" : "deleted"}${action === "delete" ? "" : ` into ${esc(plan.destinationBucket || options.destinationBucket)}/${esc(plan.destinationPrefix ?? options.destinationPrefix)}`}.</p><div class="review-list">${items.map((item) => `<div class="detail-row"><b>${esc(item.key)}</b>${action === "delete" ? "" : `<small>→ ${esc(item.destinationKey ?? item.targetKey ?? ((plan.destinationPrefix ?? options.destinationPrefix).replace(/\/?$/, "/") + item.key.slice(ctx.prefix.length)).replace(/^\//, ""))}</small>`}<small>${bytes(item.size)}</small></div>`).join("") || "<p>No matching objects.</p>"}</div><p class="warning">${action === "delete" ? "Confirm deletion of the exact objects listed above." : action === "move" ? "Each source is deleted only after its copy succeeds. Existing destination objects are never replaced; conflicts fail safely." : "Existing destination objects are never replaced; conflicts fail safely."}</p><div class="modal-footer"><button id="operation-execute" class="${action === "delete" ? "danger" : "primary"}" ${items.length ? "" : "disabled"}>Confirm ${action} of ${items.length} objects</button></div>`,
    );
    modalAction("#operation-execute", async () => {
      const result = await api["operations:execute"](token);
      workflow(
        "Operation result",
        `<p>${result.succeeded} of ${result.total} objects succeeded · ${result.failed} failed</p><p class="form-note">${result.copied} copied · ${result.deleted} deleted</p><div class="review-list">${(result.failures || []).map((item) => `<div class="detail-row"><b>${esc(item.key)}</b>${item.destinationKey ? `<small>→ ${esc(item.destinationKey)}</small>` : ""}<p>${esc(item.stage)}: ${esc(item.error)}</p></div>`).join("")}</div>`,
      );
      if (sameLocation(ctx)) await loadFiles();
    });
  });
}
function transferSettings(job) {
  if (!job) return;
  workflow(
    "Transfer settings",
    `<p class="destination">${esc(job.bucket)}/${esc(job.prefix)}</p><div class="form-grid"><label>Concurrent files<input id="setting-concurrency" type="number" min="1" max="16" value="${job.concurrency}" /></label><label>Bandwidth limit (MiB/s)<input id="setting-bandwidth" type="number" min="0" step="0.1" value="${(job.bandwidth || 0) / 1048576}" /></label></div><label>Additional attempts per failed file<input id="setting-retries" type="number" min="0" max="10" value="${job.retries ?? 2}" /></label><p class="form-note">Zero bandwidth means unlimited. The limit is shared across this batch’s workers.</p><div class="modal-footer"><button id="settings-save" class="primary">Save settings</button></div>`,
  );
  modalAction("#settings-save", async () => {
    const concurrency = Number($("#setting-concurrency").value),
      bandwidth = Number($("#setting-bandwidth").value) * 1048576,
      retries = Number($("#setting-retries").value);
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 16 ||
      !Number.isFinite(bandwidth) ||
      bandwidth < 0 ||
      !Number.isInteger(retries) ||
      retries < 0 ||
      retries > 10
    )
      throw Error(
        "Use 1–16 workers, a nonnegative bandwidth, and 0–10 retries.",
      );
    await api["queue:configure"](job.id, {
      concurrency,
      bandwidth: Math.round(bandwidth),
      retries,
    });
    $("#workflow-dialog").close();
    await refreshJobs();
  });
}
$("#queue-auto").onchange = act(async () => {
  const input = $("#queue-auto"),
    next = input.checked;
  input.disabled = true;
  try {
    input.checked = await api["queue:auto"](next);
  } catch (e) {
    input.checked = !next;
    throw e;
  } finally {
    input.disabled = false;
  }
});
$("#sync-open").onclick = () => {
  if (!requireLocation()) return;
  const ctx = locationContext();
  workflow(
    "Sync a local folder to S3",
    `<p class="destination">${esc(ctx.bucket)}/${esc(ctx.prefix)}</p><p>Upload the selected local folder’s contents into this prefix. New and changed files are uploaded. Review every proposed change before applying.</p><label class="inline-check"><input id="sync-delete" type="checkbox" /> Delete remote objects missing locally</label><p class="form-note">Remote deletion is off by default. When selected, reviewed deletions run only after all uploads succeed.</p><div class="modal-footer"><button id="sync-compare" class="primary">Choose local folder & compare →</button></div>`,
  );
  modalAction("#sync-compare", async () => {
    const result = await api["sync:compare"]({
      ...ctx,
      deleteRemote: $("#sync-delete").checked,
    });
    if (!result) return;
    const { token, plan } = result;
    const uploads = plan.entries || [],
      deletions = plan.deletions || [];
    workflow(
      "Review folder sync",
      `<p class="destination">${esc(plan.source)} → ${esc(ctx.bucket)}/${esc(ctx.prefix)}</p><p>${uploads.length} uploads · ${deletions.length} remote deletions</p><div class="review-list">${(plan.rows || []).map((row) => `<div class="detail-row"><b>${esc(row.key)}</b><small>${esc(row.status)} · ${esc(row.reason || "")}</small></div>`).join("")}</div>${deletions.length ? '<p class="warning">The remote deletions shown above are included in this sync.</p>' : ""}<div class="modal-footer"><button id="sync-apply" class="primary" ${uploads.length || deletions.length ? "" : "disabled"}>Confirm & queue sync</button></div>`,
    );
    modalAction("#sync-apply", async () => {
      await api["sync:apply"](token);
      $("#workflow-dialog").close();
      view("queue");
      await refreshJobs();
      toast("Sync queued. Start the reviewed batch in Transfers.");
    });
  });
};
async function openObject(key) {
  const ctx = { ...locationContext(), key };
  const generation = ++objectGeneration;
  $("#object-error").textContent = "";
  $("#object-body").textContent = "Loading object details…";
  if (!$("#object-dialog").open) $("#object-dialog").showModal();
  try {
    const info = await api["objects:details"](ctx);
    if (generation !== objectGeneration || !$("#object-dialog").open) return;
    $("#object-body").innerHTML =
      `<p class="destination">${esc(ctx.bucket)}/${esc(key)}</p><dl class="object-facts"><dt>Size</dt><dd>${bytes(info.size)}</dd><dt>Modified</dt><dd>${esc(info.modified ? new Date(info.modified).toLocaleString() : "—")}</dd><dt>ETag</dt><dd>${esc(info.etag || "—")}</dd><dt>Version</dt><dd>${esc(info.versionId || "—")}</dd><dt>Storage class</dt><dd>${esc(info.storageClass || "Standard")}</dd></dl><details><summary>Edit metadata</summary><label>Content type<input id="object-content-type" value="${esc(info.contentType || "application/octet-stream")}" /></label><label>User metadata (JSON object)<textarea id="object-metadata" rows="5" spellcheck="false">${esc(JSON.stringify(info.metadata || {}, null, 2))}</textarea></label><p class="form-note">Saving replaces the user metadata map and rewrites the object with server-side copy.</p><label class="inline-check"><input id="metadata-confirm" type="checkbox" /> I reviewed the replacement metadata</label><button id="metadata-save">Save metadata</button></details><details><summary>Temporary download link</summary><label>Expires in seconds<input id="url-expiry" type="number" min="1" max="604800" value="3600" /></label><button id="url-create">Generate link</button><label id="url-result-label" hidden>Anyone with this link can download until it expires<input id="url-result" readonly /></label><button id="url-copy" hidden>Copy link</button></details><details><summary>Object versions</summary><p class="form-note">Restoring copies a selected version to a new current version. Delete markers cannot be restored.</p><button id="versions-load">Load versions</button><div id="versions-list"></div><button id="versions-more" hidden>Load more versions</button></details>`;
    modalAction(
      "#metadata-save",
      async () => {
        if (!$("#metadata-confirm").checked)
          throw Error("Review the metadata and check the confirmation box.");
        let metadata;
        try {
          metadata = JSON.parse($("#object-metadata").value);
        } catch {
          throw Error("Metadata must be valid JSON.");
        }
        if (
          !metadata ||
          Array.isArray(metadata) ||
          typeof metadata !== "object" ||
          Object.values(metadata).some((v) => typeof v !== "string")
        )
          throw Error("Metadata must be a JSON object with string values.");
        const contentType = $("#object-content-type").value.trim();
        if (!contentType) throw Error("Enter a content type.");
        await api["objects:metadata"]({ ...ctx, metadata, contentType });
        toast("Metadata saved.");
        await openObject(key);
      },
      "#object-error",
    );
    modalAction(
      "#url-create",
      async () => {
        const expiresIn = Number($("#url-expiry").value);
        if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800)
          throw Error("Expiry must be from 1 to 604800 seconds.");
        const result = await api["objects:url"]({ ...ctx, expiresIn });
        $("#url-result").value =
          typeof result === "string" ? result : result.url;
        $("#url-result-label").hidden = false;
        $("#url-copy").hidden = false;
      },
      "#object-error",
    );
    modalAction(
      "#url-copy",
      async () => {
        try {
          await api["objects:copy-url"]({ url: $("#url-result").value });
          toast("Temporary link copied.");
        } catch {
          $("#url-result").select();
          throw Error(
            "Clipboard access failed. Select and copy the link above.",
          );
        }
      },
      "#object-error",
    );
    let versions = [],
      markers = {};
    const loadVersions = async () => {
      const result = await api["objects:versions"]({ ...ctx, ...markers });
      if (generation !== objectGeneration) return;
      versions.push(...result.versions);
      markers = {
        keyMarker: result.keyMarker,
        versionIdMarker: result.versionIdMarker,
      };
      $("#versions-load").hidden = true;
      $("#versions-more").hidden = !result.keyMarker;
      $("#versions-list").innerHTML =
        versions
          .map(
            (version, i) =>
              `<div class="detail-row"><b>${esc(version.versionId)}</b><small>${esc(version.modified ? new Date(version.modified).toLocaleString() : "")} · ${version.deleteMarker ? "Delete marker" : bytes(version.size)}${version.isLatest ? " · Current" : ""}</small>${!version.deleteMarker && !version.isLatest ? `<button data-restore="${i}">Restore this version</button>` : ""}</div>`,
          )
          .join("") || "<p>No versions returned.</p>";
      for (const button of $("#versions-list").querySelectorAll(
        "[data-restore]",
      ))
        modalAction(
          `[data-restore="${button.dataset.restore}"]`,
          async () => {
            const version = versions[+button.dataset.restore];
            if (
              !confirm(
                `Restore version ${version.versionId} of ${ctx.bucket}/${ctx.key} as the current object?`,
              )
            )
              return;
            await api["objects:restore"]({
              ...ctx,
              versionId: version.versionId,
            });
            toast("Version restored.");
            await openObject(key);
            if (sameLocation(ctx)) await loadFiles();
          },
          "#object-error",
        );
    };
    modalAction("#versions-load", loadVersions, "#object-error");
    modalAction("#versions-more", loadVersions, "#object-error");
  } catch (e) {
    if (generation === objectGeneration) {
      $("#object-body").textContent = `${ctx.bucket}/${key}`;
      $("#object-error").textContent = e.message;
    }
  }
}
$("#multipart-open").onclick = () => {
  if (!requireLocation()) return;
  const ctx = locationContext();
  const generation = workflow(
    "Incomplete multipart uploads",
    `<p class="destination">${esc(ctx.bucket)}/${esc(ctx.prefix)}</p><p>List incomplete multipart uploads beneath this prefix. Aborting selected uploads discards their uploaded parts. It does not delete completed objects.</p><p class="warning">Active uploads may appear here. Review the key, upload ID, and start time before aborting.</p><button id="multipart-load">List uploads</button><div id="multipart-list" class="review-list"></div><button id="multipart-more" hidden>Load more uploads</button><div class="modal-footer"><button id="multipart-review" disabled>Review selected uploads →</button></div>`,
  );
  let uploads = [],
    markers = {},
    selected = new Set();
  const load = async () => {
    const result = await api["objects:multipart"]({ ...ctx, ...markers });
    if (generation !== workflowGeneration) return;
    uploads.push(...result.uploads);
    markers = {
      keyMarker: result.keyMarker,
      uploadIdMarker: result.uploadIdMarker,
    };
    $("#multipart-load").hidden = true;
    $("#multipart-more").hidden = !result.keyMarker;
    $("#multipart-list").innerHTML =
      uploads
        .map(
          (upload, i) =>
            `<label class="detail-row inline-check"><input type="checkbox" data-multipart="${i}" ${selected.has(i) ? "checked" : ""} /><span>${esc(upload.key)}<small>Upload ID: ${esc(upload.uploadId)} · ${esc(upload.initiated ? new Date(upload.initiated).toLocaleString() : "Unknown start time")}</small></span></label>`,
        )
        .join("") || "<p>No incomplete multipart uploads found.</p>";
    for (const input of $("#multipart-list").querySelectorAll("input"))
      input.onchange = () => {
        if (input.checked) selected.add(+input.dataset.multipart);
        else selected.delete(+input.dataset.multipart);
        $("#multipart-review").disabled = !selected.size;
      };
  };
  modalAction("#multipart-load", load);
  modalAction("#multipart-more", load);
  modalAction("#multipart-review", async () => {
    const chosen = [...selected].map((index) => uploads[index]);
    if (!chosen.length) throw Error("Select at least one upload.");
    workflow(
      "Confirm multipart cleanup",
      `<p>${chosen.length} incomplete uploads will be aborted. Their uploaded parts will be discarded.</p><div class="review-list">${chosen.map((upload) => `<div class="detail-row"><b>${esc(upload.key)}</b><small>${esc(upload.uploadId)} · ${esc(upload.initiated || "")}</small></div>`).join("")}</div><div class="modal-footer"><button id="multipart-abort" class="danger">Abort ${chosen.length} selected uploads</button></div>`,
    );
    modalAction("#multipart-abort", async () => {
      const failures = [];
      let completed = 0;
      for (const upload of chosen) {
        try {
          await api["objects:abort"]({
            ...ctx,
            key: upload.key,
            uploadId: upload.uploadId,
          });
          completed++;
        } catch (e) {
          failures.push({ ...upload, error: e.message });
        }
      }
      workflow(
        "Multipart cleanup result",
        `<p>${completed} uploads aborted · ${failures.length} failed</p><div class="review-list">${failures.map((item) => `<div class="detail-row"><b>${esc(item.key)}</b><small>${esc(item.uploadId)}</small><p>${esc(item.error)}</p></div>`).join("")}</div>`,
      );
    });
  });
};

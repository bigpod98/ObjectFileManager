const { contextBridge, ipcRenderer } = require("electron");
const channels = [
  "init",
  "connection:add",
  "connection:remove",
  "connection:refresh-swift",
  "buckets",
  "browse",
  "scan",
  "jobs",
  "entries",
  "start",
  "pause",
  "retry",
  "remove",
  "download:queue",
  "folder:create",
  "operations:preview",
  "operations:execute",
  "objects:search",
  "objects:details",
  "objects:versions",
  "objects:restore",
  "objects:metadata",
  "objects:url",
  "objects:copy-url",
  "objects:multipart",
  "objects:abort",
  "locations:get",
  "locations:bookmark",
  "locations:visit",
  "sync:compare",
  "sync:apply",
  "queue:configure",
  "queue:cancel",
  "queue:export",
  "queue:auto",
  "queue:status",
];
contextBridge.exposeInMainWorld(
  "s3",
  Object.fromEntries(
    channels.map((channel) => [
      channel,
      async (...args) => {
        const result = await ipcRenderer.invoke(channel, ...args);
        if (!result.ok) throw new Error(result.error);
        return result.value;
      },
    ]),
  ),
);

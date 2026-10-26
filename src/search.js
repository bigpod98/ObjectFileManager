// Keep matching identical in the main process and the renderer, regardless of
// their runtime locales. Object keys retain their original Unicode spelling.
(function () {
  const objectSearch = { foldSearch: (text) => text.toLowerCase() };
  if (typeof module === "object" && module.exports)
    module.exports = objectSearch;
  else globalThis.objectSearch = objectSearch;
})();

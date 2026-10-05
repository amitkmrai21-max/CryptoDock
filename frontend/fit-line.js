// Keeps the page notes and the disclaimer on one line: when the text is
// wider than its box, the font steps down (to 8.5px at the smallest).
// If it still doesn't fit — e.g. a long AI disclaimer — it wraps instead.
(function cryptoFitLine() {
  const MIN_PX = 8.5;
  const boxes = () => document.querySelectorAll("#btcModeRoot .cd-page-notes, #btcModeRoot .disclaimer-card");

  function fit(box) {
    if (!box.clientWidth) return; // hidden page; fitted when it shows
    box.classList.remove("is-wrapped");
    const parts = box.matches(".disclaimer-card") ? [...box.querySelectorAll("p")] : [box];
    parts.forEach((p) => { p.style.fontSize = ""; });
    let size = parseFloat(getComputedStyle(parts[0]).fontSize);
    while (box.scrollWidth > box.clientWidth + 1 && size > MIN_PX) {
      size = Math.max(MIN_PX, size - 0.5);
      parts.forEach((p) => { p.style.fontSize = size + "px"; });
    }
    if (box.scrollWidth > box.clientWidth + 1) box.classList.add("is-wrapped");
  }

  const fitAll = () => boxes().forEach(fit);
  const observer = window.ResizeObserver ? new ResizeObserver((entries) => entries.forEach((e) => fit(e.target))) : null;
  boxes().forEach((box) => {
    if (observer) observer.observe(box);
    // The AI pages rewrite the disclaimer text.
    new MutationObserver(() => fit(box)).observe(box, { childList: true, subtree: true, characterData: true });
  });
  window.addEventListener("resize", fitAll);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAll);
  fitAll();
})();

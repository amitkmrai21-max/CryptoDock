// Neutral wording for the Technical page: the engine works in BUY / SELL /
// HOLD internally, but what people read is market description — Bullish,
// Bearish, Neutral — never a recommendation to buy or sell. Paper-trading
// Buy / Sell buttons elsewhere in the app are untouched.
(function cryptoNeutralTerms() {
  const roots = () => document.querySelectorAll('.tab-panel[data-panel="technical"], .cd-legacy-dashboard');
  const RULES = [
    [/\bSTRONG BUY\b/g, "STRONG BULLISH"],
    [/\bSTRONG SELL\b/g, "STRONG BEARISH"],
    [/\bBUY\b/g, "BULLISH"],
    [/\bSELL\b/g, "BEARISH"],
    [/\bHOLD\b/g, "NEUTRAL"],
    [/\bNO TRADE\b/gi, "NO CLEAR SETUP"],
    [/\bWAIT FOR TRIGGER\b/g, "DEVELOPING"],
    [/\bWAIT \/ LOW QUALITY\b/g, "WEAK ALIGNMENT"],
    [/\bREADY\b/g, "ALIGNED"],
    [/\bAVOID\b/g, "MIXED"],
    [/\bRisk\/reward feasibility\b/gi, "Room to next levels"],
    [/\s*(Do not enter|Avoid forcing a (practice )?(entry|trade))[^.]*\.?/gi, ""],
    [/\bbefore (a directional |any )?practice trade\b/gi, ""],
    [/\bTake[- ]profit\b/gi, "Next level"],
    [/\bStop[- ]loss\b/gi, "Invalidation"],
    [/\s*Run Gemini AI Analysis[^.]*\.?/gi, ""],
    [/\bGemini( AI)?\b/gi, "the engine"],
  ];
  const clean = (text) => RULES.reduce((t, [re, to]) => t.replace(re, to), text);

  function scrub(node) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const next = clean(t.nodeValue);
      if (next !== t.nodeValue) t.nodeValue = next; // unchanged text isn't rewritten, so no loop
    }
  }

  let queued = false;
  const run = () => { queued = false; roots().forEach(scrub); };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(run); } };
  roots().forEach((root) => new MutationObserver(schedule).observe(root, { childList: true, subtree: true, characterData: true }));
  run();
})();

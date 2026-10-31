// Messenger + paper-trader leaderboard. Everything is public (no private chats) and people
// appear only by the nickname they chose. The server (main.py /api/community/*) refuses
// links, phone numbers and contact handles.
(function cryptoCommunity() {
  const $ = (id) => document.getElementById(id);
  if (!$("cdCmFeed")) return;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n, d = 2) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });
  const signed = (n, d = 2) => (n > 0 ? "+" : n < 0 ? "-" : "") + num(Math.abs(n), d);
  const ago = (ts) => {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  const email = () => (typeof window.cdUserEmail === "string" ? window.cdUserEmail : "");
  const pageOpen = () => document.querySelector(".tab-panel.active")?.dataset.panel === "community";
  const homeOpen = () => document.querySelector(".tab-panel.active")?.dataset.panel === "dashboard";

  let me = null;          // { nick, on_board, is_owner }
  let board = null;       // leaderboard response
  let posts = [], replies = [], more = false;
  let mode = "text";      // composer: "text" | "idea"
  let replyTo = null;     // { id, nick }
  let editing = false;

  async function api(path, options = {}) {
    const client = window.marketDockSupabase;
    let token = "";
    try { const { data } = await client.auth.getSession(); token = data?.session?.access_token || ""; } catch (e) { /* signed out */ }
    if (!token) throw new Error("Sign in first.");
    const res = await fetch(path, {
      ...options,
      cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Something went wrong. Try again.");
    return data;
  }
  const toast = (msg) => { if (typeof window.cdToast === "function") window.cdToast(msg); else setStatus(msg); };
  function setStatus(msg, bad) { const s = $("cdCmStatus"); s.textContent = msg || ""; s.classList.toggle("is-bad", !!bad); }

  // ---------- join / nickname ----------
  function renderJoin() {
    const signedIn = !!email();
    $("cdCmGuest").hidden = signedIn;
    $("cdCmMain").hidden = !signedIn;
    if (!signedIn) return;
    const has = !!(me && me.nick);
    $("cdCmJoin").hidden = has && !editing;
    $("cdCmMeLine").hidden = !has || editing;
    $("cdCmCompose").hidden = !has;
    if (has) {
      $("cdCmMeNick").textContent = "@" + me.nick;
      $("cdCmNick").value = me.nick;
      $("cdCmOnBoard").checked = !!me.on_board;
    }
  }

  async function saveProfile() {
    const nick = $("cdCmNick").value.trim();
    $("cdCmSave").disabled = true;
    try {
      me = { ...(me || {}), ...(await api("/api/community/me", { method: "PUT", body: { nick, on_board: $("cdCmOnBoard").checked } })) };
      editing = false;
      setStatus("");
      await loadBoard();
      renderJoin();
    } catch (e) { $("cdCmJoinErr").textContent = e.message; }
    $("cdCmSave").disabled = false;
  }

  // ---------- leaderboard ----------
  const medal = (r) => (r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : r);
  function boardRows(top, meRow, limit) {
    return top.slice(0, limit).map((r) => {
      const mine = me && r.nick === me.nick;
      return `<li class="cd-lb-row${mine ? " is-me" : ""}">
        <span class="cd-lb-rank">${medal(r.rank)}</span>
        <button type="button" class="cd-lb-nick" data-nick="${esc(r.nick)}" title="Ask ${esc(r.nick)}">@${esc(r.nick)}${mine ? " (you)" : ""}</button>
        <span class="cd-lb-orders">${r.orders} orders</span>
        <b class="${r.ret >= 0 ? "cd-up" : "cd-down"}">${signed(r.ret)}%</b>
      </li>`;
    }).join("");
  }
  function renderBoard() {
    const box = $("cdCmBoardList");
    if (!board) { box.innerHTML = '<li class="cd-meta">Loading…</li>'; return; }
    if (!board.top.length) {
      box.innerHTML = `<li class="cd-meta cd-hx-empty">No one is on the board yet. Join and place at least ${board.min_orders} paper orders to appear.</li>`;
    } else {
      const inTop = me && board.top.some((r) => r.nick === me.nick);
      box.innerHTML = boardRows(board.top, board.me, 10)
        + (board.me && !inTop ? `<li class="cd-lb-row is-me"><span class="cd-lb-rank">#${board.me.rank}</span><span class="cd-lb-nick">@${esc(board.me.nick)} (you)</span><span class="cd-lb-orders">${board.me.orders} orders</span><b class="${board.me.ret >= 0 ? "cd-up" : "cd-down"}">${signed(board.me.ret)}%</b></li>` : "");
    }
    const hint = $("cdCmBoardHint");
    hint.textContent = me && me.nick && !board.me
      ? (me.on_board ? `Place at least ${board.min_orders} paper orders to appear on the board.` : "You are hidden from the board. Turn on 'Show me on the leaderboard' to join.")
      : "Return = account value vs the 10,000 USDT start. Paper trading only.";
  }
  async function loadBoard() {
    if (!email()) return;
    try { board = await api("/api/community/leaderboard"); } catch (e) { board = board || null; }
    renderBoard();
    renderHome();
  }

  function renderHome() {
    const card = $("cdHomeBoardCard");
    if (!card) return;
    card.hidden = !email() || !board;
    if (card.hidden) return;
    const list = $("cdHomeBoard");
    list.innerHTML = board.top.length ? boardRows(board.top, board.me, 3)
      : '<li class="cd-meta cd-hx-empty">No one is on the board yet. Be the first!</li>';
    if (board.me && !board.top.slice(0, 3).some((r) => me && r.nick === me.nick)) {
      list.insertAdjacentHTML("beforeend", `<li class="cd-lb-row is-me"><span class="cd-lb-rank">#${board.me.rank}</span><span class="cd-lb-nick">@${esc(board.me.nick)} (you)</span><span class="cd-lb-orders">${board.me.orders} orders</span><b class="${board.me.ret >= 0 ? "cd-up" : "cd-down"}">${signed(board.me.ret)}%</b></li>`);
    }
  }

  // ---------- composer ----------
  function setMode(next) {
    mode = next;
    document.querySelectorAll("#cdCmMode button").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === mode));
    $("cdCmIdea").hidden = mode !== "idea";
  }
  function setReply(target) {
    replyTo = target;
    $("cdCmReplyBar").hidden = !target;
    if (target) $("cdCmReplyTo").textContent = "@" + target.nick;
  }
  function mention(nick) {
    if (!me || !me.nick) { setStatus("Choose a nickname to message traders.", true); return; }
    const box = $("cdCmText");
    if (!box.value.includes("@" + nick)) box.value = `@${nick} ${box.value}`.trimEnd() + " ";
    if (typeof window.cdGo === "function") window.cdGo("community");
    else document.querySelector('.sidebar .app-tab[data-tab="community"]')?.click();
    setTimeout(() => { $("cdCmCompose").scrollIntoView({ behavior: "smooth", block: "center" }); box.focus(); }, 150);
  }
  async function send() {
    const body = { text: $("cdCmText").value, reply_to: replyTo ? replyTo.id : 0 };
    if (mode === "idea" && !replyTo) {
      body.idea = {
        coin: $("cdCmCoin").value, side: $("cdCmSide").value,
        entry: Number($("cdCmEntry").value) || 0, exit: Number($("cdCmExit").value) || 0, result: Number($("cdCmResult").value) || 0,
      };
      if (!body.idea.coin.trim()) { setStatus("Enter the coin for your trade idea.", true); return; }
    }
    $("cdCmSend").disabled = true;
    try {
      await api("/api/community/posts", { method: "POST", body });
      $("cdCmText").value = "";
      ["cdCmCoin", "cdCmEntry", "cdCmExit", "cdCmResult"].forEach((id) => { $(id).value = ""; });
      setReply(null);
      setStatus("Posted.");
      await loadFeed();
    } catch (e) { setStatus(e.message, true); }
    $("cdCmSend").disabled = false;
    updateCount();
  }
  function updateCount() { $("cdCmCount").textContent = `${$("cdCmText").value.length}/400`; }

  // ---------- feed ----------
  const withMentions = (t) => esc(t).replace(/@([A-Za-z0-9_]+)/g, '<button type="button" class="cd-cm-tag" data-nick="$1">@$1</button>');
  function ideaHtml(i) {
    if (!i) return "";
    const buy = i.side === "BUY";
    const move = i.entry > 0 && i.exit > 0 ? ((i.exit - i.entry) / i.entry) * 100 * (buy ? 1 : -1) : null;
    return `<div class="cd-cm-idea ${buy ? "is-buy" : "is-sell"}">
      <b class="cd-cm-side">${buy ? "BUY" : "SELL"} ${esc(i.coin)}</b>
      ${i.entry ? `<span>Entry <b>${num(i.entry, 8)}</b></span>` : ""}
      ${i.exit ? `<span>Exit <b>${num(i.exit, 8)}</b></span>` : ""}
      ${move !== null ? `<span class="${move >= 0 ? "cd-up" : "cd-down"}">${signed(move)}%</span>` : ""}
      ${i.result ? `<span class="cd-cm-result ${i.result >= 0 ? "cd-up" : "cd-down"}">${i.result >= 0 ? "Profit" : "Loss"} ${signed(i.result)} USDT</span>` : ""}
    </div>`;
  }
  function postHtml(p, isReply) {
    const canDelete = p.mine || (me && me.is_owner);
    return `<article class="cd-cm-post${isReply ? " is-reply" : ""}" data-id="${p.id}">
      <header><button type="button" class="cd-lb-nick" data-nick="${esc(p.nick)}">@${esc(p.nick)}</button>${p.is_owner ? '<span class="cd-cm-badge">Owner</span>' : ""}<time>${ago(p.at)}</time></header>
      ${ideaHtml(p.idea)}
      ${p.text ? `<p>${withMentions(p.text)}</p>` : ""}
      <footer><button type="button" class="cd-cm-act" data-reply="${p.id}" data-nick="${esc(p.nick)}">Reply</button>${canDelete ? `<button type="button" class="cd-cm-act is-del" data-del="${p.id}">Delete</button>` : ""}<span class="cd-cm-note">Paper trading · not advice</span></footer>
    </article>`;
  }
  function renderFeed() {
    const box = $("cdCmFeed");
    if (!posts.length) { box.innerHTML = '<p class="cd-meta cd-hx-empty">No messages yet. Share your first trade idea!</p>'; }
    else {
      box.innerHTML = posts.map((p) => {
        const kids = replies.filter((r) => r.reply_to === p.id).map((r) => postHtml(r, true)).join("");
        return `<div class="cd-cm-thread">${postHtml(p, false)}${kids}</div>`;
      }).join("");
    }
    $("cdCmMore").hidden = !more;
  }
  async function loadFeed(older) {
    if (!email()) return;
    try {
      const before = older && posts.length ? posts[posts.length - 1].id : 0;
      const data = await api(`/api/community/posts?limit=30${before ? "&before=" + before : ""}`);
      if (older) { posts = posts.concat(data.posts); replies = replies.concat(data.replies); }
      else { posts = data.posts; replies = data.replies; }
      more = data.more;
      renderFeed();
    } catch (e) { setStatus(e.message, true); }
  }

  // ---------- wiring ----------
  document.addEventListener("click", (event) => {
    const nickBtn = event.target.closest("[data-nick].cd-lb-nick, .cd-cm-tag");
    if (nickBtn && nickBtn.dataset.nick) { mention(nickBtn.dataset.nick); return; }
    const reply = event.target.closest("[data-reply]");
    if (reply) { setReply({ id: Number(reply.dataset.reply), nick: reply.dataset.nick }); $("cdCmText").focus(); $("cdCmCompose").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    const del = event.target.closest("[data-del]");
    if (del) {
      if (!window.confirm("Delete this message?")) return;
      api(`/api/community/posts/${del.dataset.del}`, { method: "DELETE" }).then(() => loadFeed()).catch((e) => setStatus(e.message, true));
    }
  });
  $("cdCmSave").addEventListener("click", saveProfile);
  $("cdCmEdit").addEventListener("click", () => { editing = true; $("cdCmJoinErr").textContent = ""; renderJoin(); });
  $("cdCmMode").addEventListener("click", (e) => { const b = e.target.closest("button[data-mode]"); if (b) setMode(b.dataset.mode); });
  $("cdCmReplyX").addEventListener("click", () => setReply(null));
  $("cdCmSend").addEventListener("click", send);
  $("cdCmText").addEventListener("input", updateCount);
  $("cdCmMore").addEventListener("click", () => loadFeed(true));
  $("cdCmRefresh").addEventListener("click", () => { loadBoard(); loadFeed(); });
  $("cdCmSignIn").addEventListener("click", () => document.getElementById("topSettingsMenuButton")?.click());

  async function refreshAll() {
    renderJoin();
    if (!email()) { me = null; board = null; posts = []; replies = []; renderHome(); return; }
    try { me = await api("/api/community/me"); } catch (e) { /* offline */ }
    renderJoin();
    loadBoard();
    if (pageOpen()) loadFeed();
  }

  // Open the page: refresh. While it stays open: every 30 s. Home card: every 2 minutes.
  let lastPage = false;
  setInterval(() => {
    const open = pageOpen();
    if (open && !lastPage) refreshAll();
    else if (open) { loadFeed(); loadBoard(); }
    lastPage = open;
  }, 30000);
  document.addEventListener("click", (event) => {
    if (event.target.closest(".app-tab, #cdTabBar, #cdMoreGrid, [data-go]")) setTimeout(() => { const open = pageOpen(); if (open && !lastPage) refreshAll(); lastPage = open; }, 200);
  });
  setInterval(() => { if (homeOpen() && email()) loadBoard(); }, 120000);
  window.addEventListener("cd-user-changed", () => setTimeout(refreshAll, 400));
  setMode("text");
  updateCount();
  setTimeout(refreshAll, 1500);
})();

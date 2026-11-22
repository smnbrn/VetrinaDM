// Vetrina DM — card browser. Plain JS, no build step.
(() => {
  "use strict";

  const CIVS = ["Light", "Water", "Darkness", "Fire", "Nature", "Zero"];
  const CIV_IT = { Light: "Luce", Water: "Acqua", Darkness: "Oscurità", Fire: "Fuoco", Nature: "Natura", Zero: "Zero" };
  const CIV_HEX = { Light: "#f2d65c", Water: "#3b8fe0", Darkness: "#9b72c0", Fire: "#e0482c", Nature: "#3fa352", Zero: "#9a9eab" };
  const HOLO = new Set(["Very Rare", "Super Rare", "Over Rare", "Dream Rare", "Secret Card", "Master Hazard Card", "Victory Rare", "Legend Rare"]);
  const RARITY_ORDER = ["Common", "Uncommon", "Rare", "Very Rare", "Super Rare", "Over Rare", "Dream Rare"];
  const PAGE = 60; // tiles rendered per chunk (infinite scroll)

  const $ = (id) => document.getElementById(id);
  const el = {
    q: $("q"), count: $("count"), grid: $("grid"), empty: $("empty"), more: $("more"), loading: $("loading"),
    filtersBtn: $("filtersBtn"), filtersBadge: $("filtersBadge"), filters: $("filters"),
    civs: $("civs"), costMin: $("costMin"), costMax: $("costMax"),
    tipo: $("tipo"), set: $("set"), rarita: $("rarita"), formato: $("formato"), sort: $("sort"), reset: $("reset"),
    setsBtn: $("setsBtn"), setsView: $("setsView"), setsList: $("setsList"), cardsView: $("cardsView"),
    setBar: $("setBar"), setBarName: $("setBarName"), setBarClear: $("setBarClear"),
    show: $("show"), wrap: $("wrap"), card: $("card"), cardBtn: $("cardBtn"),
    amb: [...document.querySelectorAll("#amb i")],
    pos: $("pos"), prev: $("prevBtn"), next: $("nextBtn"), info: $("infoBtn"), wiki: $("wikiBtn"), closeBtn: $("closeBtn"),
    sheet: $("sheet"), sheetBody: $("sheetBody"), sheetClose: $("sheetClose"),
    varTitle: $("varTitle"), varList: $("varList"),
  };

  const state = { q: "", civs: new Set(), costMin: null, costMax: null, tipo: "", set: "", rarita: "", formato: "", sort: "nome", vista: "" };
  let cards = [];      // slim records from data/index.json
  let sets = [];       // data/sets.json
  let setMap = new Map();
  let results = [];    // filtered + sorted
  let list = [];       // list the showcase navigates (results, or a single deep-linked card)
  let shown = 0;
  let localImages = new Set(); // ids with downloaded WebP copies (data/images.json), if any

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Lowercase and strip accents so "elementale" matches "Elementàle".
  const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // Fandom CDN resizes on the fly: .../revision/latest/scale-to-width-down/<w>?cb=…
  function cdn(url, width) {
    return url ? url.replace("/revision/latest", `/revision/latest/scale-to-width-down/${width}`) : "";
  }
  // Prefer our own optimised copy of the card's main image when it has been downloaded.
  function cardImg(c, url, width, isMain = true) {
    if (isMain && localImages.has(c.id)) return `images/${width > 300 ? "l" : "t"}/${c.id}.webp`;
    return cdn(url, width);
  }

  const civDot = (c) => `<span class="dot" style="--c:var(--c-${c})" title="${CIV_IT[c] || c}"></span>`;
  const civChip = (c) => `<span class="chip"><i style="--c:var(--c-${c})"></i>${CIV_IT[c] || c}</span>`;
  const numKey = (n) => { const m = /\d+/.exec(n || ""); return m ? (/^\d/.test(n) ? 0 : 1e6) + +m[0] : 2e6; };
  const natural = (a, b) => a.localeCompare(b, "en", { numeric: true });

  // ---------- URL state (shareable links) ----------
  let cur = -1, ambIdx = 0, showTok = 0, varIdx = 0, pushed = false;
  let curDetail = null;

  function writeUrl(mode = "replace", extra = {}) {
    const u = new URLSearchParams();
    if (el.q.value.trim()) u.set("q", el.q.value.trim());
    if (state.civs.size) u.set("civ", [...state.civs].join(","));
    if (state.costMin != null) u.set("cmin", state.costMin);
    if (state.costMax != null) u.set("cmax", state.costMax);
    if (state.tipo) u.set("tipo", state.tipo);
    if (state.set) u.set("set", state.set);
    if (state.rarita) u.set("rar", state.rarita);
    if (state.formato) u.set("fmt", state.formato);
    if (state.sort !== "nome") u.set("sort", state.sort);
    if (state.vista) u.set("vista", state.vista);
    const open = extra.carta !== undefined ? extra.carta : (el.show.hidden ? "" : (list[cur] && list[cur].id));
    if (open) u.set("carta", open);
    const v = extra.v !== undefined ? extra.v : varIdx;
    if (open && v) u.set("v", v);
    const qs = u.toString();
    const url = location.pathname + (qs ? "?" + qs : "");
    if (url === location.pathname + location.search) return false;
    history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
    return true;
  }

  function readUrl() {
    const u = new URLSearchParams(location.search);
    el.q.value = u.get("q") || "";
    state.q = norm(el.q.value).trim();
    state.civs = new Set((u.get("civ") || "").split(",").filter((c) => CIVS.includes(c)));
    const num = (v) => (v == null || v === "" || isNaN(+v) ? null : +v);
    state.costMin = num(u.get("cmin"));
    state.costMax = num(u.get("cmax"));
    state.tipo = u.get("tipo") || "";
    state.set = u.get("set") || "";
    state.rarita = u.get("rar") || "";
    state.formato = ["TCG", "OCG"].includes(u.get("fmt")) ? u.get("fmt") : "";
    state.sort = SORTS[u.get("sort")] ? u.get("sort") : "nome";
    state.vista = u.get("vista") === "set" ? "set" : "";
    return { carta: u.get("carta") || "", v: +(u.get("v") || 0) };
  }

  function syncControls() {
    el.costMin.value = state.costMin == null ? "" : state.costMin;
    el.costMax.value = state.costMax == null ? "" : state.costMax;
    el.tipo.value = state.tipo; el.set.value = state.set; el.rarita.value = state.rarita; el.sort.value = state.sort;
    el.civs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(state.civs.has(b.dataset.civ))));
    el.formato.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === state.formato)));
  }

  // ---------- filtering & sorting ----------
  function matches(c) {
    if (state.q && !state.q.split(/\s+/).every((w) => c._s.includes(w))) return false;
    if (state.civs.size && !c.civilta.some((x) => state.civs.has(x))) return false;
    if (state.costMin != null && (c.costo == null || c.costo < state.costMin)) return false;
    if (state.costMax != null && (c.costo == null || c.costo > state.costMax)) return false;
    if (state.tipo && c.tipo !== state.tipo) return false;
    // Set / rarity / format must hold on the same printing of the card.
    if (state.set || state.rarita || state.formato) {
      if (!c.P.some((p) => (!state.set || p[0] === state.set) && (!state.rarita || p[2] === state.rarita) &&
        (!state.formato || p[3] === state.formato))) return false;
    }
    return true;
  }

  // Number of the card inside the filtered set (or its first printing).
  const printOf = (c) => (state.set ? c.P.find((x) => x[0] === state.set) : c.P[0]) || ["", "", "", ""];
  const printNum = (c) => printOf(c)[1];
  const printSet = (c) => printOf(c)[0];

  const setRank = (code) => (setMap.get(code) && setMap.get(code).data) || "9999";

  const SORTS = {
    nome: (a, b) => a.nome_en.localeCompare(b.nome_en, "en"),
    "costo-asc": (a, b) => (a.costo == null ? 1e9 : a.costo) - (b.costo == null ? 1e9 : b.costo) || SORTS.nome(a, b),
    "costo-desc": (a, b) => (b.costo == null ? -1 : b.costo) - (a.costo == null ? -1 : a.costo) || SORTS.nome(a, b),
    "potere-desc": (a, b) => (b.potere_num == null ? -1 : b.potere_num) - (a.potere_num == null ? -1 : a.potere_num) || SORTS.nome(a, b),
    "potere-asc": (a, b) => (a.potere_num == null ? 1e9 : a.potere_num) - (b.potere_num == null ? 1e9 : b.potere_num) || SORTS.nome(a, b),
    // by release date of the set (oldest first, undated last), then by number inside the set
    numero: (a, b) => setRank(printSet(a)).localeCompare(setRank(printSet(b))) || natural(printSet(a), printSet(b)) ||
      numKey(printNum(a)) - numKey(printNum(b)) || SORTS.nome(a, b),
  };

  function apply({ url = true } = {}) {
    results = cards.filter(matches).sort(SORTS[state.sort] || SORTS.nome);
    el.grid.replaceChildren();
    shown = 0;
    el.count.textContent = `${results.length.toLocaleString("it-IT")} ${results.length === 1 ? "carta" : "carte"}`;
    el.empty.hidden = results.length > 0;
    renderMore();

    const active = state.civs.size + (state.costMin != null) + (state.costMax != null) +
      !!state.tipo + !!state.set + !!state.rarita + !!state.formato;
    el.filtersBadge.hidden = !active;
    el.filtersBadge.textContent = active;

    const s = setMap.get(state.set);
    el.setBar.hidden = !state.set;
    if (state.set) el.setBarName.textContent = s ? `${s.code} · ${s.nome}` : state.set;
    if (url) writeUrl();
  }

  function renderMore() {
    const html = results.slice(shown, shown + PAGE).map((c, i) => tile(c, shown + i)).join("");
    el.grid.insertAdjacentHTML("beforeend", html);
    shown = Math.min(shown + PAGE, results.length);
  }

  function tile(c, i) {
    const cost = c.costo == null ? "–" : c.costo;
    return `<li><button class="tile" type="button" data-i="${i}" aria-label="${esc(c.nome_en)}">
      <div class="art"><img src="${esc(cardImg(c, c.url_immagine, 320))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></div>
      <span class="badge-t">${esc(printSet(c))}</span>
      <div class="info">
        <div class="name">${esc(c.nome_en)}</div>
        <div class="meta"><span class="cost">${cost}</span><span class="dots">${c.civilta.map(civDot).join("")}</span></div>
      </div></button></li>`;
  }

  // ---------- sets view ----------
  // Release date -> "11 apr 2026" / "mar 2004"
  function fmtDate(d) {
    if (!d) return "";
    const [y, m, day] = d.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, day || 1));
    return dt.toLocaleDateString("it-IT", { timeZone: "UTC", year: "numeric", month: "short", ...(day ? { day: "numeric" } : {}) });
  }

  // Newest first, like the MTG set list; sets without a date go last.
  const byDateDesc = (a, b) => (b.data || "").localeCompare(a.data || "") || natural(b.code, a.code);

  function renderSets() {
    const items = sets.filter((s) => (!state.formato || s.formato === state.formato) &&
      (!state.q || norm(s.code + " " + s.nome).includes(state.q)));
    el.count.textContent = `${items.length} set`;
    let year = null, html = "";
    for (const s of items) {
      const y = s.data ? s.data.slice(0, 4) : "Senza data";
      if (y !== year) { year = y; html += `<li class="year" aria-hidden="true">${esc(y)}</li>`; }
      html += `<li><button class="tile set-tile" type="button" data-set="${esc(s.code)}">
        <div class="art"><img src="${esc(cdn(s.img, 240))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></div>
        <span class="badge-t">${esc(s.formato)}</span>
        <div class="info"><div class="name">${esc(s.code)}</div>
          <div class="sub">${esc(s.nome)}</div>
          <div class="sub">${esc([fmtDate(s.data), s.n + " carte"].filter(Boolean).join(" · "))}</div></div>
      </button></li>`;
    }
    el.setsList.innerHTML = html;
    el.empty.hidden = items.length > 0;
  }

  function setView(name, writeIt = true) {
    state.vista = name;
    el.setsView.hidden = name !== "set";
    el.cardsView.hidden = name === "set";
    el.setsBtn.setAttribute("aria-pressed", String(name === "set"));
    el.setsBtn.textContent = name === "set" ? "Carte" : "Set";
    if (name === "set") { renderSets(); if (writeIt) writeUrl(); }
    else apply({ url: writeIt });
  }

  // ---------- detail data ----------
  const detailCache = new Map();
  function getDetail(id) {
    if (!detailCache.has(id)) {
      detailCache.set(id, fetch(`data/cards/${encodeURIComponent(id)}.json`)
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .catch((e) => { detailCache.delete(id); throw e; }));
    }
    return detailCache.get(id);
  }

  function detail(c) {
    const b = c.lato_b;
    const row = (k, v) => (v || v === 0) ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : "";
    const prints = c.stampe.map((s) =>
      `<li><button type="button" class="setlink" data-set="${esc(s.set_code)}">${esc(s.set_code)} · ${esc(s.set_nome)}</button><span>${esc([s.numero, s.rarita, s.formato].filter(Boolean).join(" · "))}</span></li>`).join("");
    const textBlock = (t, jp) => t ? `<p class="text${jp ? " jp" : ""}">${esc(t)}</p>` : "";

    return `<article class="detail">
      <h2>${esc(c.nome_en)}</h2>
      <p class="alt">${esc([c.nome_jp, c.nome_it].filter(Boolean).join(" · "))}</p>
      <div class="chips">${c.civilta.map(civChip).join("")}</div>
      <dl>
        ${row("Tipo", c.tipo === "Twinpact" && b ? `Twinpact (${c.tipo_lato_a} / ${b.tipo})` : c.tipo)}
        ${row("Costo", c.costo)}
        ${row("Potere", c.potere)}
        ${row("Razze", c.razze.join(", "))}
        ${row("Rarità", c.rarita)}
        ${row("Set", `${c.set_code} · ${c.set_nome}`)}
        ${row("Numero", c.numero)}
        ${row("Formato", c.formato)}
        ${row("Illustratori", c.illustratori.join(", "))}
      </dl>
      ${textBlock(c.testo)}
      ${textBlock(c.testo_jp, true)}
      ${b ? `<div class="side-b"><h3>Lato magia · ${esc(b.nome_en)}</h3>
        <div class="chips">${b.civilta.map(civChip).join("")}</div>
        <dl>${row("Nome JP", b.nome_jp)}${row("Tipo", b.tipo)}${row("Costo", b.costo)}${row("Razze", b.razze.join(", "))}</dl>
        ${textBlock(b.testo)}${textBlock(b.testo_jp, true)}</div>` : ""}
      <h3>Stampe (${c.stampe.length})</h3>
      <ul class="prints">${prints}</ul>
      <a class="wikilink" href="${esc(c.url_wiki)}" target="_blank" rel="noopener">Apri la pagina sulla wiki ↗</a>
    </article>`;
  }

  // ---------- showcase: one card full screen ----------
  function openCard(i, { v = 0, push = true } = {}) {
    if (!list.length) return;
    cur = (i + list.length) % list.length;
    const c = list[cur];
    const wasHidden = el.show.hidden;
    el.show.hidden = false;
    document.body.classList.add("showing");
    el.show.style.setProperty("--card-accent", CIV_HEX[c.civilta[0]] || "");
    el.pos.dataset.name = c.nome_en + (list.length > 1 ? ` · ${cur + 1} / ${list.length}` : "");
    el.wiki.href = "https://duelmasters.fandom.com/wiki/" + encodeURIComponent(c.nome_en.replace(/ /g, "_"));
    el.sheetBody.innerHTML = "";
    el.sheet.scrollTop = 0;
    curDetail = null;
    buildVariants(null);
    varIdx = v;
    showVariant(v, false, true);

    getDetail(c.id).then((d) => {
      if (list[cur] !== c) return;
      curDetail = d;
      el.wiki.href = d.url_wiki;
      el.sheetBody.innerHTML = detail(d);
      buildVariants(d);
      showVariant(Math.min(varIdx, Math.max(0, (d.varianti || []).length - 1)), true);
    }).catch(() => {
      if (list[cur] === c) el.sheetBody.innerHTML = '<article class="detail"><p class="text">Dettagli non disponibili offline.</p></article>';
    });

    // warm the neighbours
    for (const d of [1, -1]) {
      const n = list[(cur + d + list.length) % list.length];
      if (n) new Image().src = cardImg(n, n.url_immagine, 735);
    }
    if (push && wasHidden) pushed = writeUrl("push", { carta: c.id, v });
    else writeUrl("replace", { carta: c.id, v });
  }

  // Variants: the same card in its other printings (other sets, other artwork).
  function buildVariants(d) {
    const v = d ? d.varianti || [] : [];
    el.show.classList.toggle("has-variants", v.length > 1);
    el.varTitle.textContent = `Varianti · ${v.length}`;
    el.varList.innerHTML = v.map((x, k) => `<li><button type="button" data-k="${k}" aria-label="${esc(x.set_code + " " + x.numero)}">
      <img src="${esc(cdn(x.url_immagine, 160))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">
      <span>${esc(x.set_code)}<br>${esc(x.numero)}</span></button></li>`).join("");
  }

  function showVariant(k, fromDetail = false, skipUrl = false) {
    const c = list[cur];
    const vs = curDetail ? curDetail.varianti || [] : [];
    varIdx = vs.length ? (k + vs.length) % vs.length : 0;
    const v = vs[varIdx];
    const url = v ? v.url_immagine : c.url_immagine;
    const rarity = v ? v.rarita : (c.P[0] || [])[2];
    const isMain = !v || varIdx === 0;
    const wanted = cardImg(c, url, 735, isMain);
    if (fromDetail && el.card.dataset.src === wanted) { // same picture already on screen
      updateVariantChrome(vs, v);
      return;
    }
    const tok = ++showTok;
    el.wrap.classList.add("loading");
    el.wrap.classList.toggle("holo", HOLO.has(rarity));
    setTilt(0, 0, 0);
    el.card.alt = c.nome_en;
    el.card.dataset.src = wanted;
    el.card.onload = el.card.onerror = () => { if (tok === showTok) el.wrap.classList.remove("loading"); };
    el.card.src = wanted;
    // ambient light: blurred artwork on alternating layers so changes cross-fade
    ambIdx ^= 1;
    const next = el.amb[ambIdx];
    next.style.backgroundImage = `url("${cardImg(c, url, 320, isMain)}")`;
    el.amb.forEach((n) => n.classList.toggle("on", n === next));
    updateVariantChrome(vs, v);
    if (!fromDetail && !skipUrl) writeUrl("replace", { carta: c.id, v: varIdx });
  }

  function updateVariantChrome(vs, v) {
    el.pos.textContent = el.pos.dataset.name + (vs.length > 1 && v ? ` · ${v.set_code} ${v.numero}` : "");
    el.varList.querySelectorAll("button").forEach((b) => {
      const on = +b.dataset.k === varIdx;
      b.setAttribute("aria-current", String(on));
      if (on) b.scrollIntoView({ block: "nearest", inline: "center" });
    });
  }
  const stepVariant = (d) => { if (curDetail && (curDetail.varianti || []).length > 1) showVariant(varIdx + d); };
  const nav = (d) => openCard(cur + d, { push: false });

  function closeShow({ fromPop = false } = {}) {
    el.sheet.hidden = true;
    el.show.hidden = true;
    document.body.classList.remove("showing");
    const c = list[cur];
    if (!fromPop) {
      if (pushed) { pushed = false; history.back(); }
      else writeUrl("replace", { carta: "" });
    }
    const t = c && el.grid.querySelector(`[data-i="${results.indexOf(c)}"]`);
    if (t) t.focus({ preventScroll: true });
  }
  const toggleSheet = (on = el.sheet.hidden) => { el.sheet.hidden = !on; };

  // tilt + glare: mouse, finger and phone gyroscope
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  let tiltRaf = 0, tiltNext = null;
  function setTilt(x, y, go) {
    tiltNext = { x: clamp(x), y: clamp(y), go };
    if (tiltRaf) return;
    tiltRaf = requestAnimationFrame(() => {
      tiltRaf = 0;
      const t = tiltNext, w = el.wrap.style;
      w.setProperty("--nx", t.x.toFixed(3));
      w.setProperty("--ny", t.y.toFixed(3));
      w.setProperty("--gx", (50 - t.x * 48).toFixed(1) + "%");
      w.setProperty("--gy", (50 - t.y * 48).toFixed(1) + "%");
      w.setProperty("--go", String(t.go));
    });
  }
  function tiltFromPoint(cx, cy) {
    const r = el.wrap.getBoundingClientRect();
    setTilt((cx - (r.left + r.width / 2)) / (r.width / 2), (cy - (r.top + r.height / 2)) / (r.height / 2), 1);
  }

  let fingerTilt = false, gyroBase = null, gyroAsked = false;
  function onOrientation(e) {
    if (e.beta == null || e.gamma == null || el.show.hidden || fingerTilt) return;
    let gx = e.gamma, gy = e.beta;
    const ang = screen.orientation ? screen.orientation.angle : (window.orientation || 0);
    if (ang === 90) [gx, gy] = [gy, -gx];
    else if (ang === 270 || ang === -90) [gx, gy] = [-gy, gx];
    else if (ang === 180) { gx = -gx; gy = -gy; }
    gyroBase = gyroBase || { x: gx, y: gy };
    gyroBase.x += (gx - gyroBase.x) * 0.02; // neutral pose follows how the phone is held
    gyroBase.y += (gy - gyroBase.y) * 0.02;
    setTilt((gx - gyroBase.x) / 18, (gy - gyroBase.y) / 18, 0.9);
  }
  function startGyro() {
    if (gyroAsked || !window.DeviceOrientationEvent) return;
    const D = window.DeviceOrientationEvent;
    gyroAsked = true;
    if (typeof D.requestPermission === "function") {
      // iOS: permission must be requested inside a user gesture.
      D.requestPermission()
        .then((r) => { if (r === "granted") window.addEventListener("deviceorientation", onOrientation, { passive: true }); else gyroAsked = false; })
        .catch(() => { gyroAsked = false; });
    } else {
      window.addEventListener("deviceorientation", onOrientation, { passive: true });
    }
  }

  function bindShow() {
    const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (fine) {
      el.show.addEventListener("pointermove", (e) => { if (e.pointerType !== "touch" && el.sheet.hidden) tiltFromPoint(e.clientX, e.clientY); });
      el.show.addEventListener("pointerleave", () => setTilt(0, 0, 0));
    }
    el.prev.addEventListener("click", () => nav(-1));
    el.next.addEventListener("click", () => nav(1));
    el.info.addEventListener("click", () => toggleSheet());
    el.sheetClose.addEventListener("click", () => toggleSheet(false));
    el.closeBtn.addEventListener("click", () => closeShow());
    el.varList.addEventListener("click", (e) => {
      const b = e.target.closest("[data-k]");
      if (b) showVariant(+b.dataset.k);
    });
    // a set in the printings list -> open that set in the grid
    el.sheet.addEventListener("click", (e) => {
      const b = e.target.closest("[data-set]");
      if (!b) return;
      const code = b.dataset.set;
      pushed = false;
      closeShow({ fromPop: true });
      Object.assign(state, { set: code, sort: "numero", q: "", rarita: "", formato: "", tipo: "", costMin: null, costMax: null });
      state.civs.clear();
      el.q.value = "";
      syncControls();
      setView("");
      window.scrollTo({ top: 0 });
    });

    document.addEventListener("keydown", (e) => {
      if (el.show.hidden) return;
      if (e.key === "Escape") { if (el.sheet.hidden) closeShow(); else toggleSheet(false); }
      else if (e.key === "ArrowRight") nav(1);
      else if (e.key === "ArrowLeft") nav(-1);
      else if (e.key === "ArrowDown") { e.preventDefault(); stepVariant(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); stepVariant(-1); }
    });

    // touch: finger tilts the card; a quick horizontal flick changes card; vertical flick changes variant
    let t0 = null, swallow = 0;
    el.show.addEventListener("touchstart", (e) => {
      startGyro();
      if (e.touches.length !== 1 || el.sheet.contains(e.target) || el.varList.contains(e.target)) { t0 = null; return; }
      const p = e.touches[0];
      t0 = { x: p.clientX, y: p.clientY, t: performance.now(), onCard: el.wrap.contains(e.target) };
      if (t0.onCard) { fingerTilt = true; tiltFromPoint(p.clientX, p.clientY); }
    }, { passive: true });
    el.show.addEventListener("touchmove", (e) => {
      if (!t0 || e.touches.length !== 1) return;
      t0.mx = e.touches[0].clientX; t0.my = e.touches[0].clientY;
      if (t0.onCard) tiltFromPoint(t0.mx, t0.my);
    }, { passive: true });
    el.show.addEventListener("touchend", () => {
      if (!t0) return;
      const t = t0; t0 = null;
      fingerTilt = false; setTilt(0, 0, 0);
      const dx = (t.mx == null ? t.x : t.mx) - t.x, dy = (t.my == null ? t.y : t.my) - t.y, dur = performance.now() - t.t;
      if (Math.hypot(dx, dy) > 12) swallow = Date.now(); // a drag is not a tap
      if (dur < 450 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) nav(dx < 0 ? 1 : -1);
      else if (dur < 450 && Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx) * 1.2) stepVariant(dy < 0 ? 1 : -1);
    }, { passive: true });
    el.cardBtn.addEventListener("click", () => { if (Date.now() - swallow > 400) toggleSheet(true); });
  }

  // ---------- filter controls ----------
  function fillSelect(sel, label, values) {
    sel.innerHTML = `<option value="">${label}</option>` +
      values.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
  }

  function buildControls() {
    el.civs.innerHTML = CIVS.map((c) =>
      `<button class="civ" type="button" data-civ="${c}" aria-pressed="false" style="--c:var(--c-${c})"><i></i>${CIV_IT[c]}</button>`).join("");

    const counts = (arr) => { const m = new Map(); arr.forEach((v) => v && m.set(v, (m.get(v) || 0) + 1)); return m; };
    const types = [...counts(cards.map((c) => c.tipo))].sort((a, b) => b[1] - a[1]);
    fillSelect(el.tipo, "Tutti i tipi", types.map(([t]) => [t, t]));
    fillSelect(el.set, "Tutti i set", sets.map((s) => [s.code, `${s.code} · ${s.nome}${s.data ? " (" + s.data.slice(0, 4) + ")" : ""}`]));
    const rar = [...counts(cards.flatMap((c) => c.P.map((p) => p[2])))].map(([r]) => r);
    const rank = (r) => { const i = RARITY_ORDER.indexOf(r); return i < 0 ? 99 : i; };
    rar.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    fillSelect(el.rarita, "Tutte le rarità", rar.map((r) => [r, r]));
  }

  function refreshList() { state.vista === "set" ? (renderSets(), writeUrl()) : apply(); }

  function bind() {
    let t;
    el.q.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => { state.q = norm(el.q.value).trim(); refreshList(); }, 150);
    });

    el.filtersBtn.addEventListener("click", () => {
      const open = el.filters.hidden;
      el.filters.hidden = !open;
      el.filtersBtn.setAttribute("aria-expanded", String(open));
    });
    el.setsBtn.addEventListener("click", () => {
      setView(state.vista === "set" ? "" : "set");
      window.scrollTo({ top: 0 });
    });

    el.civs.addEventListener("click", (e) => {
      const b = e.target.closest("[data-civ]");
      if (!b) return;
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      on ? state.civs.add(b.dataset.civ) : state.civs.delete(b.dataset.civ);
      apply();
    });

    const num = (v) => (v === "" || isNaN(+v) ? null : Math.max(0, +v));
    el.costMin.addEventListener("input", () => { state.costMin = num(el.costMin.value); apply(); });
    el.costMax.addEventListener("input", () => { state.costMax = num(el.costMax.value); apply(); });
    for (const k of ["tipo", "set", "rarita"]) {
      el[k].addEventListener("change", () => {
        state[k] = el[k].value;
        if (k === "set" && state.set && state.sort === "nome") { state.sort = "numero"; el.sort.value = "numero"; }
        apply();
      });
    }
    el.sort.addEventListener("change", () => { state.sort = el.sort.value; apply(); });

    el.formato.addEventListener("click", (e) => {
      const b = e.target.closest("[data-v]");
      if (!b) return;
      state.formato = b.dataset.v;
      el.formato.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      refreshList();
    });

    el.reset.addEventListener("click", () => {
      Object.assign(state, { q: "", costMin: null, costMax: null, tipo: "", set: "", rarita: "", formato: "", sort: "nome" });
      state.civs.clear();
      el.q.value = "";
      syncControls();
      refreshList();
    });
    el.setBarClear.addEventListener("click", () => {
      state.set = ""; el.set.value = "";
      if (state.sort === "numero") { state.sort = "nome"; el.sort.value = "nome"; }
      apply();
    });

    el.grid.addEventListener("click", (e) => {
      const b = e.target.closest(".tile");
      if (b) { list = results; openCard(+b.dataset.i); }
    });
    el.setsList.addEventListener("click", (e) => {
      const b = e.target.closest("[data-set]");
      if (!b) return;
      Object.assign(state, { set: b.dataset.set, sort: "numero" });
      syncControls();
      setView("");
      window.scrollTo({ top: 0 });
    });

    bindShow();

    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && shown < results.length && !el.cardsView.hidden) renderMore();
    }, { rootMargin: "600px" }).observe(el.more);

    window.addEventListener("popstate", restoreFromUrl); // back / forward re-read the URL
  }

  function restoreFromUrl() {
    const { carta, v } = readUrl();
    syncControls();
    setView(state.vista, false);
    if (carta) {
      const i = results.findIndex((c) => c.id === carta);
      const c = i >= 0 ? results[i] : cards.find((x) => x.id === carta);
      if (c) { list = i >= 0 ? results : [c]; openCard(i >= 0 ? i : 0, { v, push: false }); }
    } else if (!el.show.hidden) {
      closeShow({ fromPop: true });
    }
  }

  // ---------- boot ----------
  const getJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  Promise.all([getJson("data/index.json"), getJson("data/sets.json"), getJson("data/images.json").catch(() => [])])
    .then(([idx, setList, imgs]) => {
      localImages = new Set(imgs);
      sets = setList.sort(byDateDesc);
      setMap = new Map(sets.map((s) => [s.code, s]));
      cards = idx.map((r) => ({
        id: r.id, nome_en: r.n, nome_jp: r.j, nome_it: r.i, civilta: r.c, costo: r.k, potere_num: r.p,
        tipo: r.t, razze: r.r, url_immagine: r.im, P: r.P,
        _s: norm([r.n, r.j, r.i, r.x, r.r.join(" ")].join(" \n ")),
      }));
      el.loading.hidden = true;
      buildControls();
      bind();
      restoreFromUrl();
    })
    .catch(() => { el.loading.textContent = "Impossibile caricare le carte. Controlla la connessione."; });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();

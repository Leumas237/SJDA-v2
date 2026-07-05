/* SJDA — logique front (SPA vanilla) */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem("sjda_token") || "",
  userId: Number(localStorage.getItem("sjda_user_id")) || null,
  me: null,
  deck: [],             // profils à swiper
  currentDetail: null,  // { matchId, profile } fiche match ouverte
  ws: null,
  approvalTimer: null,  // polling du statut "en attente de validation"
};

/* ---------------- API ---------------- */

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.json);
  }
  const res = await fetch("/api" + path, { ...options, headers });
  if (res.status === 401 && state.token) { logout(); throw new Error("Session expirée"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "Erreur réseau");
  return data;
}

/* ---------------- navigation ---------------- */

const VIEWS = ["auth", "discover", "matches", "waiting", "profile", "admin"];

function show(view) {
  VIEWS.forEach((v) => $("view-" + v).classList.toggle("hidden", v !== view));
  $("navbar").classList.toggle("hidden", view === "auth");
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view)
  );
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const v = btn.dataset.view;
    show(v);
    if (v === "discover") loadDeck();
    if (v === "matches") loadMatches();
    if (v === "profile") fillProfileForm();
    if (v === "admin") loadAdmin();
  });
});

/* ---------------- auth ---------------- */

$("tab-login").onclick = () => switchTab(true);
$("tab-register").onclick = () => switchTab(false);

function switchTab(login) {
  $("tab-login").classList.toggle("active", login);
  $("tab-register").classList.toggle("active", !login);
  $("form-login").classList.toggle("hidden", !login);
  $("form-register").classList.toggle("hidden", login);
  authError("");
}

function authError(msg) {
  $("auth-error").textContent = msg;
  $("auth-error").classList.toggle("hidden", !msg);
}

$("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await api("/login", {
      method: "POST",
      json: { email: $("login-email").value, password: $("login-password").value },
    });
    onLoggedIn(data);
  } catch (err) { authError(err.message); }
});

$("form-register").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await api("/register", {
      method: "POST",
      json: {
        name: $("reg-name").value,
        email: $("reg-email").value,
        password: $("reg-password").value,
        invite_code: $("reg-invite").value,
      },
    });
    onLoggedIn(data, true);
  } catch (err) { authError(err.message); }
});

async function onLoggedIn(data, isNew = false) {
  state.token = data.token;
  state.userId = data.user_id;
  localStorage.setItem("sjda_token", data.token);
  localStorage.setItem("sjda_user_id", data.user_id);
  state.me = await api("/me");
  applyAccessUi();
  connectWs();
  if (!state.me.approved) { show("waiting"); return; }
  if (isNew) { show("profile"); fillProfileForm(); }
  else { show("discover"); loadDeck(); }
}

function logout() {
  localStorage.removeItem("sjda_token");
  localStorage.removeItem("sjda_user_id");
  state.token = ""; state.userId = null; state.me = null;
  if (state.ws) { state.ws.close(); state.ws = null; }
  stopApprovalPolling();
  show("auth");
}

$("btn-logout").onclick = logout;
$("btn-waiting-logout").onclick = logout;
$("btn-waiting-profile").onclick = () => { show("profile"); fillProfileForm(); };

/* ---------------- attente de validation ---------------- */

function applyAccessUi() {
  const me = state.me || {};
  const pending = !me.approved;
  $("nav-waiting").classList.toggle("hidden", !pending);
  $("nav-discover").classList.toggle("hidden", pending);
  $("nav-matches").classList.toggle("hidden", pending);
  $("nav-admin").classList.toggle("hidden", !me.is_admin);
  if (pending) startApprovalPolling();
  else stopApprovalPolling();
}

function startApprovalPolling() {
  stopApprovalPolling();
  state.approvalTimer = setInterval(async () => {
    try {
      state.me = await api("/me");
    } catch { return; } // compte refusé -> api() a déjà déconnecté
    if (state.me.approved) {
      applyAccessUi();
      show("discover");
      loadDeck();
    }
  }, 5000);
}

function stopApprovalPolling() {
  if (state.approvalTimer) { clearInterval(state.approvalTimer); state.approvalTimer = null; }
}

/* ---------------- profil ---------------- */

function fillProfileForm() {
  const p = state.me || {};
  $("p-bio").value = p.bio || "";
  $("p-age").value = p.age || "";
  $("p-classe").value = p.classe || "";
  $("p-interests").value = (p.interests || []).join(", ");
  $("p-intent").value = p.intent || "les_deux";
  $("p-gender").value = p.gender || "";
  $("p-seeking").value = p.seeking || "tous";
  $("p-instagram").value = p.instagram || "";
  $("p-snapchat").value = p.snapchat || "";
  $("p-whatsapp").value = p.whatsapp || "";
  setProfilePhoto(p.photo);
}

function setProfilePhoto(url) {
  const img = $("profile-photo");
  if (url) {
    img.src = url;
    img.classList.remove("hidden");
    $("photo-placeholder").classList.add("hidden");
  } else {
    img.classList.add("hidden");
    $("photo-placeholder").classList.remove("hidden");
  }
}

$("form-profile").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/profile", {
    method: "PUT",
    json: {
      bio: $("p-bio").value,
      age: Number($("p-age").value) || 0,
      classe: $("p-classe").value,
      interests: $("p-interests").value.split(",").map((s) => s.trim()).filter(Boolean),
      intent: $("p-intent").value,
      gender: $("p-gender").value,
      seeking: $("p-seeking").value,
      instagram: $("p-instagram").value,
      snapchat: $("p-snapchat").value,
      whatsapp: $("p-whatsapp").value,
    },
  });
  state.me = await api("/me");
  $("profile-saved").classList.remove("hidden");
  setTimeout(() => $("profile-saved").classList.add("hidden"), 2000);
});

$("photo-input").addEventListener("change", async () => {
  const file = $("photo-input").files[0];
  if (!file) return;
  const form = new FormData();
  form.append("photo", file);
  const data = await api("/profile/photo", { method: "POST", body: form });
  setProfilePhoto(data.photo);
  if (state.me) state.me.photo = data.photo;
});

/* ---------------- swipe ---------------- */

const INTENT_LABEL = { amis: "🤝 Cherche des amis", couple: "💘 Cherche l'amour", les_deux: "😄 Ouvert·e à tout" };

async function loadDeck() {
  state.deck = await api("/discover");
  renderDeck();
}

function renderDeck() {
  const deck = $("deck");
  deck.innerHTML = "";
  $("deck-empty").classList.toggle("hidden", state.deck.length > 0);
  // On affiche au plus 3 cartes empilées, la première du tableau au-dessus
  state.deck.slice(0, 3).reverse().forEach((p) => deck.appendChild(makeCard(p)));
  attachDrag();
}

function makeCard(p) {
  const card = document.createElement("div");
  card.className = "card" + (p.photo ? "" : " no-photo");
  if (p.photo) card.style.backgroundImage = `url(${p.photo})`;
  else card.dataset.initial = (p.name || "?")[0].toUpperCase();
  card.dataset.userId = p.user_id;
  const interests = (p.interests || [])
    .map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join("");
  const superBadge = p.superliked_you
    ? '<span class="badge superliked">★ T\'a super liké</span>' : "";
  const age = p.age ? `<span class="age">, ${p.age}</span>` : "";
  card.innerHTML = `
    <div class="stamp like">LIKE</div>
    <div class="stamp pass">NOPE</div>
    <div class="stamp superstamp">SUPER LIKE</div>
    <div class="card-info">
      <h3>${escapeHtml(p.name)}${age}</h3>
      <div class="card-sub">${escapeHtml(p.classe || "")}</div>
      <div>${escapeHtml(p.bio || "")}</div>
      <div class="badges">${superBadge}<span class="badge intent">${INTENT_LABEL[p.intent] || ""}</span>${interests}</div>
    </div>`;
  return card;
}

function topCard() { return $("deck").lastElementChild; }

function attachDrag() {
  const card = topCard();
  if (!card || card.dataset.dragBound) return;
  card.dataset.dragBound = "1";
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;

  const onDown = (e) => {
    dragging = true;
    startX = (e.touches ? e.touches[0] : e).clientX;
    startY = (e.touches ? e.touches[0] : e).clientY;
    card.style.transition = "none";
  };
  const onMove = (e) => {
    if (!dragging) return;
    const x = (e.touches ? e.touches[0] : e).clientX;
    const y = (e.touches ? e.touches[0] : e).clientY;
    dx = x - startX;
    dy = y - startY;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    const superIntent = dy < -60 && Math.abs(dx) < 80;
    card.querySelector(".stamp.like").style.opacity = superIntent ? 0 : Math.max(0, dx / 90);
    card.querySelector(".stamp.pass").style.opacity = superIntent ? 0 : Math.max(0, -dx / 90);
    card.querySelector(".stamp.superstamp").style.opacity = superIntent ? Math.min(1, -dy / 140) : 0;
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    if (dy < -120 && Math.abs(dx) < 80) swipeTop(true, true); // swipe haut = Super Like
    else if (dx > 100) swipeTop(true);
    else if (dx < -100) swipeTop(false);
    else {
      card.style.transition = "transform 0.25s";
      card.style.transform = "";
      card.querySelectorAll(".stamp").forEach((s) => (s.style.opacity = 0));
    }
    dx = 0; dy = 0;
  };

  card.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

async function swipeTop(liked, superLike = false) {
  const card = topCard();
  if (!card) return;
  const targetId = Number(card.dataset.userId);
  card.style.transition = "transform 0.35s ease-in";
  if (superLike) {
    card.style.transform = "translate(0, -130vh) rotate(0deg)";
  } else {
    card.style.transform = `translate(${liked ? "120vw" : "-120vw"}, -30px) rotate(${liked ? 20 : -20}deg)`;
  }
  setTimeout(() => card.remove(), 300);

  const swiped = state.deck.shift();
  if (state.deck.length <= 2) {
    // recharge en arrière-plan quand la pile baisse
    api("/discover").then((more) => {
      const known = new Set(state.deck.map((p) => p.user_id));
      more.forEach((p) => { if (!known.has(p.user_id) && p.user_id !== swiped.user_id) state.deck.push(p); });
      renderDeck();
    }).catch(() => {});
  } else {
    setTimeout(renderDeck, 320);
  }

  try {
    const res = await api("/swipe", {
      method: "POST",
      json: { target_id: targetId, liked, super_like: superLike },
    });
    if (res.matched) showMatchPopup(swiped, res.match_id);
  } catch (err) { console.error(err); }
}

$("btn-like").onclick = () => swipeTop(true);
$("btn-pass").onclick = () => swipeTop(false);
$("btn-super").onclick = () => swipeTop(true, true);

$("btn-rewind").onclick = async () => {
  try {
    const res = await api("/rewind", { method: "POST" });
    state.deck.unshift(res.profile);
    renderDeck();
  } catch { /* rien à annuler */ }
};

function showMatchPopup(profile, matchId) {
  $("match-popup-text").textContent =
    `${profile.name} et toi vous êtes likés mutuellement. Ses réseaux sont débloqués !`;
  $("match-avatars").innerHTML =
    avatarHtml(state.me || {}, "avatar") + avatarHtml(profile, "avatar");
  $("match-popup").classList.remove("hidden");
  $("btn-match-socials").onclick = async () => {
    $("match-popup").classList.add("hidden");
    // recharge le match : les réseaux ne sont exposés qu'après le match
    const matches = await api("/matches");
    const m = matches.find((x) => x.match_id === matchId);
    if (m) openMatchDetail(m);
  };
  $("btn-match-close").onclick = () => $("match-popup").classList.add("hidden");
}

/* ---------------- matchs ---------------- */

async function loadMatches() {
  const matches = await api("/matches");
  const list = $("matches-list");
  list.innerHTML = "";
  $("matches-empty").classList.toggle("hidden", matches.length > 0);

  // rangée "Nouveaux matchs" façon Tinder (les 10 plus récents)
  const row = $("new-matches");
  row.innerHTML = "";
  $("new-matches-wrap").classList.toggle("hidden", matches.length === 0);
  matches.slice(0, 10).forEach((m) => {
    const div = document.createElement("div");
    div.className = "new-match";
    div.innerHTML = `${avatarHtml(m.profile, "avatar")}<span>${escapeHtml(m.profile.name)}</span>`;
    div.onclick = () => openMatchDetail(m);
    row.appendChild(div);
  });

  matches.forEach((m) => {
    const li = document.createElement("li");
    li.className = "match-item";
    const socials = socialIcons(m.profile);
    li.innerHTML = `
      ${avatarHtml(m.profile, "avatar")}
      <div>
        <div class="m-name">${escapeHtml(m.profile.name)}</div>
        <div class="m-last">${socials || "🙈 Pas encore de réseaux renseignés"}</div>
      </div>`;
    li.onclick = () => openMatchDetail(m);
    list.appendChild(li);
  });
}

function socialIcons(p) {
  const parts = [];
  if (p.instagram) parts.push("📸 Instagram");
  if (p.snapchat) parts.push("👻 Snap");
  if (p.whatsapp) parts.push("💬 WhatsApp");
  return parts.join(" · ");
}

function avatarHtml(profile, cls) {
  if (profile.photo) return `<img class="${cls}" src="${profile.photo}" alt="">`;
  return `<div class="${cls}">${escapeHtml((profile.name || "?")[0].toUpperCase())}</div>`;
}

/* ---------------- fiche match : réseaux débloqués ---------------- */

function socialLinks(p) {
  const links = [];
  if (p.instagram) links.push({
    label: "📸 Instagram", handle: "@" + p.instagram,
    url: "https://instagram.com/" + encodeURIComponent(p.instagram),
  });
  if (p.snapchat) links.push({
    label: "👻 Snapchat", handle: "@" + p.snapchat,
    url: "https://www.snapchat.com/add/" + encodeURIComponent(p.snapchat),
  });
  if (p.whatsapp) links.push({
    label: "💬 WhatsApp", handle: p.whatsapp,
    url: "https://wa.me/" + p.whatsapp.replace(/\D/g, ""),
  });
  return links;
}

function openMatchDetail(m) {
  state.currentDetail = { matchId: m.match_id, profile: m.profile };
  const p = m.profile;
  $("detail-avatar-wrap").innerHTML = avatarHtml(p, "avatar detail-avatar");
  $("detail-name").textContent = p.name;
  $("detail-sub").textContent = [p.classe, (p.interests || []).join(", ")]
    .filter(Boolean).join(" · ");
  $("detail-bio").textContent = p.bio || "";
  const links = socialLinks(p);
  $("detail-socials").innerHTML = links.length
    ? links.map((l) =>
        `<a class="social-link" href="${l.url}" target="_blank" rel="noopener">
          <span>${l.label}</span><b>${escapeHtml(l.handle)}</b></a>`
      ).join("")
    : `<p class="muted">🙈 ${escapeHtml(p.name)} n'a pas encore ajouté ses réseaux.<br>
       Repasse plus tard !</p>`;
  $("detail-popup").classList.remove("hidden");
}

$("btn-detail-close").onclick = () => {
  $("detail-popup").classList.add("hidden");
  state.currentDetail = null;
};

$("btn-detail-report").onclick = async () => {
  const c = state.currentDetail;
  if (!c) return;
  const reason = prompt(
    `Signaler ${c.profile.name} aux modérateurs ?\n` +
    "Le match sera supprimé et vous ne vous recroiserez plus.\n\n" +
    "Explique brièvement le problème :"
  );
  if (reason === null) return;
  await api("/report", { method: "POST", json: { match_id: c.matchId, reason } });
  alert("Signalement envoyé. Merci de contribuer à la sécurité de tous 💛");
  $("detail-popup").classList.add("hidden");
  state.currentDetail = null;
  loadMatches();
};

/* ---------------- admin ---------------- */

async function loadAdmin() {
  const [overview, pending, reports, users] = await Promise.all([
    api("/admin/overview"), api("/admin/pending"), api("/admin/reports"), api("/admin/users"),
  ]);
  renderAdminStats(overview.stats);
  $("admin-feed").innerHTML = "";
  overview.feed.forEach((ev) => appendFeedItem(ev, false));
  renderAdminPending(pending);
  renderAdminReports(reports);
  renderAdminUsers(users);
}

function renderAdminStats(s) {
  $("admin-stats").innerHTML = `
    <div class="stat"><b>${s.users}</b><span>élèves</span></div>
    <div class="stat ${s.pending_signups ? "alert" : ""}"><b>${s.pending_signups}</b><span>demandes</span></div>
    <div class="stat"><b>${s.matches}</b><span>matchs</span></div>
    <div class="stat ${s.pending_reports ? "alert" : ""}"><b>${s.pending_reports}</b><span>signalements</span></div>
    <div class="stat"><b>${s.banned}</b><span>bannis</span></div>`;
}

function renderAdminPending(pending) {
  const box = $("admin-pending");
  box.innerHTML = pending.length ? "" : '<p class="muted admin-pad">Aucune demande en attente ✔</p>';
  pending.forEach((u) => {
    const div = document.createElement("div");
    div.className = "report-card pending";
    div.innerHTML = `
      <div class="r-head"><b>${escapeHtml(u.name)}</b>
        <span class="muted">${escapeHtml(u.email)}${u.classe ? " · " + escapeHtml(u.classe) : ""}</span></div>
      ${u.bio ? `<div class="r-reason">« ${escapeHtml(u.bio)} »</div>` : ""}
      <div class="r-actions">
        <button class="btn-mini ok" data-approve="1">✅ Accepter</button>
        <button class="btn-mini danger" data-approve="0">❌ Refuser</button>
      </div>`;
    div.querySelectorAll("[data-approve]").forEach((btn) => {
      btn.onclick = async () => {
        const approve = btn.dataset.approve === "1";
        if (!approve && !confirm(`Refuser la demande de ${u.name} ? Son compte sera supprimé.`)) return;
        await api(`/admin/users/${u.id}/approve`, { method: "POST", json: { approve } });
        loadAdmin();
      };
    });
    box.appendChild(div);
  });
}

function appendFeedItem(ev, prepend = true) {
  const li = document.createElement("li");
  li.textContent = `${ev.created_at.slice(11, 16)} — ${ev.text}`;
  if (ev.type === "report") li.classList.add("feed-alert");
  const feed = $("admin-feed");
  prepend ? feed.prepend(li) : feed.appendChild(li);
  while (feed.children.length > 40) feed.lastElementChild.remove();
}

function renderAdminReports(reports) {
  const box = $("admin-reports");
  box.innerHTML = reports.length ? "" : '<p class="muted admin-pad">Aucun signalement 🎉</p>';
  reports.forEach((r) => {
    const div = document.createElement("div");
    div.className = "report-card" + (r.status === "pending" ? " pending" : "");
    const msgs = (r.messages || [])
      .map((m) => `<div class="r-msg">${m.sender_id === r.reported_id ? "🔴" : "⚪"} ${escapeHtml(m.content)}</div>`)
      .join("");
    const statusLabel = { pending: "⏳ En attente", banned: "🚫 Banni", dismissed: "✔ Classé" }[r.status];
    div.innerHTML = `
      <div class="r-head"><b>${escapeHtml(r.reporter_name)}</b> signale <b>${escapeHtml(r.reported_name)}</b>
        <span class="muted">${statusLabel}</span></div>
      ${r.reason ? `<div class="r-reason">« ${escapeHtml(r.reason)} »</div>` : ""}
      ${msgs ? `<details><summary>Voir la conversation signalée</summary>${msgs}</details>` : ""}
      ${r.status === "pending" ? `
        <div class="r-actions">
          <button class="btn-mini danger" data-act="ban">Bannir ${escapeHtml(r.reported_name)}</button>
          <button class="btn-mini" data-act="dismiss">Classer sans suite</button>
        </div>` : ""}`;
    div.querySelectorAll("[data-act]").forEach((btn) => {
      btn.onclick = async () => {
        await api(`/admin/reports/${r.id}`, { method: "POST", json: { action: btn.dataset.act } });
        loadAdmin();
      };
    });
    box.appendChild(div);
  });
}

function renderAdminUsers(users) {
  const box = $("admin-users");
  box.innerHTML = "";
  users.forEach((u) => {
    const div = document.createElement("div");
    div.className = "user-row" + (u.banned ? " banned" : "");
    div.innerHTML = `
      <div class="u-info">
        <b>${escapeHtml(u.name)}</b> ${u.is_admin ? "🛡️" : ""} ${u.banned ? "🚫" : ""}
        <span class="muted">${escapeHtml(u.email)}${u.classe ? " · " + escapeHtml(u.classe) : ""}</span>
      </div>
      ${u.id !== state.userId ? `<button class="btn-mini ${u.banned ? "" : "danger"}">${u.banned ? "Rétablir" : "Bannir"}</button>` : ""}`;
    const btn = div.querySelector("button");
    if (btn) btn.onclick = async () => {
      if (!u.banned && !confirm(`Bannir ${u.name} ? Son compte sera immédiatement suspendu.`)) return;
      await api(`/admin/users/${u.id}/ban`, { method: "POST", json: { banned: !u.banned } });
      loadAdmin();
    };
    box.appendChild(div);
  });
}

/* ---------------- websocket ---------------- */

function connectWs() {
  if (!state.token || state.ws) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${state.token}`);
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === "match") {
      // rafraîchit la liste si on est dessus
      if (!$("view-matches").classList.contains("hidden")) loadMatches();
    } else if (data.type === "activity") {
      // flux de modération en direct (admins uniquement)
      if (!$("view-admin").classList.contains("hidden")) {
        appendFeedItem(data.event);
        api("/admin/overview").then((o) => renderAdminStats(o.stats)).catch(() => {});
        if (data.event.type === "report") api("/admin/reports").then(renderAdminReports).catch(() => {});
        if (data.event.type === "signup_request" || data.event.type === "approve") {
          api("/admin/pending").then(renderAdminPending).catch(() => {});
          api("/admin/users").then(renderAdminUsers).catch(() => {});
        }
      }
    }
  };
  ws.onclose = () => { state.ws = null; setTimeout(connectWs, 5000); };
  state.ws = ws;
}

/* ---------------- utils & init ---------------- */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

(async function init() {
  if (state.token) {
    try {
      state.me = await api("/me");
      applyAccessUi();
      connectWs();
      if (!state.me.approved) { show("waiting"); return; }
      show("discover");
      loadDeck();
      return;
    } catch { /* token invalide -> écran auth */ }
  }
  show("auth");
})();

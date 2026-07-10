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

const VIEWS = ["auth", "discover", "matches", "waiting", "kyi", "profile", "admin"];

function show(view) {
  VIEWS.forEach((v) => $("view-" + v).classList.toggle("hidden", v !== view));
  $("navbar").classList.toggle("hidden", view === "auth" || view === "kyi");
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
  setupPush();
  if (!state.me.approved) {
    show(state.me.kyi_submitted ? "waiting" : "kyi");
    return;
  }
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

$("btn-delete-account").onclick = async () => {
  if (!confirm(
    "Supprimer définitivement ton compte ?\n" +
    "Profil, photos, dossier d'identité et matchs seront effacés. C'est irréversible."
  )) return;
  const password = prompt("Pour confirmer, entre ton mot de passe :");
  if (!password) return;
  try {
    await api("/account/delete", { method: "POST", json: { password } });
    alert("Compte supprimé. Prends soin de toi 👋");
    logout();
  } catch (err) { alert(err.message); }
};
$("btn-waiting-profile").onclick = () => { show("profile"); fillProfileForm(); };

/* ---------------- KYI (vérification d'identité) ---------------- */

$("btn-kyi-logout").onclick = logout;

$("k-card").addEventListener("change", () => {
  const file = $("k-card").files[0];
  if (!file) return;
  $("card-preview").src = URL.createObjectURL(file);
  $("card-preview").classList.remove("hidden");
  $("card-picker-text").textContent = "📷 " + file.name;
});

$("form-kyi").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = $("k-card").files[0];
  const errEl = $("kyi-error");
  errEl.classList.add("hidden");
  if (!file) {
    errEl.textContent = "Ajoute une photo de ta carte d'étudiant";
    errEl.classList.remove("hidden");
    return;
  }
  const form = new FormData();
  form.append("full_name", $("k-fullname").value);
  form.append("birthdate", $("k-birthdate").value);
  form.append("classe", $("k-classe").value);
  form.append("card", file);
  try {
    await api("/kyi", { method: "POST", body: form });
    state.me = await api("/me");
    show("waiting");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  }
});

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
  $("p-invisible").checked = !!p.invisible;
  renderPhotosGrid();
}

function renderPhotosGrid() {
  const grid = $("photos-grid");
  grid.innerHTML = "";
  const photos = (state.me && state.me.my_photos) || [];
  photos.forEach((ph) => {
    const slot = document.createElement("div");
    slot.className = "photo-slot";
    slot.innerHTML = `<img src="${ph.url}" alt="">
      <button type="button" class="photo-del" title="Supprimer">✕</button>`;
    slot.querySelector(".photo-del").onclick = async () => {
      await api(`/profile/photos/${ph.id}`, { method: "DELETE" });
      state.me = await api("/me");
      renderPhotosGrid();
    };
    grid.appendChild(slot);
  });
  if (photos.length < 6) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "photo-slot photo-add";
    add.textContent = "+";
    add.onclick = () => $("photo-input").click();
    grid.appendChild(add);
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
      invisible: $("p-invisible").checked,
    },
  });
  state.me = await api("/me");
  $("profile-saved").classList.remove("hidden");
  setTimeout(() => $("profile-saved").classList.add("hidden"), 2000);
});

$("photo-input").addEventListener("change", async () => {
  const file = $("photo-input").files[0];
  if (!file) return;
  $("photo-input").value = "";
  const form = new FormData();
  form.append("photo", file);
  try {
    await api("/profile/photo", { method: "POST", body: form });
    state.me = await api("/me");
    renderPhotosGrid();
  } catch (err) { alert(err.message); }
});

/* ---------------- swipe ---------------- */

const INTENT_LABEL = { amis: "🤝 Cherche des amis", couple: "💘 Cherche l'amour", les_deux: "😄 Ouvert·e à tout" };

/* ---------------- filtres de découverte ---------------- */

function getFilters() {
  try { return JSON.parse(localStorage.getItem("sjda_filters")) || {}; }
  catch { return {}; }
}

function filterQuery() {
  const f = getFilters();
  const params = new URLSearchParams();
  if (f.age_min) params.set("age_min", f.age_min);
  if (f.age_max) params.set("age_max", f.age_max);
  if (f.classe) params.set("classe", f.classe);
  const qs = params.toString();
  return qs ? "?" + qs : "";
}

$("btn-filters").onclick = () => {
  const f = getFilters();
  $("f-age-min").value = f.age_min || "";
  $("f-age-max").value = f.age_max || "";
  $("f-classe").value = f.classe || "";
  $("filter-popup").classList.remove("hidden");
};

$("btn-filters-apply").onclick = () => {
  localStorage.setItem("sjda_filters", JSON.stringify({
    age_min: Number($("f-age-min").value) || 0,
    age_max: Number($("f-age-max").value) || 0,
    classe: $("f-classe").value.trim(),
  }));
  $("filter-popup").classList.add("hidden");
  loadDeck();
};

$("btn-filters-reset").onclick = () => {
  localStorage.removeItem("sjda_filters");
  $("filter-popup").classList.add("hidden");
  loadDeck();
};

async function loadDeck() {
  const invisible = state.me && state.me.invisible;
  $("deck-invisible").classList.toggle("hidden", !invisible);
  if (invisible) {
    state.deck = [];
    $("deck").innerHTML = "";
    $("deck-empty").classList.add("hidden");
    $("likes-banner").classList.add("hidden");
    return;
  }
  const [deck, likes] = await Promise.all([
    api("/discover" + filterQuery()),
    api("/likes-me").catch(() => ({ count: 0 })),
  ]);
  state.deck = deck;
  const banner = $("likes-banner");
  if (likes.count > 0) {
    banner.textContent = likes.count === 1
      ? "👀 1 personne t'a liké — elle est peut-être dans ta pile !"
      : `👀 ${likes.count} personnes t'ont liké — swipe pour les trouver !`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
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
  const photos = p.photos || [];
  card.className = "card" + (photos.length ? "" : " no-photo");
  if (!photos.length) card.dataset.initial = (p.name || "?")[0].toUpperCase();
  card.dataset.userId = p.user_id;
  card.dataset.photoIndex = "0";
  const interests = (p.interests || [])
    .map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join("");
  const age = p.age ? `<span class="age">, ${p.age}</span>` : "";
  const activeBadge = p.active_recent
    ? '<span class="badge active">🟢 Actif·ve récemment</span>' : "";
  const dots = photos.length > 1
    ? `<div class="photo-dots">${photos.map((_, i) =>
        `<span class="${i === 0 ? "on" : ""}"></span>`).join("")}</div>`
    : "";
  card.innerHTML = `
    ${dots}
    <div class="stamp like">LIKE</div>
    <div class="stamp pass">NOPE</div>
    <div class="card-info">
      <h3>${escapeHtml(p.name)}${age}</h3>
      <div class="card-sub">${escapeHtml(p.classe || "")}</div>
      <div>${escapeHtml(p.bio || "")}</div>
      <div class="badges">${activeBadge}<span class="badge intent">${INTENT_LABEL[p.intent] || ""}</span>${interests}</div>
    </div>`;
  setCardPhoto(card, photos, 0);
  return card;
}

function setCardPhoto(card, photos, index) {
  if (!photos.length) return;
  card.dataset.photoIndex = String(index);
  card.style.backgroundImage = `url(${photos[index]})`;
  card.querySelectorAll(".photo-dots span").forEach((dot, i) =>
    dot.classList.toggle("on", i === index)
  );
}

function cycleCardPhoto(card, forward) {
  const p = state.deck[0];
  if (!p || !p.photos || p.photos.length < 2) return;
  const n = p.photos.length;
  const i = (Number(card.dataset.photoIndex) + (forward ? 1 : -1) + n) % n;
  setCardPhoto(card, p.photos, i);
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
    card.querySelector(".stamp.like").style.opacity = Math.max(0, dx / 90);
    card.querySelector(".stamp.pass").style.opacity = Math.max(0, -dx / 90);
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    if (dx > 100) swipeTop(true);
    else if (dx < -100) swipeTop(false);
    else {
      // tap (presque pas de mouvement) : change de photo façon Tinder
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && e) {
        const rect = card.getBoundingClientRect();
        const x = (e.changedTouches ? e.changedTouches[0] : e).clientX;
        cycleCardPhoto(card, x - rect.left > rect.width / 2);
      }
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

async function swipeTop(liked) {
  const card = topCard();
  if (!card) return;
  const targetId = Number(card.dataset.userId);
  card.style.transition = "transform 0.35s ease-in";
  card.style.transform = `translate(${liked ? "120vw" : "-120vw"}, -30px) rotate(${liked ? 20 : -20}deg)`;
  setTimeout(() => card.remove(), 300);

  const swiped = state.deck.shift();
  if (state.deck.length <= 2) {
    // recharge en arrière-plan quand la pile baisse
    api("/discover" + filterQuery()).then((more) => {
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
      json: { target_id: targetId, liked },
    });
    if (res.matched) showMatchPopup(swiped, res.match_id);
  } catch (err) {
    // quota de likes atteint ou mode invisible : on rend la carte
    state.deck.unshift(swiped);
    renderDeck();
    alert(err.message);
  }
}

$("btn-like").onclick = () => swipeTop(true);
$("btn-pass").onclick = () => swipeTop(false);

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
    const kyi = u.kyi
      ? `<div class="kyi-info">
           🪪 <b>${escapeHtml(u.kyi.full_name)}</b> · né·e le ${escapeHtml(u.kyi.birthdate)}
           · ${escapeHtml(u.kyi.classe)}
           ${u.kyi.card_url ? '<button type="button" class="btn-mini" data-card>Voir la carte 🪪</button>' : ""}
         </div>`
      : '<div class="kyi-info muted">⏳ Dossier KYI pas encore soumis — attends avant d\'accepter</div>';
    div.innerHTML = `
      <div class="r-head"><b>${escapeHtml(u.name)}</b>
        <span class="muted">${escapeHtml(u.email)}</span></div>
      ${kyi}
      <div class="r-actions">
        <button class="btn-mini ok" data-approve="1">✅ Accepter</button>
        <button class="btn-mini danger" data-approve="0">❌ Refuser</button>
      </div>`;
    const cardBtn = div.querySelector("[data-card]");
    if (cardBtn) cardBtn.onclick = () => showKyiCard(u);
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

async function showKyiCard(u) {
  // l'image est protégée : on la récupère avec le jeton puis on l'affiche
  const res = await fetch(u.kyi.card_url, {
    headers: { Authorization: "Bearer " + state.token },
  });
  if (!res.ok) { alert("Impossible de charger la carte"); return; }
  const blob = await res.blob();
  $("card-popup-title").textContent = `Carte de ${u.kyi.full_name}`;
  $("card-popup-img").src = URL.createObjectURL(blob);
  $("card-popup").classList.remove("hidden");
}

$("btn-card-close").onclick = () => {
  URL.revokeObjectURL($("card-popup-img").src);
  $("card-popup").classList.add("hidden");
};

function renderAdminUsers(users) {
  const box = $("admin-users");
  box.innerHTML = "";
  users.forEach((u) => {
    const div = document.createElement("div");
    div.className = "user-row" + (u.banned ? " banned" : "");
    const isSelf = u.id === state.userId;
    div.innerHTML = `
      <div class="u-info">
        <b>${escapeHtml(u.name)}</b> ${u.is_admin ? "🛡️" : ""} ${u.banned ? "🚫" : ""}
        <span class="muted">${escapeHtml(u.email)}${u.classe ? " · " + escapeHtml(u.classe) : ""}</span>
      </div>
      ${isSelf ? "" : `<div class="u-actions">
        <button class="btn-mini" data-act="mod">${u.is_admin ? "Retirer modo" : "Modo"}</button>
        <button class="btn-mini ${u.banned ? "" : "danger"}" data-act="ban">${u.banned ? "Rétablir" : "Bannir"}</button>
      </div>`}`;
    const modBtn = div.querySelector('[data-act="mod"]');
    if (modBtn) modBtn.onclick = async () => {
      const promote = !u.is_admin;
      if (!confirm(promote
        ? `Faire de ${u.name} un·e modérateur·rice ? Il/elle verra tout le tableau de bord.`
        : `Retirer les droits de modération de ${u.name} ?`)) return;
      await api(`/admin/users/${u.id}/mod`, { method: "POST", json: { is_admin: promote } });
      loadAdmin();
    };
    const banBtn = div.querySelector('[data-act="ban"]');
    if (banBtn) banBtn.onclick = async () => {
      if (!u.banned && !confirm(`Bannir ${u.name} ? Son compte sera immédiatement suspendu.`)) return;
      await api(`/admin/users/${u.id}/ban`, { method: "POST", json: { banned: !u.banned } });
      loadAdmin();
    };
    box.appendChild(div);
  });
}

/* ---------------- notifications push ---------------- */

function urlB64ToUint8(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function setupPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      // ré-enregistre côté serveur (le compte a pu changer d'appareil)
      await api("/push/subscribe", { method: "POST", json: sub.toJSON() });
      return;
    }
    if (Notification.permission === "granted") {
      await subscribePush();
      return;
    }
    if (Notification.permission !== "denied") {
      $("btn-push").classList.remove("hidden");
    }
  } catch { /* le push est du confort, jamais bloquant */ }
}

async function subscribePush() {
  const { key } = await api("/push/key");
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8(key),
  });
  await api("/push/subscribe", { method: "POST", json: sub.toJSON() });
  $("btn-push").classList.add("hidden");
}

$("btn-push").onclick = async () => {
  const perm = await Notification.requestPermission();
  if (perm === "granted") {
    try { await subscribePush(); } catch { /* réessaiera au prochain lancement */ }
  } else {
    $("btn-push").classList.add("hidden");
  }
};

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
        if (["signup_request", "approve", "kyi"].includes(data.event.type)) {
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

// rappel des emails étudiants acceptés sous le champ d'inscription
api("/config").then((c) => {
  const domains = c.email_domains || [];
  if (domains.length) {
    $("reg-hint").textContent =
      "Utilise ton email étudiant : " + domains.map((d) => "@" + d).join(", ");
  }
}).catch(() => {});

(async function init() {
  if (state.token) {
    try {
      state.me = await api("/me");
      applyAccessUi();
      connectWs();
      setupPush();
      if (!state.me.approved) {
        show(state.me.kyi_submitted ? "waiting" : "kyi");
        return;
      }
      show("discover");
      loadDeck();
      return;
    } catch { /* token invalide -> écran auth */ }
  }
  show("auth");
})();

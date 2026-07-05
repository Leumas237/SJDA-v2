/* SJDA — logique front (SPA vanilla) */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem("sjda_token") || "",
  userId: Number(localStorage.getItem("sjda_user_id")) || null,
  me: null,
  deck: [],            // profils à swiper
  currentChat: null,   // { matchId, profile, lastMsgId }
  ws: null,
  pollTimer: null,
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

const VIEWS = ["auth", "discover", "matches", "chat", "profile"];

function show(view) {
  VIEWS.forEach((v) => $("view-" + v).classList.toggle("hidden", v !== view));
  $("navbar").classList.toggle("hidden", view === "auth" || view === "chat");
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view)
  );
  if (view !== "chat") stopChatPolling();
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const v = btn.dataset.view;
    show(v);
    if (v === "discover") loadDeck();
    if (v === "matches") loadMatches();
    if (v === "profile") fillProfileForm();
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
  connectWs();
  if (isNew) { show("profile"); fillProfileForm(); }
  else { show("discover"); loadDeck(); }
}

function logout() {
  localStorage.removeItem("sjda_token");
  localStorage.removeItem("sjda_user_id");
  state.token = ""; state.userId = null; state.me = null;
  if (state.ws) { state.ws.close(); state.ws = null; }
  show("auth");
}

$("btn-logout").onclick = logout;

/* ---------------- profil ---------------- */

function fillProfileForm() {
  const p = state.me || {};
  $("p-bio").value = p.bio || "";
  $("p-classe").value = p.classe || "";
  $("p-interests").value = (p.interests || []).join(", ");
  $("p-intent").value = p.intent || "les_deux";
  $("p-gender").value = p.gender || "";
  $("p-seeking").value = p.seeking || "tous";
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
      classe: $("p-classe").value,
      interests: $("p-interests").value.split(",").map((s) => s.trim()).filter(Boolean),
      intent: $("p-intent").value,
      gender: $("p-gender").value,
      seeking: $("p-seeking").value,
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
  card.dataset.userId = p.user_id;
  const interests = (p.interests || [])
    .map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join("");
  card.innerHTML = `
    <div class="stamp like">J'AIME</div>
    <div class="stamp pass">NON</div>
    <div class="card-info">
      <h3>${escapeHtml(p.name)}</h3>
      <div class="card-sub">${escapeHtml(p.classe || "")}</div>
      <div>${escapeHtml(p.bio || "")}</div>
      <div class="badges"><span class="badge intent">${INTENT_LABEL[p.intent] || ""}</span>${interests}</div>
    </div>`;
  return card;
}

function topCard() { return $("deck").lastElementChild; }

function attachDrag() {
  const card = topCard();
  if (!card || card.dataset.dragBound) return;
  card.dataset.dragBound = "1";
  let startX = 0, startY = 0, dx = 0, dragging = false;

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
    card.style.transform = `translate(${dx}px, ${y - startY}px) rotate(${dx / 18}deg)`;
    card.querySelector(".stamp.like").style.opacity = Math.max(0, dx / 90);
    card.querySelector(".stamp.pass").style.opacity = Math.max(0, -dx / 90);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    if (dx > 100) swipeTop(true);
    else if (dx < -100) swipeTop(false);
    else {
      card.style.transition = "transform 0.25s";
      card.style.transform = "";
      card.querySelectorAll(".stamp").forEach((s) => (s.style.opacity = 0));
    }
    dx = 0;
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
  card.style.transform = `translate(${liked ? 1 : -1} * 120vw, -30px) rotate(${liked ? 20 : -20}deg)`;
  card.style.transform = `translate(${liked ? "120vw" : "-120vw"}, -30px) rotate(${liked ? 20 : -20}deg)`;
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
    const res = await api("/swipe", { method: "POST", json: { target_id: targetId, liked } });
    if (res.matched) showMatchPopup(swiped, res.match_id);
  } catch (err) { console.error(err); }
}

$("btn-like").onclick = () => swipeTop(true);
$("btn-pass").onclick = () => swipeTop(false);

function showMatchPopup(profile, matchId) {
  $("match-popup-text").textContent = `${profile.name} et toi vous êtes likés mutuellement.`;
  $("match-popup").classList.remove("hidden");
  $("btn-match-chat").onclick = () => {
    $("match-popup").classList.add("hidden");
    openChat({ match_id: matchId, profile });
  };
  $("btn-match-close").onclick = () => $("match-popup").classList.add("hidden");
}

/* ---------------- matchs ---------------- */

async function loadMatches() {
  const matches = await api("/matches");
  const list = $("matches-list");
  list.innerHTML = "";
  $("matches-empty").classList.toggle("hidden", matches.length > 0);
  matches.forEach((m) => {
    const li = document.createElement("li");
    li.className = "match-item";
    li.innerHTML = `
      ${avatarHtml(m.profile, "avatar")}
      <div>
        <div class="m-name">${escapeHtml(m.profile.name)}</div>
        <div class="m-last">${escapeHtml(m.last_message || "Dites-vous bonjour 👋")}</div>
      </div>`;
    li.onclick = () => openChat(m);
    list.appendChild(li);
  });
}

function avatarHtml(profile, cls) {
  if (profile.photo) return `<img class="${cls}" src="${profile.photo}" alt="">`;
  return `<div class="${cls}">${escapeHtml((profile.name || "?")[0].toUpperCase())}</div>`;
}

/* ---------------- chat ---------------- */

async function openChat(m) {
  state.currentChat = { matchId: m.match_id, profile: m.profile, lastMsgId: 0 };
  $("chat-name").textContent = m.profile.name;
  const av = $("chat-avatar");
  if (m.profile.photo) { av.src = m.profile.photo; av.classList.remove("hidden"); }
  else av.classList.add("hidden");
  $("chat-messages").innerHTML = "";
  show("chat");
  await fetchNewMessages();
  startChatPolling();
}

$("btn-chat-back").onclick = () => { show("matches"); loadMatches(); };

async function fetchNewMessages() {
  const c = state.currentChat;
  if (!c) return;
  const msgs = await api(`/matches/${c.matchId}/messages?after=${c.lastMsgId}`);
  msgs.forEach(appendMessage);
}

function appendMessage(msg) {
  const c = state.currentChat;
  if (!c || msg.id <= c.lastMsgId) return;
  c.lastMsgId = Math.max(c.lastMsgId, msg.id);
  const div = document.createElement("div");
  div.className = "msg " + (msg.sender_id === state.userId ? "mine" : "theirs");
  div.textContent = msg.content;
  $("chat-messages").appendChild(div);
  $("chat-messages").scrollTop = $("chat-messages").scrollHeight;
}

$("form-chat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("chat-text").value.trim();
  if (!text || !state.currentChat) return;
  $("chat-text").value = "";
  const msg = await api(`/matches/${state.currentChat.matchId}/messages`, {
    method: "POST", json: { content: text },
  });
  appendMessage(msg);
});

function startChatPolling() {
  stopChatPolling();
  // filet de sécurité si le WebSocket est indisponible
  state.pollTimer = setInterval(fetchNewMessages, 4000);
}
function stopChatPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

/* ---------------- websocket ---------------- */

function connectWs() {
  if (!state.token || state.ws) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${state.token}`);
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === "message" && state.currentChat && data.match_id === state.currentChat.matchId) {
      appendMessage(data.message);
    } else if (data.type === "match") {
      // rafraîchit la liste si on est dessus
      if (!$("view-matches").classList.contains("hidden")) loadMatches();
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
      connectWs();
      show("discover");
      loadDeck();
      return;
    } catch { /* token invalide -> écran auth */ }
  }
  show("auth");
})();

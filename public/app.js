const state = {
  user: null,
  board: null,
  users: [],
  activity: [],
  activeUsers: [],
  csrfToken: null,
  ui: {
    openListMenuId: null,
    openAddCardListId: null,
    modalCardId: null,
    dragCardId: null,
    unseenUpdatedCardIds: new Set(),
    enteringCardIds: new Set(),
    enteringListIds: new Set(),
    showActivity: false,
    showArchive: false,
    promptDialog: null,
    labelsDialogOpen: false
  }
};

const appEl = document.getElementById("app");
const sessionInfoEl = document.getElementById("sessionInfo");
const activeUsersInfoEl = document.getElementById("activeUsersInfo");
const toastHostEl = document.getElementById("toastHost");
const appVersionEl = document.getElementById("appVersion");
const themeToggleBtn = document.getElementById("themeToggleBtn");
const APP_VERSION_FALLBACK = "1.0.0";
const THEME_STORAGE_KEY = "task-organizer:theme";
const THEME_ICON_MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.2A8.5 8.5 0 0 1 9.8 4 9 9 0 1 0 20 14.2Z"></path></svg>';
const THEME_ICON_SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9L5.3 5.3"></path></svg>';
let realtimeSocket = null;
let realtimeReconnectTimer = null;
let toastSeq = 0;

function getSeenCardsStorageKey(userId) {
  return `task-organizer:seen-cards:${userId}`;
}

function readSeenCards(userId) {
  if (!userId) return {};
  try {
    const raw = localStorage.getItem(getSeenCardsStorageKey(userId));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSeenCards(userId, value) {
  if (!userId) return;
  try {
    localStorage.setItem(getSeenCardsStorageKey(userId), JSON.stringify(value || {}));
  } catch {}
}

function readThemePreference() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {}
  return "light";
}

function writeThemePreference(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
}

function applyTheme(theme) {
  const safeTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = safeTheme;
  if (themeToggleBtn) {
    const isDark = safeTheme === "dark";
    themeToggleBtn.innerHTML = isDark ? THEME_ICON_SUN : THEME_ICON_MOON;
    themeToggleBtn.setAttribute("aria-label", isDark ? "Enable light mode" : "Enable dark mode");
  }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  writeThemePreference(next);
}

function ensureToastHost() {
  return toastHostEl || document.getElementById("toastHost");
}

function toast(message, type = "info", timeoutMs = 3200) {
  const host = ensureToastHost();
  if (!host || !message) return;
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.dataset.toastId = String(++toastSeq);
  el.textContent = String(message);
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  const remove = () => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 180);
  };
  el.addEventListener("click", remove, { once: true });
  setTimeout(remove, timeoutMs);
}

function toastError(err) {
  const message = err?.message || String(err || "Error");
  toast(message, "error", 4200);
}

function alert(message) {
  toast(String(message || ""), "error", 4200);
}

function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch {
    return false;
  }
}

function snapshotBoardRects() {
  const lists = new Map();
  const cards = new Map();
  document.querySelectorAll(".list[data-list-id]").forEach((el) => {
    lists.set(el.dataset.listId, el.getBoundingClientRect());
  });
  document.querySelectorAll(".card[data-card-id]").forEach((el) => {
    cards.set(el.dataset.cardId, el.getBoundingClientRect());
  });
  return { lists, cards };
}

function animateElementEnter(el, type) {
  if (!el || prefersReducedMotion() || typeof el.animate !== "function") return;
  const isCard = type === "card";
  try {
    el.animate(
      [
        { opacity: 0, transform: `translateY(${isCard ? 10 : 14}px) scale(${isCard ? 0.985 : 0.99})` },
        { opacity: 1, transform: "translateY(0) scale(1)" }
      ],
      {
        duration: isCard ? 220 : 260,
        easing: "cubic-bezier(.2,.8,.2,1)"
      }
    );
  } catch {}
}

function animateElementExit(el, type) {
  if (!el || prefersReducedMotion() || typeof el.animate !== "function") return Promise.resolve();
  const isCard = type === "card";
  try {
    return el
      .animate(
        [
          { opacity: 1, transform: "translateY(0) scale(1)" },
          { opacity: 0, transform: `translateY(${isCard ? 8 : 12}px) scale(${isCard ? 0.985 : 0.99})` }
        ],
        {
          duration: isCard ? 160 : 180,
          easing: "ease-out",
          fill: "forwards"
        }
      )
      .finished.catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

function animateBoardLayoutChanges(prevRects) {
  const enteringCardIds = new Set(state.ui.enteringCardIds || []);
  const enteringListIds = new Set(state.ui.enteringListIds || []);
  state.ui.enteringCardIds.clear();
  state.ui.enteringListIds.clear();
  if (prefersReducedMotion()) return;

  const animateFlipGroup = (selector, key, prevMap, duration, options = {}) => {
    const movedIds = new Set();
    const lockAxis = options.lockAxis || "";
    document.querySelectorAll(selector).forEach((el) => {
      const id = el.dataset[key];
      if (!id) return;
      const before = prevMap.get(id);
      const after = el.getBoundingClientRect();
      if (!before) return;
      let dx = before.left - after.left;
      let dy = before.top - after.top;
      if (lockAxis === "x") dy = 0;
      if (lockAxis === "y") dx = 0;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      movedIds.add(id);
      try {
        el.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: "translate(0, 0)" }
          ],
          {
            duration,
            easing: "cubic-bezier(.2,.8,.2,1)"
          }
        );
      } catch {}
    });
    return movedIds;
  };

  const movedListIds = animateFlipGroup(".list[data-list-id]", "listId", prevRects?.lists || new Map(), 260);
  if (movedListIds.size === 0) {
    animateFlipGroup(".card[data-card-id]", "cardId", prevRects?.cards || new Map(), 220, { lockAxis: "y" });
  }

  enteringListIds.forEach((id) => animateElementEnter(document.querySelector(`.list[data-list-id="${id}"]`), "list"));
  enteringCardIds.forEach((id) => animateElementEnter(document.querySelector(`.card[data-card-id="${id}"]`), "card"));
}

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (["POST", "PATCH", "DELETE", "PUT"].includes(method) && state.csrfToken) {
    headers["X-CSRF-Token"] = state.csrfToken;
  }
  const res = await fetch(path, {
    headers,
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (Object.prototype.hasOwnProperty.call(data, "csrfToken")) {
    state.csrfToken = data.csrfToken || null;
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function loadAppMeta() {
  try {
    const meta = await api("/api/meta", { headers: {} });
    if (appVersionEl) appVersionEl.textContent = `v${meta.version}`;
  } catch {
    if (appVersionEl) appVersionEl.textContent = `v${APP_VERSION_FALLBACK}`;
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInlineFormatting(text) {
  let html = escapeHtml(text ?? "");
  html = html.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n][\s\S]*?)\*/g, "$1<em>$2</em>");
  return html;
}

function renderDescriptionHtml(text) {
  return renderInlineFormatting(String(text ?? "")).replace(/\n/g, "<br>");
}

function applyTextareaWrapperShortcut(textarea, marker) {
  if (!textarea) return;
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  const value = textarea.value || "";
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const wrapped = `${marker}${selected}${marker}`;
  textarea.value = `${before}${wrapped}${after}`;
  const cursorStart = start + marker.length;
  const cursorEnd = end + marker.length;
  textarea.focus();
  textarea.setSelectionRange(cursorStart, cursorEnd);
}

function updateSessionInfo() {
  sessionInfoEl.textContent = state.user ? `Signed in as ${state.user.name}` : "";
  if (!activeUsersInfoEl) return;
  if (!state.user) {
    activeUsersInfoEl.innerHTML = "";
    return;
  }
  const names = (state.activeUsers || []).map((u) => u.name).filter(Boolean);
  if (!names.length) {
    activeUsersInfoEl.innerHTML = "";
    return;
  }
  activeUsersInfoEl.innerHTML = `<span class="active-users-label">Active users:</span> ${names
    .map((name) => `<span class="active-user-chip"><span class="active-user-dot" aria-hidden="true"></span>${escapeHtml(name)}</span>`)
    .join(" ")}`;
}

function listCards(list) {
  if (!state.board) return [];
  return list.cardIds.map((id) => state.board.cards[id]).filter(Boolean);
}

function applyData(data) {
  const prevBoard = state.board;
  const nextBoard = data.board;
  const prevCardIds = new Set(Object.keys(prevBoard?.cards || {}));
  const nextCardIds = Object.keys(nextBoard?.cards || {});
  state.ui.enteringCardIds = new Set(
    nextCardIds.filter((id) => !prevCardIds.has(id) && !nextBoard.cards[id]?.archived)
  );
  const prevListIds = new Set((prevBoard?.lists || []).map((l) => l.id));
  state.ui.enteringListIds = new Set((nextBoard?.lists || []).map((l) => l.id).filter((id) => !prevListIds.has(id)));
  state.board = data.board;
  state.users = data.users || [];
  state.activity = data.activity || [];
  if (data.user) state.user = data.user;
  if (Object.prototype.hasOwnProperty.call(data, "csrfToken")) state.csrfToken = data.csrfToken || null;
  render();
}

async function refreshBoard() {
  const data = await api("/api/board");
  markUnseenRemoteUpdates(data.board, data.user);
  state.user = data.user;
  state.board = data.board;
  state.users = data.users || [];
  state.activity = data.activity || [];
  if (Object.prototype.hasOwnProperty.call(data, "csrfToken")) state.csrfToken = data.csrfToken || null;
  ensureRealtimeConnection();
  render();
}

function closeRealtimeConnection() {
  if (realtimeReconnectTimer) {
    clearTimeout(realtimeReconnectTimer);
    realtimeReconnectTimer = null;
  }
  if (realtimeSocket) {
    try {
      realtimeSocket.onclose = null;
      realtimeSocket.close();
    } catch {}
    realtimeSocket = null;
  }
}

function ensureRealtimeConnection() {
  if (!state.user) return;
  if (realtimeSocket && (realtimeSocket.readyState === WebSocket.OPEN || realtimeSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    realtimeSocket = new WebSocket(`${protocol}//${location.host}/ws`);
    realtimeSocket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data || "{}");
        if (msg.type === "active_users") {
          state.activeUsers = Array.isArray(msg.users) ? msg.users : [];
          updateSessionInfo();
          return;
        }
        if (msg.type !== "board_updated") return;
        if (!state.user || !state.board) return;
        const tag = document.activeElement?.tagName;
        if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
        if (state.ui.modalCardId || state.ui.promptDialog || state.ui.labelsDialogOpen) return;
        refreshBoard().catch(() => {});
      } catch {}
    };
    realtimeSocket.onclose = () => {
      realtimeSocket = null;
      if (!state.user) return;
      if (realtimeReconnectTimer) clearTimeout(realtimeReconnectTimer);
      realtimeReconnectTimer = setTimeout(() => ensureRealtimeConnection(), 2000);
    };
    realtimeSocket.onerror = () => {
      try {
        realtimeSocket?.close();
      } catch {}
    };
  } catch {}
}

function markUnseenRemoteUpdates(nextBoard, nextUser) {
  if (!nextBoard || !nextUser) return;
  const prevCards = state.board?.cards || {};
  const nextCards = nextBoard.cards || {};
  const seen = readSeenCards(nextUser.id);
  for (const [cardId, nextCard] of Object.entries(nextCards)) {
    const updatedByOther = nextCard.updatedById && nextCard.updatedById !== nextUser.id;
    if (!updatedByOther) {
      state.ui.unseenUpdatedCardIds.delete(cardId);
      continue;
    }
    const seenUpdatedAt = seen[cardId] || "";
    if (seenUpdatedAt !== (nextCard.updatedAt || "")) {
      state.ui.unseenUpdatedCardIds.add(cardId);
    } else {
      state.ui.unseenUpdatedCardIds.delete(cardId);
    }
  }
  for (const prevCardId of Object.keys(prevCards)) {
    if (!nextCards[prevCardId]) state.ui.unseenUpdatedCardIds.delete(prevCardId);
  }
}

function renderLogin() {
  const tpl = document.getElementById("loginTemplate");
  appEl.innerHTML = "";
  appEl.appendChild(tpl.content.cloneNode(true));
  const form = document.getElementById("loginForm");
  const input = document.getElementById("usernameInput");
  const passwordInput = document.getElementById("passwordInput");
  const confirmPasswordInput = document.getElementById("confirmPasswordInput");
  const rememberMeInput = document.getElementById("rememberMeInput");
  const rememberRow = rememberMeInput?.closest(".remember-row");
  const loginModeBtn = document.getElementById("loginModeBtn");
  const registerModeBtn = document.getElementById("registerModeBtn");
  const authHint = document.getElementById("authHint");
  let mode = "login";

  function syncAuthMode() {
    const isRegister = mode === "register";
    loginModeBtn.classList.toggle("ghost", isRegister);
    registerModeBtn.classList.toggle("ghost", !isRegister);
    form.querySelector("button[type='submit']").textContent = isRegister ? "Register" : "Login";
    confirmPasswordInput.style.display = isRegister ? "" : "none";
    confirmPasswordInput.required = isRegister;
    if (rememberRow) rememberRow.style.display = isRegister ? "none" : "";
    if (isRegister) rememberMeInput.checked = false;
    authHint.textContent = isRegister ? "I'm not storing passwords in plain text, no worries :)" : "";
    authHint.style.display = isRegister ? "" : "none";
    const title = appEl.querySelector(".login-panel h2");
    if (title) title.textContent = isRegister ? "Register" : "Sign In";
  }

  loginModeBtn.addEventListener("click", () => {
    mode = "login";
    syncAuthMode();
  });
  registerModeBtn.addEventListener("click", () => {
    mode = "register";
    syncAuthMode();
  });
  syncAuthMode();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      if (mode === "register" && passwordInput.value !== confirmPasswordInput.value) {
        throw new Error("Passwords do not match");
      }
      const endpoint = mode === "register" ? "/api/register" : "/api/login";
      const data = await api(endpoint, {
        method: "POST",
        body: JSON.stringify({ username: input.value, password: passwordInput.value, rememberMe: rememberMeInput.checked })
      });
      state.user = data.user;
      await refreshBoard();
    } catch (err) {
      alert(err.message);
    }
  });
}

function createCardHtml(card, list) {
  const assigneeIds = Array.isArray(card.assigneeIds) ? card.assigneeIds : (card.assigneeId ? [card.assigneeId] : []);
  const assignees = state.users.filter((u) => assigneeIds.includes(u.id));
  const desc = (card.description || "").trim();
  const checklist = Array.isArray(card.checklist) ? card.checklist : [];
  const labelIds = Array.isArray(card.labelIds) ? card.labelIds : [];
  const labels = (state.board.labels || []).filter((l) => labelIds.includes(l.id));
  const doneCount = checklist.filter((i) => i.done).length;
  const priority = card.priority || "";
  const dueDate = card.dueDate || "";
  const estimate = card.estimate || "";
  const isUpdated = state.ui.unseenUpdatedCardIds.has(card.id);
  const checklistPreview = checklist
    .slice(0, 4)
    .map(
      (item) => `
        <div class="mini-check ${item.done ? "done" : ""}">
          <span class="mini-check-box">${item.done ? "x" : ""}</span>
          <span class="mini-check-text">${escapeHtml(item.text)}</span>
        </div>
      `
    )
    .join("");
  const isDoneList = String(list?.title || "").trim().toLowerCase() === "done";
  const timeInListText = isDoneList ? "" : formatCurrentListTotalTime(card, list);
  const dueClass = getDueDateUrgencyClass(dueDate);
  const assigneeLine = assignees.length ? assignees.map((u) => u.name).join(", ") : "Unassigned";
  const assigneeSummary =
    assignees.length > 2 ? `${assignees.slice(0, 2).map((u) => u.name).join(", ")} +${assignees.length - 2}` : assigneeLine;
  return `
    <article class="card compact-card ${isUpdated ? "card-updated" : ""}" draggable="true" data-card-id="${card.id}">
      <div class="drag-handle" aria-hidden="true">::</div>
      <div class="card-main">
        ${isUpdated ? '<div class="updated-badge">Updated!</div>' : ""}
        <div class="card-title-text">${escapeHtml(card.title)}</div>
        <div class="card-assignees-line">Assigned: ${escapeHtml(assigneeSummary)}</div>
        <div class="card-tags">
          ${labels
            .map(
              (label) =>
                `<span class="pill label-pill" style="background:${escapeHtml(label.color || "#d9d9d9")};border-color:${escapeHtml(label.color || "#d9d9d9")}">${escapeHtml(label.name)}</span>`
            )
            .join("")}
          ${priority ? `<span class="pill priority-${priority} priority-pill">${escapeHtml(priority)}</span>` : ""}
          ${dueDate ? `<span class="pill ${dueClass}">${escapeHtml(dueDate)}</span>` : ""}
          ${estimate ? `<span class="pill">Effort: ${escapeHtml(estimate)}h</span>` : ""}
        </div>
        ${desc ? `<div class="card-preview-block">${renderDescriptionHtml(desc)}</div>` : ""}
        ${checklist.length ? `
          <div class="mini-checklist">
            ${checklistPreview}
            ${checklist.length > 4 ? `<div class="mini-check-more">+${checklist.length - 4} more</div>` : ""}
          </div>
        ` : ""}
        <div class="card-footer-meta">
          <span>Updated ${escapeHtml(formatRelativeOrLocal(card.updatedAt))}</span>
          <span class="card-footer-right">
            ${timeInListText ? `Time here: ${escapeHtml(timeInListText)}` : ""}
            ${isDoneList ? '<button class="small-btn ghost archive-card-inline-btn">Archive</button>' : ""}
          </span>
        </div>
        <div class="card-created-by">Created by: ${escapeHtml(card.createdByName || findUserName(card.createdById) || "Unknown")}</div>
      </div>
    </article>
  `;
}

function createListHtml(list) {
  const cards = listCards(list);
  const isAddOpen = state.ui.openAddCardListId === list.id;
  const isMenuOpen = state.ui.openListMenuId === list.id;
  return `
    <section class="list" data-list-id="${list.id}">
      <div class="list-header">
        <input class="list-title-input" maxlength="60" value="${escapeHtml(list.title)}" />
        <button class="small-btn ghost add-card-inline-btn" title="Add card">Add Card</button>
        <div class="list-menu-wrap">
          <button class="small-btn ghost list-menu-btn" title="List options">&#8942;</button>
          ${isMenuOpen ? `
            <div class="list-menu">
              <button class="list-menu-item rename-list-item">Rename</button>
              <button class="list-menu-item delete-list-item">Delete List</button>
            </div>
          ` : ""}
        </div>
      </div>
      ${isAddOpen ? `
        <form class="new-card-top-form inline-form compact-form">
          <input class="new-card-input" maxlength="100" placeholder="New card title" required />
          <button type="submit" class="small-btn">Add</button>
        </form>
      ` : ""}
      <div class="card-list drop-zone" data-list-id="${list.id}">
        ${cards.map((card) => createCardHtml(card, list)).join("") || '<div class="hint">No cards yet.</div>'}
      </div>
    </section>
  `;
}

function formatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function formatRelativeOrLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function formatDurationSince(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Math.max(0, Date.now() - d.getTime());
  const mins = Math.floor(diff / 60000);
  const days = Math.floor(mins / (60 * 24));
  const hours = Math.floor((mins % (60 * 24)) / 60);
  const remMins = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${remMins}m`;
  return `${Math.max(1, remMins)}m`;
}

function findUserName(userId) {
  return state.users.find((u) => u.id === userId)?.name || "";
}

function getDueDateUrgencyClass(dueDate) {
  if (!dueDate) return "";
  const d = new Date(`${dueDate}T23:59:59`);
  if (Number.isNaN(d.getTime())) return "";
  const diffDays = Math.floor((d.getTime() - Date.now()) / 86400000);
  if (diffDays < 0) return "due-overdue";
  if (diffDays <= 0) return "due-today";
  if (diffDays <= 2) return "due-soon";
  if (diffDays <= 7) return "due-upcoming";
  return "due-later";
}

function formatDurationMs(ms) {
  const safe = Math.max(0, Number(ms) || 0);
  const mins = Math.floor(safe / 60000);
  const days = Math.floor(mins / (60 * 24));
  const hours = Math.floor((mins % (60 * 24)) / 60);
  const remMins = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${remMins}m`;
  return `${Math.max(1, remMins)}m`;
}

function formatCurrentListTotalTime(card, list) {
  if (!card || !list) return "";
  const baseMs = Math.max(0, Number(card.timeByListMs?.[list.id] || 0));
  const entered = new Date(card.listEnteredAt || card.createdAt || Date.now());
  const liveMs = Number.isNaN(entered.getTime()) ? 0 : Math.max(0, Date.now() - entered.getTime());
  return formatDurationMs(baseMs + liveMs);
}

function getActivityIcon(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("added card") || text.includes("created")) return "＋";
  if (text.includes("moved")) return "↕";
  if (text.includes("archiv")) return "◫";
  if (text.includes("delete")) return "✕";
  if (text.includes("rename") || text.includes("updated")) return "✎";
  return "•";
}

function renderActivity() {
  const panel = document.getElementById("activityPanel");
  const container = document.getElementById("activityContainer");
  if (panel) panel.hidden = !state.ui.showActivity;
  if (!container || !state.ui.showActivity) return;
  const items = (state.activity || []).slice(-20).reverse();
  if (!items.length) {
    container.innerHTML = '<article class="activity-item"><small>No activity yet.</small></article>';
    return;
  }
  container.innerHTML = items
    .map((item) => `
        <article class="activity-item">
          <div class="activity-item-head">
            <span class="activity-icon" aria-hidden="true">${escapeHtml(getActivityIcon(item.message))}</span>
            <div class="activity-message"><strong>${escapeHtml(item.actorName || "System")}</strong> ${escapeHtml(item.message || "")}</div>
          </div>
          <small>${escapeHtml(formatTime(item.createdAt))}</small>
        </article>
      `)
    .join("");
}

function renderArchive() {
  const panel = document.getElementById("archivePanel");
  const container = document.getElementById("archiveContainer");
  if (!panel || !container || !state.board) return;
  panel.hidden = !state.ui.showArchive;
  if (!state.ui.showArchive) return;
  const archivedCards = Object.values(state.board.cards || {})
    .filter((c) => c && c.archived)
    .sort((a, b) => String(b.archivedAt || "").localeCompare(String(a.archivedAt || "")))
    .slice(0, 20);
  if (!archivedCards.length) {
    container.innerHTML = '<article class="activity-item"><small>No archived cards.</small></article>';
    return;
  }
  container.innerHTML = archivedCards
    .map(
      (card) => `
      <article class="activity-item archive-item" data-archived-card-id="${card.id}">
        <div class="activity-message"><strong>${escapeHtml(card.title)}</strong></div>
        <small>Archived ${escapeHtml(formatTime(card.archivedAt || card.updatedAt || ""))}</small>
        <div class="archive-item-actions">
          <button class="small-btn ghost restore-archived-card-btn">Restore</button>
        </div>
      </article>
    `
    )
    .join("");
}

function renderModal() {
  const host = document.getElementById("modalHost");
  if (!host) return;
  if (state.ui.labelsDialogOpen) {
    const labels = state.board?.labels || [];
    host.innerHTML = `
      <div class="modal-backdrop" data-close-labels="1">
        <section class="modal-card prompt-modal" role="dialog" aria-modal="true" aria-label="Labels">
          <div class="modal-header">
            <h3>Labels</h3>
            <button class="small-btn ghost close-labels-btn" title="Close">Close</button>
          </div>
          <div class="labels-manager-list">
            ${
              labels.length
                ? labels
                    .map(
                      (label) => `
                <div class="label-edit-row" data-label-edit-id="${label.id}">
                  <input class="label-edit-color" type="color" value="${escapeHtml(label.color || "#d9d9d9")}" />
                  <input class="label-edit-name" maxlength="30" value="${escapeHtml(label.name)}" />
                  <button class="small-btn ghost save-label-edit-btn">Save</button>
                </div>
              `
                    )
                    .join("")
                : '<div class="hint">No labels yet.</div>'
            }
          </div>
          <div class="checklist-section">
            <div class="checklist-header"><span>Create label</span></div>
            <div class="label-edit-row">
              <input id="newLabelColor" class="label-edit-color" type="color" value="#d9d9d9" />
              <input id="newLabelName" class="label-edit-name" maxlength="30" placeholder="Label name" />
              <button id="createLabelFromModalBtn" class="small-btn">Create</button>
            </div>
          </div>
        </section>
      </div>
    `;
    host.querySelector("[data-close-labels]").addEventListener("click", (e) => {
      if (e.target.dataset.closeLabels === "1") closeLabelsDialog();
    });
    host.querySelector(".close-labels-btn").addEventListener("click", closeLabelsDialog);
    host.querySelector(".modal-card").addEventListener("click", (e) => e.stopPropagation());
    host.querySelectorAll(".save-label-edit-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const row = btn.closest("[data-label-edit-id]");
        const labelId = row?.dataset.labelEditId;
        const name = row?.querySelector(".label-edit-name")?.value || "";
        const color = row?.querySelector(".label-edit-color")?.value || "#d9d9d9";
        if (!labelId) return;
        try {
          const data = await api(`/api/labels/${labelId}`, {
            method: "PATCH",
            body: JSON.stringify({ name, color })
          });
          applyData(data);
          state.ui.labelsDialogOpen = true;
          render();
        } catch (err) {
          alert(err.message);
        }
      });
    });
    document.getElementById("createLabelFromModalBtn")?.addEventListener("click", async () => {
      const name = document.getElementById("newLabelName")?.value || "";
      const color = document.getElementById("newLabelColor")?.value || "#d9d9d9";
      try {
        const data = await api("/api/labels", {
          method: "POST",
          body: JSON.stringify({ name, color })
        });
        applyData(data);
        state.ui.labelsDialogOpen = true;
        render();
      } catch (err) {
        alert(err.message);
      }
    });
    return;
  }
  if (state.ui.promptDialog) {
    const p = state.ui.promptDialog;
    host.innerHTML = `
      <div class="modal-backdrop" data-close-prompt="1">
        <section class="modal-card prompt-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(p.title)}">
          <div class="modal-header">
            <h3>${escapeHtml(p.title)}</h3>
            <button class="small-btn ghost close-prompt-btn" title="Close">Close</button>
          </div>
          <div class="modal-grid">
            <label class="full">
              <span>${escapeHtml(p.label || "Name")}</span>
              <input id="promptModalInput" maxlength="${Number(p.maxLength || 60)}" placeholder="${escapeHtml(p.placeholder || "")}" value="${escapeHtml(p.value || "")}" />
            </label>
          </div>
          <div class="modal-actions">
            <button id="promptModalConfirmBtn">${escapeHtml(p.confirmText || "Create")}</button>
          </div>
        </section>
      </div>
    `;
    host.querySelector("[data-close-prompt]").addEventListener("click", (e) => {
      if (e.target.dataset.closePrompt === "1") resolvePromptDialog(null);
    });
    host.querySelector(".close-prompt-btn").addEventListener("click", () => resolvePromptDialog(null));
    host.querySelector(".modal-card").addEventListener("click", (e) => e.stopPropagation());
    const input = document.getElementById("promptModalInput");
    input?.focus();
    input?.select();
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        document.getElementById("promptModalConfirmBtn")?.click();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        resolvePromptDialog(null);
      }
    });
    document.getElementById("promptModalConfirmBtn").addEventListener("click", () => {
      resolvePromptDialog(input?.value ?? "");
    });
    return;
  }
  if (!state.ui.modalCardId || !state.board?.cards[state.ui.modalCardId]) {
    host.innerHTML = "";
    return;
  }

  const card = state.board.cards[state.ui.modalCardId];
  if (!Array.isArray(card.checklist)) card.checklist = [];
  if (!Array.isArray(card.labelIds)) card.labelIds = [];
  if (!Array.isArray(card.assigneeIds)) card.assigneeIds = card.assigneeId ? [card.assigneeId] : [];
  if (!["", "low", "medium", "high"].includes(card.priority || "")) card.priority = "";
  if (typeof card.dueDate !== "string") card.dueDate = "";
  if (typeof card.estimate !== "string") card.estimate = "";
  const currentList = state.board.lists.find((l) => l.cardIds.includes(card.id));
  const listOptions = state.board.lists
    .map((l) => `<option value="${l.id}" ${currentList?.id === l.id ? "selected" : ""}>${escapeHtml(l.title)}</option>`)
    .join("");

  host.innerHTML = `
    <div class="modal-backdrop" data-close-modal="1">
      <section class="modal-card" role="dialog" aria-modal="true" aria-label="Card details">
        <div class="modal-header">
          <h3>Card Details</h3>
          <button class="small-btn ghost close-modal-btn" title="Close">Close</button>
        </div>
        <div class="modal-grid">
          <label>
            <span>Title</span>
            <input id="modalCardTitle" maxlength="100" value="${escapeHtml(card.title)}" />
          </label>
          <label>
            <span>Assignee</span>
            <select id="modalCardAssignee">${renderAssigneeSelectOptions(card.assigneeIds)}</select>
          </label>
          <label>
            <span>List</span>
            <select id="modalCardList">${listOptions}</select>
          </label>
          <label>
            <span>Priority</span>
            <select id="modalCardPriority">
              <option value="" ${!card.priority ? "selected" : ""}>None</option>
              <option value="low" ${card.priority === "low" ? "selected" : ""}>Low</option>
              <option value="medium" ${card.priority === "medium" ? "selected" : ""}>Medium</option>
              <option value="high" ${card.priority === "high" ? "selected" : ""}>High</option>
            </select>
          </label>
          <label>
            <span>Due Date</span>
            <input id="modalCardDueDate" type="date" value="${escapeHtml(card.dueDate || "")}" />
          </label>
          <label>
            <span>Estimate Effort</span>
            <input id="modalCardEstimate" maxlength="30" placeholder="e.g. 2h / 3 pts" value="${escapeHtml(card.estimate || "")}" />
          </label>
          <label class="full">
            <span>Description</span>
            <div class="description-toolbar" role="toolbar" aria-label="Description formatting">
              <button type="button" class="small-btn ghost desc-format-btn" data-format="bold" title="Bold (Ctrl/Cmd+B)"><strong>B</strong></button>
              <button type="button" class="small-btn ghost desc-format-btn" data-format="italic" title="Italic (Ctrl/Cmd+I)"><em>I</em></button>
            </div>
            <textarea id="modalCardDescription" maxlength="500" placeholder="Description">${escapeHtml(card.description || "")}</textarea>
          </label>
          <div class="full checklist-section">
            <div class="checklist-header">
              <span>Labels</span>
            </div>
            <details class="modal-dropdown">
              <summary class="modal-dropdown-summary">${escapeHtml(formatLabelSummaryForModal(card.labelIds))}</summary>
              <div id="modalLabelItems" class="label-options modal-dropdown-content">
                ${renderCardLabelOptions(card.labelIds)}
              </div>
            </details>
          </div>
          <div class="full checklist-section">
            <div class="checklist-header">
              <span>Checklist</span>
              <button type="button" id="modalAddChecklistItemBtn" class="small-btn ghost">+ Item</button>
            </div>
            <div id="modalChecklistItems" class="checklist-items">
              ${renderChecklistItems(card.checklist)}
            </div>
          </div>
        </div>
        <div class="modal-meta">
          <small>Created: ${escapeHtml(formatTime(card.createdAt || ""))} by ${escapeHtml(card.createdByName || findUserName(card.createdById) || "Unknown")}</small>
          <small>Updated: ${escapeHtml(formatTime(card.updatedAt || ""))}</small>
        </div>
        <div class="modal-actions">
          <button id="modalDeleteCardBtn" class="danger">Archive Card</button>
        </div>
      </section>
    </div>
  `;

  host.querySelector("[data-close-modal]").addEventListener("click", async (e) => {
    if (e.target.dataset.closeModal === "1") await closeCardModal();
  });
  host.querySelector(".close-modal-btn").addEventListener("click", () => closeCardModal());
  host.querySelector(".modal-card").addEventListener("click", (e) => e.stopPropagation());
  document.getElementById("modalDeleteCardBtn").addEventListener("click", deleteModalCard);
  const descriptionTextarea = document.getElementById("modalCardDescription");
  host.querySelectorAll(".desc-format-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.format;
      applyTextareaWrapperShortcut(descriptionTextarea, mode === "bold" ? "**" : "*");
    });
  });
  descriptionTextarea?.addEventListener("keydown", (e) => {
    if (e.altKey) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = String(e.key || "").toLowerCase();
    if (k === "b") {
      e.preventDefault();
      applyTextareaWrapperShortcut(descriptionTextarea, "**");
    } else if (k === "i") {
      e.preventDefault();
      applyTextareaWrapperShortcut(descriptionTextarea, "*");
    }
  });
  document.getElementById("modalAddChecklistItemBtn").addEventListener("click", () => {
    const container = document.getElementById("modalChecklistItems");
    const empty = container.querySelector(".checklist-empty");
    if (empty) empty.remove();
    container.insertAdjacentHTML("beforeend", checklistItemRowHtml({ id: `tmp-${cryptoRandom()}`, text: "", done: false }));
    const lastInput = container.querySelector(".checklist-row:last-child .checklist-text");
    lastInput?.focus();
  });
  document.getElementById("modalChecklistItems").addEventListener("click", (e) => {
    const btn = e.target.closest(".checklist-remove-btn");
    if (!btn) return;
    btn.closest(".checklist-row")?.remove();
    const container = document.getElementById("modalChecklistItems");
    if (!container.querySelector(".checklist-row")) {
      container.innerHTML = '<div class="hint checklist-empty">No checklist items yet.</div>';
    }
  });
}

function cryptoRandom() {
  return Math.random().toString(36).slice(2, 10);
}

function checklistItemRowHtml(item) {
  return `
    <div class="checklist-row" data-item-id="${escapeHtml(item.id)}">
      <input class="checklist-done" type="checkbox" ${item.done ? "checked" : ""} />
      <input class="checklist-text" type="text" maxlength="120" placeholder="Checklist item" value="${escapeHtml(item.text || "")}" />
      <button type="button" class="small-btn ghost checklist-remove-btn" title="Remove item">x</button>
    </div>
  `;
}

function renderChecklistItems(items) {
  if (!items.length) {
    return '<div class="hint checklist-empty">No checklist items yet.</div>';
  }
  return items.map((item) => checklistItemRowHtml(item)).join("");
}

function renderCardLabelOptions(selectedLabelIds, asSelect = false) {
  const labels = state.board?.labels || [];
  if (!labels.length) return '<div class="hint">No labels created yet.</div>';
  return labels
    .map(
      (label) => `
      <label class="label-option-row" data-label-id="${label.id}">
        <input class="modal-label-checkbox" type="checkbox" value="${label.id}" ${selectedLabelIds.includes(label.id) ? "checked" : ""} />
        <span class="pill label-pill" style="background:${escapeHtml(label.color || "#d9d9d9")};border-color:${escapeHtml(label.color || "#d9d9d9")}">${escapeHtml(label.name)}</span>
      </label>
    `
    )
    .join("");
}

function renderAssigneeSelectOptions(selectedAssigneeIds) {
  const selectedId = Array.isArray(selectedAssigneeIds) ? selectedAssigneeIds[0] || "" : "";
  return [`<option value="">Unassigned</option>`]
    .concat(
      state.users.map(
        (u) => `<option value="${u.id}" ${u.id === selectedId ? "selected" : ""}>${escapeHtml(u.name)}</option>`
      )
    )
    .join("");
}

function formatLabelSummaryForModal(selectedLabelIds) {
  const names = (state.board?.labels || []).filter((l) => selectedLabelIds.includes(l.id)).map((l) => l.name);
  if (!names.length) return "Select labels";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

function collectChecklistFromModal(cardId) {
  const container = document.getElementById("modalChecklistItems");
  if (!container) {
    return Array.isArray(state.board?.cards?.[cardId]?.checklist) ? state.board.cards[cardId].checklist : [];
  }
  const rows = [...container.querySelectorAll(".checklist-row")];
  const hasExplicitEmptyState = Boolean(container.querySelector(".checklist-empty"));
  if (!rows.length && !hasExplicitEmptyState) {
    return Array.isArray(state.board?.cards?.[cardId]?.checklist) ? state.board.cards[cardId].checklist : [];
  }
  return rows
    .map((row) => ({
      id: row.dataset.itemId || `tmp-${cryptoRandom()}`,
      text: row.querySelector(".checklist-text")?.value?.trim() || "",
      done: Boolean(row.querySelector(".checklist-done")?.checked)
    }))
    .filter((item) => item.text);
}

function collectLabelIdsFromModal() {
  return [...document.querySelectorAll("#modalLabelItems .modal-label-checkbox:checked")].map((el) => el.value);
}

function collectAssigneeIdFromModal() {
  return document.getElementById("modalCardAssignee")?.value || "";
}

function renderBoard() {
  const prevRects = snapshotBoardRects();
  const tpl = document.getElementById("boardTemplate");
  appEl.innerHTML = "";
  appEl.appendChild(tpl.content.cloneNode(true));

  const listsContainer = document.getElementById("listsContainer");
  listsContainer.innerHTML = state.board.lists.map(createListHtml).join("");
  const listCount = state.board.lists.length || 1;
  listsContainer.style.setProperty("--list-columns", String(Math.max(1, Math.min(4, listCount))));
  listsContainer.classList.toggle("scrollable-lists", listCount > 4);
  document.getElementById("toggleActivityBtn").textContent = state.ui.showActivity ? "Hide Activity" : "Show Activity";
  document.getElementById("toggleArchiveBtn").textContent = state.ui.showArchive ? "Hide Archive" : "Show Archive";
  renderArchive();
  renderActivity();
  renderModal();
  attachBoardHandlers();
  requestAnimationFrame(() => animateBoardLayoutChanges(prevRects));
}

function render() {
  updateSessionInfo();
  applyTheme(document.documentElement.dataset.theme || readThemePreference());
  if (!state.user || !state.board) return renderLogin();
  renderBoard();
}

function showError(err) {
  alert(err.message || String(err));
}

function closeAllMenus() {
  if (state.ui.openListMenuId !== null) {
    state.ui.openListMenuId = null;
    render();
  }
}

function forceCloseCardModal() {
  state.ui.modalCardId = null;
  render();
}

function closeLabelsDialog() {
  state.ui.labelsDialogOpen = false;
  render();
}

function openPromptDialog(config) {
  return new Promise((resolve) => {
    state.ui.promptDialog = { ...config, _resolve: resolve };
    render();
  });
}

function resolvePromptDialog(value) {
  const resolver = state.ui.promptDialog?._resolve;
  state.ui.promptDialog = null;
  render();
  if (resolver) resolver(value);
}

function openCardModal(cardId) {
  markCardAsSeen(cardId);
  state.ui.modalCardId = cardId;
  render();
}

function markCardAsSeen(cardId) {
  const userId = state.user?.id;
  const card = state.board?.cards?.[cardId];
  if (!userId || !card) return;
  const seen = readSeenCards(userId);
  seen[cardId] = card.updatedAt || new Date().toISOString();
  writeSeenCards(userId, seen);
  state.ui.unseenUpdatedCardIds.delete(cardId);
}

async function persistModalCardChanges(cardId = state.ui.modalCardId) {
  const current = state.board.cards[cardId];
  if (!current) return;
  if (current.archived) return true;

  const title = document.getElementById("modalCardTitle").value.trim();
  const description = document.getElementById("modalCardDescription").value;
  const assigneeId = collectAssigneeIdFromModal();
  const targetListId = document.getElementById("modalCardList").value;
  const priority = document.getElementById("modalCardPriority").value;
  const dueDate = document.getElementById("modalCardDueDate").value;
  const estimate = document.getElementById("modalCardEstimate").value.trim();
  const checklist = collectChecklistFromModal(cardId);
  const labelIds = collectLabelIdsFromModal();
  if (!title) return alert("Card title is required");

  const currentAssigneeId = Array.isArray(current.assigneeIds) ? (current.assigneeIds[0] || "") : (current.assigneeId || "");
  const currentListId = state.board.lists.find((l) => l.cardIds.includes(cardId))?.id || "";
  const currentChecklist = Array.isArray(current.checklist) ? current.checklist : [];
  const currentLabelIds = Array.isArray(current.labelIds) ? current.labelIds : [];
  const noFieldChanges =
    title === (current.title || "") &&
    description === (current.description || "") &&
    assigneeId === currentAssigneeId &&
    priority === (current.priority || "") &&
    dueDate === (current.dueDate || "") &&
    estimate === (current.estimate || "") &&
    JSON.stringify(checklist) === JSON.stringify(currentChecklist) &&
    JSON.stringify(labelIds) === JSON.stringify(currentLabelIds);
  const noListChange = !targetListId || targetListId === currentListId;
  if (noFieldChanges && noListChange) return true;

  try {
    let data = await api(`/api/cards/${cardId}`, {
      method: "PATCH",
      body: JSON.stringify({ title, description, assigneeId, checklist, labelIds, priority, dueDate, estimate })
    });
    const currentList = data.board.lists.find((l) => l.cardIds.includes(cardId));
    if (targetListId && currentList && currentList.id !== targetListId) {
      data = await api(`/api/cards/${cardId}/move`, {
        method: "POST",
        body: JSON.stringify({ targetListId })
      });
    }
    applyData(data);
    return true;
  } catch (err) {
    alert(err.message);
    return false;
  }
}

async function closeCardModal() {
  const cardId = state.ui.modalCardId;
  if (!cardId) return;
  const ok = await persistModalCardChanges(cardId);
  if (!ok) return;
  forceCloseCardModal();
}

async function archiveCard(cardId) {
  try {
    await animateElementExit(document.querySelector(`.card[data-card-id="${cardId}"]`), "card");
    const data = await api(`/api/cards/${cardId}/archive`, { method: "POST" });
    if (state.ui.modalCardId === cardId) state.ui.modalCardId = null;
    applyData(data);
  } catch (err) {
    alert(err.message);
  }
}

async function restoreArchivedCard(cardId) {
  try {
    const data = await api(`/api/cards/${cardId}/unarchive`, { method: "POST" });
    applyData(data);
  } catch (err) {
    alert(err.message);
  }
}

async function deleteModalCard() {
  const cardId = state.ui.modalCardId;
  if (!cardId) return;
  if (!confirm("Archive this card?")) return;
  await archiveCard(cardId);
}

async function submitNewCard(listId, title) {
  const cleanTitle = title.trim();
  if (!cleanTitle) return;
  const data = await api("/api/cards", {
    method: "POST",
    body: JSON.stringify({ listId, title: cleanTitle })
  });
  applyData(data);
}

async function moveCard(cardId, targetListId, position) {
  if (!cardId || !targetListId) return;
  const data = await api(`/api/cards/${cardId}/move`, {
    method: "POST",
    body: JSON.stringify({ targetListId, position })
  });
  applyData(data);
}

function getDropPosition(cardListEl, y, draggingCardId) {
  const cards = [...cardListEl.querySelectorAll(".card[data-card-id]")].filter(
    (el) => el.dataset.cardId !== draggingCardId
  );
  for (let i = 0; i < cards.length; i += 1) {
    const rect = cards[i].getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return i;
  }
  return cards.length;
}

function getDropPlaceholder(cardListEl) {
  let el = cardListEl.querySelector(".card-drop-placeholder");
  if (!el) {
    el = document.createElement("div");
    el.className = "card-drop-placeholder";
  }
  return el;
}

function renderDropPlaceholder(cardListEl, y, draggingCardId) {
  const placeholder = getDropPlaceholder(cardListEl);
  const cards = [...cardListEl.querySelectorAll(".card[data-card-id]")].filter((el) => el.dataset.cardId !== draggingCardId);
  let inserted = false;
  for (const cardEl of cards) {
    const rect = cardEl.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      if (cardEl.previousElementSibling !== placeholder) cardListEl.insertBefore(placeholder, cardEl);
      inserted = true;
      break;
    }
  }
  if (!inserted) cardListEl.appendChild(placeholder);
}

function clearAllDropPlaceholders() {
  document.querySelectorAll(".card-drop-placeholder").forEach((el) => el.remove());
}

function attachBoardHandlers() {
  document.addEventListener("click", handleOutsideMenuClick, { once: true });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST" });
      state.user = null;
      state.board = null;
      state.users = [];
      state.activity = [];
      state.activeUsers = [];
      state.csrfToken = null;
      closeRealtimeConnection();
      state.ui = { openListMenuId: null, openAddCardListId: null, modalCardId: null, dragCardId: null, unseenUpdatedCardIds: new Set(), enteringCardIds: new Set(), enteringListIds: new Set(), showActivity: false, showArchive: false, promptDialog: null, labelsDialogOpen: false };
      render();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById("addListBtn").addEventListener("click", async () => {
    const title = await openPromptDialog({
      title: "Create List",
      label: "List name",
      placeholder: "e.g. Backlog",
      maxLength: 60,
      confirmText: "Create"
    });
    if (title === null) return;
    try {
      const data = await api("/api/lists", {
        method: "POST",
        body: JSON.stringify({ title })
      });
      applyData(data);
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById("manageLabelsBtn").addEventListener("click", () => {
    state.ui.labelsDialogOpen = true;
    render();
  });
  document.getElementById("toggleActivityBtn").addEventListener("click", () => {
    state.ui.showActivity = !state.ui.showActivity;
    render();
  });

  document.getElementById("toggleArchiveBtn").addEventListener("click", () => {
    state.ui.showArchive = !state.ui.showArchive;
    render();
  });

  document.querySelectorAll(".restore-archived-card-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cardId = btn.closest("[data-archived-card-id]")?.dataset.archivedCardId;
      if (!cardId) return;
      await restoreArchivedCard(cardId);
    });
  });

  document.querySelectorAll(".list").forEach((listEl) => {
    const listId = listEl.dataset.listId;
    const titleInput = listEl.querySelector(".list-title-input");

    titleInput.addEventListener("blur", async () => {
      const nextTitle = titleInput.value.trim();
      const current = state.board.lists.find((l) => l.id === listId);
      if (!current) return;
      if (!nextTitle) {
        titleInput.value = current.title;
        return;
      }
      if (nextTitle === current.title) return;
      try {
        const data = await api(`/api/lists/${listId}`, {
          method: "PATCH",
          body: JSON.stringify({ title: nextTitle })
        });
        applyData(data);
      } catch (err) {
        alert(err.message);
      }
    });
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        titleInput.blur();
      }
    });

    listEl.querySelector(".add-card-inline-btn").addEventListener("click", (e) => {
      e.preventDefault();
      state.ui.openAddCardListId = state.ui.openAddCardListId === listId ? null : listId;
      render();
    });

    listEl.querySelector(".list-menu-btn").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.ui.openListMenuId = state.ui.openListMenuId === listId ? null : listId;
      render();
    });

    const renameBtn = listEl.querySelector(".rename-list-item");
    if (renameBtn) {
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.ui.openListMenuId = null;
        render();
        requestAnimationFrame(() => {
          const refreshed = document.querySelector(`.list[data-list-id="${listId}"] .list-title-input`);
          refreshed?.focus();
          refreshed?.select();
        });
      });
    }

    const deleteListBtn = listEl.querySelector(".delete-list-item");
    if (deleteListBtn) {
      deleteListBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this list and all its cards?")) return;
        try {
          await animateElementExit(listEl, "list");
          const data = await api(`/api/lists/${listId}`, { method: "DELETE" });
          state.ui.openListMenuId = null;
          if (state.ui.openAddCardListId === listId) state.ui.openAddCardListId = null;
          applyData(data);
        } catch (err) {
          alert(err.message);
        }
      });
    }

    const addCardForm = listEl.querySelector(".new-card-top-form");
    if (addCardForm) {
      addCardForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = addCardForm.querySelector(".new-card-input");
        try {
          await submitNewCard(listId, input.value);
          state.ui.openAddCardListId = null;
          render();
        } catch (err) {
          alert(err.message);
        }
      });
    }

    const cardListEl = listEl.querySelector(".card-list");
    listEl.addEventListener("dragover", (e) => {
      // Prevent accidental drops on the header/title area.
      if (!e.target.closest(".card-list")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "none";
      }
    });
    listEl.addEventListener("drop", (e) => {
      if (!e.target.closest(".card-list")) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    cardListEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      cardListEl.classList.add("drag-over");
      renderDropPlaceholder(cardListEl, e.clientY, state.ui.dragCardId);
    });
    cardListEl.addEventListener("dragleave", (e) => {
      if (!cardListEl.contains(e.relatedTarget)) {
        cardListEl.classList.remove("drag-over");
        cardListEl.querySelector(".card-drop-placeholder")?.remove();
      }
    });
    cardListEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      cardListEl.classList.remove("drag-over");
      const cardId = e.dataTransfer.getData("text/plain") || state.ui.dragCardId;
      if (!cardId) return;
      try {
        const position = getDropPosition(cardListEl, e.clientY, cardId);
        await moveCard(cardId, listId, position);
      } catch (err) {
        alert(err.message);
      } finally {
        state.ui.dragCardId = null;
        clearAllDropPlaceholders();
      }
    });

    listEl.querySelectorAll(".card[data-card-id]").forEach((cardEl) => {
      const cardId = cardEl.dataset.cardId;
      const archiveBtn = cardEl.querySelector(".archive-card-inline-btn");
      if (archiveBtn) {
        archiveBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await archiveCard(cardId);
        });
      }
      cardEl.addEventListener("click", (e) => {
        if (e.target.closest("button, input, select, textarea, details, summary")) return;
        openCardModal(cardId);
      });
      cardEl.addEventListener("dragstart", (e) => {
        state.ui.dragCardId = cardId;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", cardId);
        cardEl.classList.add("dragging");
      });
      cardEl.addEventListener("dragend", () => {
        state.ui.dragCardId = null;
        cardEl.classList.remove("dragging");
        document.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
        clearAllDropPlaceholders();
      });
    });
  });

  if (state.ui.modalCardId) {
    document.addEventListener("keydown", handleEscapeModal, { once: true });
  }
}

function handleOutsideMenuClick(e) {
  if (e.target.closest(".list-menu-wrap")) return;
  if (state.ui.openListMenuId) {
    state.ui.openListMenuId = null;
    render();
  }
}

function handleEscapeModal(e) {
  if (e.key === "Escape" && state.ui.modalCardId) {
    closeCardModal().catch(() => {});
  }
}

async function init() {
  try {
    applyTheme(readThemePreference());
    if (themeToggleBtn) themeToggleBtn.addEventListener("click", toggleTheme);
    await loadAppMeta();
    const me = await api("/api/me");
    if (!me.user) return render();
    state.user = me.user;
    await refreshBoard();
  } catch {
    render();
  }
}

setInterval(() => {
  if (!state.user || !state.board) return;
  const tag = document.activeElement?.tagName;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
  if (state.ui.modalCardId) return;
  refreshBoard().catch(() => {});
}, 60000);

init();

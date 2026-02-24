const state = {
  user: null,
  board: null,
  users: [],
  activity: [],
  csrfToken: null,
  ui: {
    openListMenuId: null,
    openAddCardListId: null,
    modalCardId: null,
    dragCardId: null,
    unseenUpdatedCardIds: new Set(),
    showArchive: false,
    promptDialog: null,
    labelsDialogOpen: false
  }
};

const appEl = document.getElementById("app");
const sessionInfoEl = document.getElementById("sessionInfo");
const appVersionEl = document.getElementById("appVersion");
const APP_VERSION_FALLBACK = "0.6.2";
let realtimeSocket = null;
let realtimeReconnectTimer = null;

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

function updateSessionInfo() {
  sessionInfoEl.textContent = state.user ? `Signed in as ${state.user.name}` : "";
}

function listCards(list) {
  if (!state.board) return [];
  return list.cardIds.map((id) => state.board.cards[id]).filter(Boolean);
}

function applyData(data) {
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
        ${desc ? `<div class="card-preview-block">${escapeHtml(desc)}</div>` : ""}
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
        <button class="small-btn ghost add-card-inline-btn" title="Add card">+ Card</button>
        <div class="list-menu-wrap">
          <button class="small-btn ghost list-menu-btn" title="List options">...</button>
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

function renderActivity() {
  const container = document.getElementById("activityContainer");
  if (!container) return;
  const items = (state.activity || []).slice(-20).reverse();
  if (!items.length) {
    container.innerHTML = '<article class="activity-item"><small>No activity yet.</small></article>';
    return;
  }
  container.innerHTML = items
    .map((item) => `
      <article class="activity-item">
        <div class="activity-message"><strong>${escapeHtml(item.actorName || "System")}</strong> ${escapeHtml(item.message || "")}</div>
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
  const tpl = document.getElementById("boardTemplate");
  appEl.innerHTML = "";
  appEl.appendChild(tpl.content.cloneNode(true));

  const listsContainer = document.getElementById("listsContainer");
  listsContainer.innerHTML = state.board.lists.map(createListHtml).join("");
  const listCount = state.board.lists.length || 1;
  listsContainer.style.setProperty("--list-columns", String(Math.max(1, Math.min(4, listCount))));
  listsContainer.classList.toggle("scrollable-lists", listCount > 4);
  document.getElementById("toggleArchiveBtn").textContent = state.ui.showArchive ? "Hide Archive" : "Show Archive";
  renderArchive();
  renderActivity();
  renderModal();
  attachBoardHandlers();
}

function render() {
  updateSessionInfo();
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

function attachBoardHandlers() {
  document.addEventListener("click", handleOutsideMenuClick, { once: true });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST" });
      state.user = null;
      state.board = null;
      state.users = [];
      state.activity = [];
      state.csrfToken = null;
      closeRealtimeConnection();
      state.ui = { openListMenuId: null, openAddCardListId: null, modalCardId: null, dragCardId: null, unseenUpdatedCardIds: new Set(), showArchive: false, promptDialog: null, labelsDialogOpen: false };
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
    });
    cardListEl.addEventListener("dragleave", (e) => {
      if (!cardListEl.contains(e.relatedTarget)) cardListEl.classList.remove("drag-over");
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

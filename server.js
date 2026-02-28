const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { promisify } = require("util");
const pkg = require("./package.json");
const scryptAsync = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.TASK_ORG_DATA_DIR
  ? path.resolve(process.env.TASK_ORG_DATA_DIR)
  : path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const SECURITY_PATH = path.join(DATA_DIR, "security.json");

const sessions = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const loginAttempts = new Map();
const wsClients = new Set();
let notifyRealtime = () => {};

function ensureSecurityStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SECURITY_PATH)) {
    fs.writeFileSync(SECURITY_PATH, JSON.stringify({ sessions: [], loginAttempts: [] }, null, 2), "utf8");
  }
}

function loadSecurityState() {
  ensureSecurityStore();
  try {
    const raw = JSON.parse(fs.readFileSync(SECURITY_PATH, "utf8"));
    sessions.clear();
    loginAttempts.clear();
    for (const s of raw.sessions || []) {
      if (!s?.sid || !s?.userId) continue;
      if (s.expiresAt && Date.now() > Number(s.expiresAt)) continue;
      sessions.set(String(s.sid), {
        userId: String(s.userId),
        csrfToken: String(s.csrfToken || ""),
        rememberMe: Boolean(s.rememberMe),
        expiresAt: Number(s.expiresAt || 0)
      });
    }
    for (const item of raw.loginAttempts || []) {
      if (!item?.key) continue;
      const blockedUntil = Number(item.blockedUntil || 0);
      const firstAt = Number(item.firstAt || 0);
      if (blockedUntil && Date.now() > blockedUntil) continue;
      if (firstAt && Date.now() - firstAt > LOGIN_WINDOW_MS && !blockedUntil) continue;
      loginAttempts.set(String(item.key), {
        count: Number(item.count || 0),
        firstAt,
        blockedUntil
      });
    }
  } catch {
    sessions.clear();
    loginAttempts.clear();
  }
}

function saveSecurityState() {
  ensureSecurityStore();
  const data = {
    sessions: [...sessions.entries()].map(([sid, s]) => ({ sid, ...s })),
    loginAttempts: [...loginAttempts.entries()].map(([key, v]) => ({ key, ...v }))
  };
  fs.writeFileSync(SECURITY_PATH, JSON.stringify(data, null, 2), "utf8");
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    const initial = {
      users: [],
      activity: [],
      authAudit: [],
      board: {
        id: "board-1",
        labels: [],
        name: "Team Board",
        lists: [
          { id: "list-todo", title: "To Do", cardIds: [] },
          { id: "list-doing", title: "Doing", cardIds: [] },
          { id: "list-done", title: "Done", cardIds: [] }
        ],
        cards: {}
      }
    };
    fs.writeFileSync(STORE_PATH, JSON.stringify(initial, null, 2), "utf8");
  }
}

function readStore() {
  ensureStore();
  const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  if (!Array.isArray(store.users)) store.users = [];
  for (const user of store.users) {
    if (typeof user.passwordHash !== "string") user.passwordHash = "";
    if (typeof user.passwordSalt !== "string") user.passwordSalt = "";
    if (typeof user.passwordAlgo !== "string") user.passwordAlgo = user.passwordHash ? "scrypt" : "";
  }
  if (!Array.isArray(store.activity)) store.activity = [];
  if (!Array.isArray(store.authAudit)) store.authAudit = [];
  if (!store.board) {
    store.board = { id: "board-1", name: "Team Board", labels: [], lists: [], cards: {} };
  }
  if (!Array.isArray(store.board.labels)) store.board.labels = [];
  for (const label of store.board.labels) {
    if (typeof label.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(label.color)) {
      label.color = "#d9d9d9";
    }
  }
  if (!Array.isArray(store.board.lists)) store.board.lists = [];
  if (!store.board.cards || typeof store.board.cards !== "object") store.board.cards = {};
  for (const card of Object.values(store.board.cards)) {
    if (!Array.isArray(card.checklist)) card.checklist = [];
    if (!Array.isArray(card.labelIds)) card.labelIds = [];
    if (!Array.isArray(card.assigneeIds)) {
      card.assigneeIds = card.assigneeId ? [card.assigneeId] : [];
    }
    if (!["low", "medium", "high", "critical", ""].includes(card.priority || "")) card.priority = "";
    if (typeof card.dueDate !== "string") card.dueDate = "";
    if (typeof card.estimate !== "string") card.estimate = "";
    if (typeof card.createdAt !== "string") card.createdAt = card.updatedAt || new Date().toISOString();
    if (typeof card.createdByName !== "string") card.createdByName = "";
    if (typeof card.updatedById !== "string") card.updatedById = card.createdById || "";
    if (typeof card.listEnteredAt !== "string") card.listEnteredAt = card.createdAt || card.updatedAt || new Date().toISOString();
    if (!card.timeByListMs || typeof card.timeByListMs !== "object") card.timeByListMs = {};
    if (typeof card.archived !== "boolean") card.archived = false;
    if (typeof card.archivedAt !== "string") card.archivedAt = "";
    if (typeof card.archivedById !== "string") card.archivedById = "";
    if (typeof card.archivedFromListId !== "string") card.archivedFromListId = "";
  }
  return store;
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
  notifyRealtime({ type: "board_updated", at: nowIso() });
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  const cookies = {};
  cookieHeader.split(";").forEach((part) => {
    const [rawKey, ...rest] = part.trim().split("=");
    if (!rawKey) return;
    cookies[rawKey] = decodeURIComponent(rest.join("="));
  });
  return cookies;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data));
}

function getClientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
}

function nowIso() {
  return new Date().toISOString();
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(text);
}

function encodeWsTextFrame(text) {
  const payload = Buffer.from(String(text), "utf8");
  const len = payload.length;
  if (len < 126) {
    return Buffer.concat([Buffer.from([0x81, len]), payload]);
  }
  if (len < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([header, payload]);
}

function broadcastWsMessage(obj) {
  const frame = encodeWsTextFrame(JSON.stringify(obj));
  for (const socket of wsClients) {
    if (socket.destroyed) {
      wsClients.delete(socket);
      continue;
    }
    try {
      socket.write(frame);
    } catch {
      wsClients.delete(socket);
      try {
        socket.destroy();
      } catch {}
    }
  }
}

function getActiveUsersSnapshot() {
  const byId = new Map();
  for (const socket of wsClients) {
    if (!socket || socket.destroyed) continue;
    const user = socket._taskOrgUser;
    if (!user?.id || !user?.name) continue;
    if (!byId.has(user.id)) byId.set(user.id, { id: user.id, name: user.name });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function broadcastActiveUsers() {
  broadcastWsMessage({ type: "active_users", users: getActiveUsersSnapshot(), at: nowIso() });
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getSessionUser(req, store) {
  const sessionCtx = getSessionContext(req, store);
  return sessionCtx?.user || null;
}

function getSessionContext(req, store) {
  const sid = parseCookies(req).sid;
  if (!sid || !sessions.has(sid)) return null;
  const session = sessions.get(sid);
  if (!session || typeof session !== "object") {
    sessions.delete(sid);
    return null;
  }
  if (session.expiresAt && Date.now() > session.expiresAt) {
    sessions.delete(sid);
    saveSecurityState();
    return null;
  }
  const user = store.users.find((u) => u.id === session.userId) || null;
  if (!user) {
    sessions.delete(sid);
    saveSecurityState();
    return null;
  }
  return { sid, session, user };
}

function requireAuth(req, res, store) {
  const ctx = getSessionContext(req, store);
  if (!ctx?.user) {
    sendJson(res, 401, { error: "Unauthorized" });
    return null;
  }
  return ctx.user;
}

function toBoardResponse(store) {
  return {
    board: store.board,
    users: store.users.map(toPublicUser),
    activity: store.activity
  };
}

function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name
  };
}

function attachCsrf(data, req, store) {
  const ctx = getSessionContext(req, store);
  if (!ctx?.session?.csrfToken) return data;
  return { ...data, csrfToken: ctx.session.csrfToken };
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function issueCsrfToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function hashPassword(password, saltHex = crypto.randomBytes(16).toString("hex")) {
  const derived = await scryptAsync(password, saltHex, 64);
  return {
    saltHex,
    hashHex: Buffer.from(derived).toString("hex"),
    algo: "scrypt"
  };
}

async function verifyPassword(password, user) {
  if (!user?.passwordHash || !user?.passwordSalt) return false;
  const derived = await scryptAsync(password, user.passwordSalt, 64);
  const stored = Buffer.from(user.passwordHash, "hex");
  const incoming = Buffer.from(derived);
  if (stored.length !== incoming.length) return false;
  return crypto.timingSafeEqual(stored, incoming);
}

function accumulateListTime(card, listId) {
  if (!card || !listId) return;
  const enteredAt = new Date(card.listEnteredAt || card.createdAt || Date.now());
  const delta = Math.max(0, Date.now() - enteredAt.getTime());
  if (!card.timeByListMs || typeof card.timeByListMs !== "object") card.timeByListMs = {};
  card.timeByListMs[listId] = Math.max(0, Number(card.timeByListMs[listId] || 0)) + delta;
}

function logActivity(store, user, message) {
  const actorName = user?.name || "System";
  store.activity.push({
    id: makeId("activity"),
    actorId: user?.id || null,
    actorName,
    message,
    createdAt: new Date().toISOString()
  });
  if (store.activity.length > 120) {
    store.activity = store.activity.slice(-120);
  }
}

function logAuthAudit(store, req, event) {
  store.authAudit.push({
    id: makeId("auth"),
    at: nowIso(),
    ip: getClientIp(req),
    ...event
  });
  if (store.authAudit.length > 500) {
    store.authAudit = store.authAudit.slice(-500);
  }
}

function getLoginKey(req, username) {
  return `${getClientIp(req)}|${String(username || "").toLowerCase()}`;
}

function getRateLimitState(req, username) {
  const key = getLoginKey(req, username);
  const state = loginAttempts.get(key);
  if (!state) return { key, count: 0, firstAt: 0, blockedUntil: 0 };
  if (state.blockedUntil && Date.now() > state.blockedUntil) {
    loginAttempts.delete(key);
    return { key, count: 0, firstAt: 0, blockedUntil: 0 };
  }
  if (state.firstAt && Date.now() - state.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return { key, count: 0, firstAt: 0, blockedUntil: 0 };
  }
  return { key, ...state };
}

function recordLoginFailure(req, username) {
  const key = getLoginKey(req, username);
  const prev = getRateLimitState(req, username);
  const firstAt = prev.count > 0 ? prev.firstAt : Date.now();
  const count = prev.count + 1;
  const blockedUntil = count >= LOGIN_MAX_ATTEMPTS ? Date.now() + LOGIN_BLOCK_MS : 0;
  loginAttempts.set(key, { count, firstAt, blockedUntil });
  saveSecurityState();
  return { count, blockedUntil };
}

function clearLoginFailures(req, username) {
  loginAttempts.delete(getLoginKey(req, username));
  saveSecurityState();
}

function setSession(res, userId, rememberMe = false) {
  const sid = crypto.randomBytes(24).toString("hex");
  const maxAgeMs = rememberMe ? SESSION_REMEMBER_TTL_MS : SESSION_TTL_MS;
  sessions.set(sid, {
    userId,
    csrfToken: issueCsrfToken(),
    rememberMe: Boolean(rememberMe),
    expiresAt: Date.now() + maxAgeMs
  });
  const cookieParts = [`sid=${sid}`, "HttpOnly", "Path=/", "SameSite=Lax"];
  if (rememberMe) cookieParts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  res.setHeader("Set-Cookie", cookieParts.join("; "));
  saveSecurityState();
  return sessions.get(sid);
}

function clearSession(req, res) {
  const sid = parseCookies(req).sid;
  if (sid) sessions.delete(sid);
  saveSecurityState();
  res.setHeader("Set-Cookie", "sid=; Max-Age=0; Path=/; SameSite=Lax");
}

function requireCsrf(req, res, store) {
  const method = req.method || "GET";
  if (!["POST", "PATCH", "DELETE", "PUT"].includes(method)) return true;
  const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  if (pathname === "/api/login" || pathname === "/api/register") return true;
  if (!pathname.startsWith("/api/")) return true;
  const ctx = getSessionContext(req, store);
  if (!ctx?.session) {
    sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }
  const token = String(req.headers["x-csrf-token"] || "");
  if (!token || token !== ctx.session.csrfToken) {
    sendJson(res, 403, { error: "Invalid CSRF token" });
    return false;
  }
  return true;
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, "Forbidden");
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === "ENOENT") return sendText(res, 404, "Not found");
      return sendText(res, 500, "Server error");
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };
    sendText(res, 200, content, contentTypes[ext] || "application/octet-stream");
  });
}

async function handleApi(req, res, urlObj) {
  const { pathname } = urlObj;
  const store = readStore();
  if (!requireCsrf(req, res, store)) return;

  if (pathname === "/api/register" && req.method === "POST") {
    const body = await parseBody(req);
    const username = String(body.username || "").trim().slice(0, 30);
    const password = String(body.password || "");
    const rememberMe = Boolean(body.rememberMe);
    if (!username) return badRequest(res, "Username is required");
    if (password.length < 8) {
      logAuthAudit(store, req, { type: "register_failed", username, reason: "password_too_short" });
      writeStore(store);
      return badRequest(res, "Password must be at least 8 characters");
    }
    const exists = store.users.find((u) => u.name.toLowerCase() === username.toLowerCase());
    if (exists) {
      logAuthAudit(store, req, { type: "register_failed", username, reason: "username_exists" });
      writeStore(store);
      return badRequest(res, "Username already exists");
    }
    const pw = await hashPassword(password);
    const user = {
      id: makeId("user"),
      name: username,
      passwordHash: pw.hashHex,
      passwordSalt: pw.saltHex,
      passwordAlgo: pw.algo
    };
    store.users.push(user);
    logActivity(store, user, "joined the workspace");
    logAuthAudit(store, req, { type: "register_success", userId: user.id, username: user.name });
    writeStore(store);
    const session = setSession(res, user.id, rememberMe);
    return sendJson(res, 201, { user: toPublicUser(user), csrfToken: session.csrfToken });
  }

  if (pathname === "/api/login" && req.method === "POST") {
    const body = await parseBody(req);
    const username = String(body.username || "").trim().slice(0, 30);
    const password = String(body.password || "");
    const rememberMe = Boolean(body.rememberMe);
    if (!username || !password) return badRequest(res, "Username and password are required");
    const rate = getRateLimitState(req, username);
    if (rate.blockedUntil && Date.now() < rate.blockedUntil) {
      logAuthAudit(store, req, { type: "login_blocked", username, reason: "rate_limited" });
      writeStore(store);
      return sendJson(res, 429, { error: "Too many attempts. Try again later." });
    }

    const user = store.users.find((u) => u.name.toLowerCase() === username.toLowerCase());
    if (!user) {
      recordLoginFailure(req, username);
      logAuthAudit(store, req, { type: "login_failed", username, reason: "invalid_credentials" });
      writeStore(store);
      return sendJson(res, 401, { error: "Invalid credentials" });
    }
    const valid = await verifyPassword(password, user);
    if (!valid) {
      recordLoginFailure(req, username);
      logAuthAudit(store, req, { type: "login_failed", userId: user.id, username, reason: "invalid_credentials" });
      writeStore(store);
      return sendJson(res, 401, { error: "Invalid credentials" });
    }
    if (!user.passwordHash || !user.passwordSalt) {
      logAuthAudit(store, req, { type: "login_failed", userId: user.id, username, reason: "account_not_configured" });
      writeStore(store);
      return sendJson(res, 401, { error: "Account not configured" });
    }
    clearLoginFailures(req, username);
    const session = setSession(res, user.id, rememberMe);
    logAuthAudit(store, req, { type: "login_success", userId: user.id, username: user.name, rememberMe });
    writeStore(store);
    return sendJson(res, 200, { user: toPublicUser(user), csrfToken: session.csrfToken });
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    const ctx = getSessionContext(req, store);
    if (ctx?.user) {
      logAuthAudit(store, req, { type: "logout", userId: ctx.user.id, username: ctx.user.name });
      writeStore(store);
    }
    clearSession(req, res);
    return sendJson(res, 200, { ok: true, csrfToken: null });
  }

  if (pathname === "/api/me" && req.method === "GET") {
    const ctx = getSessionContext(req, store);
    return sendJson(res, 200, { user: ctx?.user ? toPublicUser(ctx.user) : null, csrfToken: ctx?.session?.csrfToken || null });
  }

  if (pathname === "/api/change-password" && req.method === "POST") {
    const user = requireAuth(req, res, store);
    if (!user) return;
    const body = await parseBody(req);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (!currentPassword || !newPassword) return badRequest(res, "Current and new password are required");
    if (newPassword.length < 8) return badRequest(res, "Password must be at least 8 characters");
    const valid = await verifyPassword(currentPassword, user);
    if (!valid) {
      logAuthAudit(store, req, { type: "password_change_failed", userId: user.id, username: user.name, reason: "invalid_current_password" });
      writeStore(store);
      return sendJson(res, 401, { error: "Invalid current password" });
    }
    const pw = await hashPassword(newPassword);
    user.passwordHash = pw.hashHex;
    user.passwordSalt = pw.saltHex;
    user.passwordAlgo = pw.algo;
    logAuthAudit(store, req, { type: "password_changed", userId: user.id, username: user.name });
    writeStore(store);
    return sendJson(res, 200, attachCsrf({ ok: true }, req, store));
  }

  if (pathname === "/api/meta" && req.method === "GET") {
    return sendJson(res, 200, { version: pkg.version, name: "Task Organizer" });
  }

  if (pathname === "/api/board" && req.method === "GET") {
    const user = requireAuth(req, res, store);
    if (!user) return;
    return sendJson(res, 200, attachCsrf({ user: toPublicUser(user), ...toBoardResponse(store) }, req, store));
  }

  if (pathname === "/api/lists" && req.method === "POST") {
    const user = requireAuth(req, res, store);
    if (!user) return;
    const body = await parseBody(req);
    const title = String(body.title || "").trim().slice(0, 60);
    if (!title) return badRequest(res, "List title is required");
    store.board.lists.push({ id: makeId("list"), title, cardIds: [] });
    logActivity(store, user, `created list "${title}"`);
    writeStore(store);
    return sendJson(res, 201, { ok: true, ...toBoardResponse(store) });
  }

  if (pathname === "/api/labels" && req.method === "POST") {
    const user = requireAuth(req, res, store);
    if (!user) return;
    const body = await parseBody(req);
    const name = String(body.name || "").trim().slice(0, 30);
    const color = /^#[0-9a-fA-F]{6}$/.test(String(body.color || "")) ? String(body.color) : "#d9d9d9";
    if (!name) return badRequest(res, "Label name is required");
    if (store.board.labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      return badRequest(res, "Label already exists");
    }
    const label = { id: makeId("label"), name, color };
    store.board.labels.push(label);
    logActivity(store, user, `created label "${name}"`);
    writeStore(store);
    return sendJson(res, 201, { ok: true, ...toBoardResponse(store) });
  }

  if (pathname.startsWith("/api/labels/") && req.method === "PATCH") {
    const user = requireAuth(req, res, store);
    if (!user) return;
    const labelId = pathname.split("/")[3];
    const label = store.board.labels.find((l) => l.id === labelId);
    if (!label) return notFound(res);
    const body = await parseBody(req);
    const nextName = body.name !== undefined ? String(body.name || "").trim().slice(0, 30) : label.name;
    const nextColor = body.color !== undefined ? String(body.color || "") : label.color;
    if (!nextName) return badRequest(res, "Label name is required");
    if (!/^#[0-9a-fA-F]{6}$/.test(nextColor)) return badRequest(res, "Invalid label color");
    if (
      store.board.labels.some((l) => l.id !== labelId && l.name.toLowerCase() === nextName.toLowerCase())
    ) {
      return badRequest(res, "Label already exists");
    }
    const oldName = label.name;
    label.name = nextName;
    label.color = nextColor;
    logActivity(store, user, `updated label "${oldName}"`);
    writeStore(store);
    return sendJson(res, 200, { ok: true, ...toBoardResponse(store) });
  }

  if (pathname.startsWith("/api/lists/") && req.method === "PATCH") {
    const user = requireAuth(req, res, store);
    if (!user) return;
    const listId = pathname.split("/")[3];
    const list = store.board.lists.find((l) => l.id === listId);
    if (!list) return notFound(res);
    const body = await parseBody(req);
    const title = String(body.title || "").trim().slice(0, 60);
    if (!title) return badRequest(res, "List title is required");
    const oldTitle = list.title;
    list.title = title;
    logActivity(store, user, `renamed list "${oldTitle}" to "${title}"`);
    writeStore(store);
    return sendJson(res, 200, { ok: true, ...toBoardResponse(store) });
  }

  if (pathname.startsWith("/api/lists/") && req.method === "DELETE") {
    const user = requireAuth(req, res, store);
    if (!user) return;
    const listId = pathname.split("/")[3];
    const idx = store.board.lists.findIndex((l) => l.id === listId);
    if (idx === -1) return notFound(res);
    const [removed] = store.board.lists.splice(idx, 1);
    for (const cardId of removed.cardIds) delete store.board.cards[cardId];
    logActivity(store, user, `deleted list "${removed.title}"`);
    writeStore(store);
    return sendJson(res, 200, { ok: true, ...toBoardResponse(store) });
  }

  if (pathname === "/api/cards" && req.method === "POST") {
    const user = requireAuth(req, res, store);
    if (!user) return;
    const body = await parseBody(req);
    const listId = String(body.listId || "");
    const title = String(body.title || "").trim().slice(0, 100);
    if (!listId || !title) return badRequest(res, "listId and title are required");
    const list = store.board.lists.find((l) => l.id === listId);
    if (!list) return notFound(res);
    const card = {
      id: makeId("card"),
      title,
      description: "",
      checklist: [],
      labelIds: [],
      priority: "",
      dueDate: "",
      estimate: "",
      listEnteredAt: new Date().toISOString(),
      timeByListMs: {},
      archived: false,
      archivedAt: "",
      archivedById: "",
      archivedFromListId: "",
      assigneeId: user.id,
      assigneeIds: [user.id],
      createdById: user.id,
      createdByName: user.name,
      updatedById: user.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    store.board.cards[card.id] = card;
    list.cardIds.unshift(card.id);
    logActivity(store, user, `added card "${title}" to "${list.title}"`);
    writeStore(store);
    return sendJson(res, 201, { ok: true, ...toBoardResponse(store) });
  }

  if (pathname.startsWith("/api/cards/") && req.method === "PATCH") {
    const user = requireAuth(req, res, store);
    if (!user) return;
    const cardId = pathname.split("/")[3];
    const card = store.board.cards[cardId];
    if (!card) return notFound(res);
    if (card.archived) return badRequest(res, "Cannot edit archived card");
    const body = await parseBody(req);
    const changes = [];
    if (body.title !== undefined) {
      const title = String(body.title).trim().slice(0, 100);
      if (!title) return badRequest(res, "Card title cannot be empty");
      if (card.title !== title) changes.push(`renamed card to "${title}"`);
      card.title = title;
    }
    if (body.description !== undefined) {
      if ((card.description || "") !== String(body.description).slice(0, 500)) {
        changes.push("updated card description");
      }
      card.description = String(body.description).slice(0, 500);
    }
    if (body.checklist !== undefined) {
      if (!Array.isArray(body.checklist)) return badRequest(res, "Checklist must be an array");
      const checklist = body.checklist
        .slice(0, 30)
        .map((item) => ({
          id: String(item.id || makeId("chk")),
          text: String(item.text || "").trim().slice(0, 120),
          done: Boolean(item.done)
        }))
        .filter((item) => item.text);
      const prev = JSON.stringify(card.checklist || []);
      const next = JSON.stringify(checklist);
      if (prev !== next) changes.push("updated checklist");
      card.checklist = checklist;
    }
    if (body.labelIds !== undefined) {
      if (!Array.isArray(body.labelIds)) return badRequest(res, "labelIds must be an array");
      const validLabelIds = new Set(store.board.labels.map((l) => l.id));
      const normalized = [...new Set(body.labelIds.map((id) => String(id)).filter((id) => validLabelIds.has(id)))].slice(0, 12);
      const prev = JSON.stringify(card.labelIds || []);
      const next = JSON.stringify(normalized);
      if (prev !== next) changes.push("updated labels");
      card.labelIds = normalized;
    }
    if (body.priority !== undefined) {
      const priority = String(body.priority || "");
      if (!["", "low", "medium", "high", "critical"].includes(priority)) {
        return badRequest(res, "Invalid priority");
      }
      if ((card.priority || "") !== priority) changes.push(priority ? `set priority to ${priority}` : "cleared priority");
      card.priority = priority;
    }
    if (body.dueDate !== undefined) {
      const dueDate = String(body.dueDate || "");
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        return badRequest(res, "Invalid due date");
      }
      if ((card.dueDate || "") !== dueDate) changes.push(dueDate ? "updated due date" : "cleared due date");
      card.dueDate = dueDate;
    }
    if (body.estimate !== undefined) {
      const rawEstimate = String(body.estimate || "").trim();
      let estimate = "";
      if (rawEstimate !== "") {
        const n = Number(rawEstimate);
        if (!Number.isFinite(n) || n < 0) {
          return badRequest(res, "Estimate effort must be hours (number)");
        }
        estimate = String(Math.round(n * 100) / 100);
      }
      if ((card.estimate || "") !== estimate) changes.push(estimate ? "updated estimate effort" : "cleared estimate effort");
      card.estimate = estimate;
    }
    if (body.assigneeIds !== undefined || body.assigneeId !== undefined) {
      let assigneeIds = [];
      if (body.assigneeIds !== undefined) {
        if (!Array.isArray(body.assigneeIds)) return badRequest(res, "assigneeIds must be an array");
        assigneeIds = [...new Set(body.assigneeIds.map((id) => String(id)).filter(Boolean))];
      } else {
        assigneeIds = body.assigneeId ? [String(body.assigneeId)] : [];
      }
      const validUserIds = new Set(store.users.map((u) => u.id));
      if (assigneeIds.some((id) => !validUserIds.has(id))) return badRequest(res, "Invalid assignee");
      const prevIds = JSON.stringify(card.assigneeIds || (card.assigneeId ? [card.assigneeId] : []));
      const nextIds = JSON.stringify(assigneeIds);
      if (prevIds !== nextIds) changes.push(assigneeIds.length ? "updated assignees" : "cleared assignees");
      card.assigneeIds = assigneeIds;
      card.assigneeId = assigneeIds[0] || null;
    }
    card.updatedById = user.id;
    card.updatedAt = new Date().toISOString();
    if (changes.length > 0) {
      logActivity(store, user, `${changes.join("; ")} (${card.title})`);
    }
    writeStore(store);
    return sendJson(res, 200, { ok: true, ...toBoardResponse(store) });
  }

  if (pathname.startsWith("/api/cards/") && pathname.endsWith("/move") && req.method === "POST") {
    const user = requireAuth(req, res, store);
    if (!user) return;
    const parts = pathname.split("/");
    const cardId = parts[3];
    const card = store.board.cards[cardId];
    if (!card) return notFound(res);
    if (card.archived) return badRequest(res, "Cannot move archived card");
    if (!Array.isArray(card.checklist)) card.checklist = [];
    const body = await parseBody(req);
    const targetListId = String(body.targetListId || "");
    const targetList = store.board.lists.find((l) => l.id === targetListId);
    if (!targetList) return badRequest(res, "Invalid target list");
    let sourceList = null;
    for (const list of store.board.lists) {
      const i = list.cardIds.indexOf(cardId);
      if (i !== -1) {
        sourceList = list;
        list.cardIds.splice(i, 1);
        break;
      }
    }
    if (!sourceList) return notFound(res);
    accumulateListTime(card, sourceList.id);
    const position = Number.isInteger(body.position) ? body.position : targetList.cardIds.length;
    const insertAt = Math.max(0, Math.min(position, targetList.cardIds.length));
    targetList.cardIds.splice(insertAt, 0, cardId);
    card.listEnteredAt = new Date().toISOString();
    card.updatedById = user.id;
    card.updatedAt = new Date().toISOString();
    logActivity(store, user, `moved "${card.title}" to "${targetList.title}"`);
    writeStore(store);
    return sendJson(res, 200, { ok: true, ...toBoardResponse(store) });
  }

  if (pathname.startsWith("/api/cards/") && pathname.endsWith("/archive") && req.method === "POST") {
    const user = requireAuth(req, res, store);
    if (!user) return;
    const cardId = pathname.split("/")[3];
    const card = store.board.cards[cardId];
    if (!card) return notFound(res);
    if (card.archived) return badRequest(res, "Card already archived");
    let sourceList = null;
    for (const list of store.board.lists) {
      const idx = list.cardIds.indexOf(cardId);
      if (idx !== -1) {
        sourceList = list;
        list.cardIds.splice(idx, 1);
        break;
      }
    }
    if (sourceList) accumulateListTime(card, sourceList.id);
    card.archived = true;
    card.archivedAt = new Date().toISOString();
    card.archivedById = user.id;
    card.archivedFromListId = sourceList?.id || card.archivedFromListId || "";
    card.updatedById = user.id;
    card.updatedAt = new Date().toISOString();
    logActivity(store, user, `archived card "${card.title}"`);
    writeStore(store);
    return sendJson(res, 200, { ok: true, ...toBoardResponse(store) });
  }

  if (pathname.startsWith("/api/cards/") && pathname.endsWith("/unarchive") && req.method === "POST") {
    const user = requireAuth(req, res, store);
    if (!user) return;
    const cardId = pathname.split("/")[3];
    const card = store.board.cards[cardId];
    if (!card) return notFound(res);
    if (!card.archived) return badRequest(res, "Card is not archived");
    const preferred = store.board.lists.find((l) => l.id === card.archivedFromListId);
    const fallback = store.board.lists.find((l) => l.title.toLowerCase() !== "done") || store.board.lists[0];
    const targetList = preferred || fallback;
    if (!targetList) return badRequest(res, "No list available to restore card");
    targetList.cardIds.unshift(cardId);
    card.archived = false;
    card.archivedAt = "";
    card.archivedById = "";
    card.archivedFromListId = "";
    card.listEnteredAt = new Date().toISOString();
    card.updatedById = user.id;
    card.updatedAt = new Date().toISOString();
    logActivity(store, user, `restored archived card "${card.title}" to "${targetList.title}"`);
    writeStore(store);
    return sendJson(res, 200, { ok: true, ...toBoardResponse(store) });
  }

  if (pathname.startsWith("/api/cards/") && req.method === "DELETE") {
    const user = requireAuth(req, res, store);
    if (!user) return;
    const cardId = pathname.split("/")[3];
    if (!store.board.cards[cardId]) return notFound(res);
    const cardTitle = store.board.cards[cardId].title;
    delete store.board.cards[cardId];
    for (const list of store.board.lists) {
      list.cardIds = list.cardIds.filter((id) => id !== cardId);
    }
    logActivity(store, user, `deleted card "${cardTitle}"`);
    writeStore(store);
    return sendJson(res, 200, { ok: true, ...toBoardResponse(store) });
  }

  return notFound(res);
}

function handleWebSocketUpgrade(req, socket) {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (urlObj.pathname !== "/ws") return socket.destroy();
    const key = req.headers["sec-websocket-key"];
    if (!key) return socket.destroy();
    const accept = crypto
      .createHash("sha1")
      .update(String(key) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n"
      ].join("\r\n")
    );
    let activeUser = null;
    try {
      const store = readStore();
      const ctx = getSessionContext(req, store);
      if (ctx?.user) activeUser = toPublicUser(ctx.user);
    } catch {}
    if (activeUser) socket._taskOrgUser = activeUser;
    wsClients.add(socket);
    socket.on("data", (buf) => {
      if (!buf || buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      if (opcode === 0x8) {
        wsClients.delete(socket);
        broadcastActiveUsers();
        socket.end();
      }
      // We ignore incoming messages; client only listens.
    });
    socket.on("close", () => {
      wsClients.delete(socket);
      broadcastActiveUsers();
    });
    socket.on("end", () => {
      wsClients.delete(socket);
      broadcastActiveUsers();
    });
    socket.on("error", () => {
      wsClients.delete(socket);
      broadcastActiveUsers();
    });
    socket.write(encodeWsTextFrame(JSON.stringify({ type: "connected", at: nowIso() })));
    socket.write(encodeWsTextFrame(JSON.stringify({ type: "active_users", users: getActiveUsersSnapshot(), at: nowIso() })));
    broadcastActiveUsers();
  } catch {
    try {
      socket.destroy();
    } catch {}
  }
}

function createAppServer() {
  loadSecurityState();
  notifyRealtime = broadcastWsMessage;
  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (urlObj.pathname.startsWith("/api/")) {
        return await handleApi(req, res, urlObj);
      }
      return serveStatic(req, res, urlObj.pathname);
    } catch (err) {
      if (err && err.message === "Invalid JSON") return badRequest(res, "Invalid JSON");
      console.error(err);
      sendJson(res, 500, { error: "Server error" });
    }
  });
  server.on("upgrade", (req, socket) => handleWebSocketUpgrade(req, socket));
  return server;
}

if (require.main === module) {
  const server = createAppServer();
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = { createAppServer };

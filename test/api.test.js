const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-org-test-"));
}

async function startServer() {
  const dataDir = makeTempDir();
  process.env.TASK_ORG_DATA_DIR = dataDir;
  const modPath = path.resolve(__dirname, "..", "server.js");
  delete require.cache[modPath];
  const { createAppServer } = require(modPath);
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return {
    dataDir,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      delete process.env.TASK_ORG_DATA_DIR;
    }
  };
}

async function apiFetch(baseUrl, pathName, { method = "GET", body, cookie, csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

test("register/login returns sanitized user and remember-me cookie", async () => {
  const tctx = await startServer();
  try {
    const { res, json } = await apiFetch(tctx.baseUrl, "/api/register", {
      method: "POST",
      body: { username: "Alice", password: "StrongPass123", rememberMe: true }
    });
    assert.equal(res.status, 201);
    assert.equal(json.user.name, "Alice");
    assert.ok(json.csrfToken);
    assert.equal(Object.prototype.hasOwnProperty.call(json.user, "passwordHash"), false);
    const setCookie = res.headers.get("set-cookie") || "";
    assert.match(setCookie, /sid=/);
    assert.match(setCookie, /Max-Age=/);

    const login = await apiFetch(tctx.baseUrl, "/api/login", {
      method: "POST",
      body: { username: "Alice", password: "StrongPass123", rememberMe: false }
    });
    assert.equal(login.res.status, 200);
    assert.ok(login.json.csrfToken);
  } finally {
    await tctx.close();
  }
});

test("board mutations require CSRF token", async () => {
  const tctx = await startServer();
  try {
    const reg = await apiFetch(tctx.baseUrl, "/api/register", {
      method: "POST",
      body: { username: "Bob", password: "StrongPass123", rememberMe: false }
    });
    assert.equal(reg.res.status, 201);
    const cookie = (reg.res.headers.get("set-cookie") || "").split(";")[0];
    const csrf = reg.json.csrfToken;
    assert.ok(cookie);
    assert.ok(csrf);

    const noCsrf = await apiFetch(tctx.baseUrl, "/api/lists", {
      method: "POST",
      cookie,
      body: { title: "Blocked" }
    });
    assert.equal(noCsrf.res.status, 403);

    const ok = await apiFetch(tctx.baseUrl, "/api/lists", {
      method: "POST",
      cookie,
      csrf,
      body: { title: "Blocked" }
    });
    assert.equal(ok.res.status, 201);
    assert.equal(ok.json.board.lists.some((l) => l.title === "Blocked"), true);
  } finally {
    await tctx.close();
  }
});

test("login rate limiting blocks repeated failures and writes auth audit logs", async () => {
  const tctx = await startServer();
  try {
    const reg = await apiFetch(tctx.baseUrl, "/api/register", {
      method: "POST",
      body: { username: "Carol", password: "StrongPass123" }
    });
    assert.equal(reg.res.status, 201);

    let lastStatus = 0;
    for (let i = 0; i < 9; i += 1) {
      const attempt = await apiFetch(tctx.baseUrl, "/api/login", {
        method: "POST",
        body: { username: "Carol", password: "WrongPass999" }
      });
      lastStatus = attempt.res.status;
    }
    assert.equal(lastStatus, 429);

    const storePath = path.join(tctx.dataDir, "store.json");
    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.ok(Array.isArray(store.authAudit));
    assert.ok(store.authAudit.some((e) => e.type === "register_success"));
    assert.ok(store.authAudit.some((e) => e.type === "login_failed"));
    assert.ok(store.authAudit.some((e) => e.type === "login_blocked"));
  } finally {
    await tctx.close();
  }
});

test("card priority accepts critical and rejects invalid values", async () => {
  const tctx = await startServer();
  try {
    const reg = await apiFetch(tctx.baseUrl, "/api/register", {
      method: "POST",
      body: { username: "Dana", password: "StrongPass123", rememberMe: false }
    });
    assert.equal(reg.res.status, 201);
    const cookie = (reg.res.headers.get("set-cookie") || "").split(";")[0];
    const csrf = reg.json.csrfToken;
    assert.ok(cookie);
    assert.ok(csrf);

    const createList = await apiFetch(tctx.baseUrl, "/api/lists", {
      method: "POST",
      cookie,
      csrf,
      body: { title: "Todo" }
    });
    assert.equal(createList.res.status, 201);
    const listId = createList.json.board.lists.find((l) => l.title === "Todo")?.id;
    assert.ok(listId);

    const createCard = await apiFetch(tctx.baseUrl, "/api/cards", {
      method: "POST",
      cookie,
      csrf,
      body: { title: "Urgent fix", listId }
    });
    assert.equal(createCard.res.status, 201);
    const cardId = Object.values(createCard.json.board.cards).find((c) => c.title === "Urgent fix")?.id;
    assert.ok(cardId);

    const setCritical = await apiFetch(tctx.baseUrl, `/api/cards/${cardId}`, {
      method: "PATCH",
      cookie,
      csrf,
      body: { priority: "critical" }
    });
    assert.equal(setCritical.res.status, 200);
    assert.equal(setCritical.json.board.cards[cardId].priority, "critical");

    const setInvalid = await apiFetch(tctx.baseUrl, `/api/cards/${cardId}`, {
      method: "PATCH",
      cookie,
      csrf,
      body: { priority: "urgent" }
    });
    assert.equal(setInvalid.res.status, 400);
    assert.match(String(setInvalid.json.error || ""), /Invalid priority/i);
  } finally {
    await tctx.close();
  }
});

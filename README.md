# Task Organizer

A Trello-like multi-user task organizer web app built with plain Node.js and vanilla frontend code.

Version: `v1.1.21`

## Features

- Shared multi-user board
- Register/login with password hashing (`scrypt` + salt)
- Lists and cards (create/edit/move/archive)
- Card details modal (checklist, labels, metadata)
- Label management with colors
- Realtime updates via WebSocket
- Activity feed + auth audit logging
- CSRF protection for mutating requests
- Login rate limiting / brute-force protection
- Persistent sessions + rate-limit state

## Tech Stack

- Node.js built-in `http` server
- Vanilla HTML / CSS / JS
- JSON file persistence (`data/store.json`, `data/security.json`)

## Requirements

- Node.js 18+ (Node 20 recommended)

## Run Locally

```powershell
npm start
```

Open `http://localhost:3000`

## Testing

```powershell
npm test
```

Tests currently cover:

- register/login (sanitized responses + remember me cookie)
- CSRF protection on board mutations
- login rate limiting + auth audit log writes
- card priority validation (`critical` accepted, invalid values rejected)

## CI/CD

- CI (`.github/workflows/ci.yml`)
  - Runs on push/PR to `main`
  - Validates syntax (`server.js`, `public/app.js`)
  - Runs test suite (`npm test`) on Node 20 and 22
- CD (`.github/workflows/cd.yml`)
  - Runs on tag push matching `v*`
  - Builds and pushes Docker image to GHCR:
    - `ghcr.io/<owner>/task-organizer`

## Project Structure

- `server.js` - API, auth, security, websocket, persistence
- `public/` - frontend
- `test/` - automated tests
- `data/` - runtime JSON data (git-ignored)

## Security Notes

- Passwords are never stored in plaintext
- Passwords are hashed with salted `scrypt`
- Timing-safe password verification
- CSRF token required for `POST/PATCH/DELETE/PUT` API calls (except login/register)
- Login rate limiting + temporary blocking
- Auth audit events persisted in `data/store.json`

## Data Files

- `data/store.json` - board data, users, activity, auth audit
- `data/security.json` - sessions + login rate limit state

Both are ignored by git.

## Realtime Updates

- Clients connect to `/ws`
- Server broadcasts `board_updated`
- Frontend refreshes board on incoming updates

## GitHub

- Repo: `https://github.com/hudakjakub/Task_organizer.git`
- Default branch: `main`

## Suggested Next Steps

- Password change UI (backend endpoint already exists)
- Role-based permissions (`owner`, `member`)
- Database storage (SQLite/Postgres)
- Docker deployment files
- E2E tests (Playwright)

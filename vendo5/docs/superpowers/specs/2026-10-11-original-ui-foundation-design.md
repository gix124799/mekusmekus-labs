# Sub-project #6: Original UI Foundation — Admin Shell & Dashboard

Status: draft, pending review (amended 2026-10-11 while writing the implementation plan: see "Amendments")
Project: MekusMekus Labs — vendo5 (replacement app for WiFi5-Soft `/soft`)
Depends on: #2 Offline Vendo & Captive Portal (session store, firewall gate, ARP),
  #3 Network & Firewall Provisioning
Supersedes: #5 Admin Dashboard (the simple `/admin` page and its `/admin/api/*`
  routes are removed once the original admin UI works; see "Removed")

## Purpose

Make vendo5 look and behave like the original WiFi5-Soft product, starting with the
admin side, **without any vendor cloud, licence server or remote-control channel**.
The approach is to run the original, unmodified frontend (already in the repo under
`legacy/wifi5-soft/frontend-decrypted/public`, 85 MB, identical to the tree analysed in
`ETHYLNET-REA-FEATURE-MAP`) against a backend that implements the same socket.io
contract. Layout and behaviour are then identical by construction, and the work is the
backend that has to exist anyway.

This sub-project builds the shared groundwork and the first visible slice: the admin
login, the admin shell, the dashboard, system logs, and notifications. Later
sub-projects add pages; each one only registers more handlers and enables more menu
entries.

## Decisions (agreed during brainstorming)

| # | Decision | Reason |
|---|---|---|
| D1 | Reuse the original frontend unchanged; implement a compatible backend | "Same layout, same features, same functions"; the event contract is already decoded |
| D2 | Cloud-only pieces are **hidden**, not stubbed: E-load (4 pages), Online Payment (3), Phone Rental (2), and the cloud payment buttons in the customer portal | Everything the operator sees must work offline; coin cash-in stays (it is local) |
| D3 | First slice = foundation + admin shell & dashboard | Smallest end-to-end proof that the original UI runs on vendo5 |
| D4 | The admin password is stored **in plaintext in a 0600 file**, like the original | The original login computes `md5(tokenHalf + typedPassword)` in the browser, so the server must know the password; a stored hash cannot verify it. Trade-off accepted: weaker at rest, but the password never crosses the LAN. *(Amended: the original login page also posted the plaintext password in a form to `/admin`; that is closed by stripping the inputs' `name` attributes, see Amendments 1.)* |
| D5 | The menu shows **only implemented pages** | A page that is not built yet must not be reachable. The same allowlist also hides the cloud pages |

## Scope

In scope:
- Serving the original frontends at their original URLs from vendo5's own Node server
- socket.io 4.7.5 transport mounted at the original path, with the original session-cookie behaviour
- Original admin login (challenge/response), logout, change password
- Admin shell: menu trimmed to implemented pages, page routing via `?page=`
- Dashboard page and its data poll, the session row actions
- Logs page (system category) and notifications
- Offline licence object, local device id
- Removal of the simple `/admin` UI

Out of scope (later sub-projects, see Roadmap): vouchers, credit codes, points, spin
wheel, sales; the customer portal's original themes; network pages; reseller portal;
PPPoE/RADIUS/billing; media, themes, tickets, chat. Never in scope: any call to a vendor
server, licence verification, e-load, online payment, Android rental, the vendor
push channel (`eval`, SSH/HTTP tunnels, remote upgrade), ngrok.

## Architecture

One Node process, as today. One new runtime dependency, **`socket.io` pinned to exact
4.7.5** (MIT; the version the original frontend ships, `socket.io.js` v4.7.5). It must be
vendored into the device image by the image build (sub-project #4's script), since the
device has no package manager. Dev dependency only: `socket.io-client` 4.7.5 for tests.
No Express: routing stays hand-rolled `node:http`, as in `lib/portal.js`.

### URL map

| Request | Behaviour |
|---|---|
| `GET /admin` | Not logged in: serve `main/index.html` (the login page). Logged in: serve `nav/index.html` for `?page=<id>` (default `dashboard`) |
| `POST /admin` | The login page submits a form here after a successful socket login. If the session is allowed: `302 /admin?page=dashboard`; otherwise `302 /admin` |
| `GET /admin?page=<id>` | `<id>` must be an enabled page (below) else `302 /admin?page=dashboard`. The shell's `@script.js` placeholder is replaced with `script/<id>.js`; `{1}` is replaced with the upper-cased `os.hostname()` and `{2}` with the package version (cache-busting only), exactly as the original did |
| `/admin/` (socket.io) | socket.io server mounted at `path: '/admin'`, transports `websocket` then `polling`. Both the login page and the shell connect with `{path:'/admin', transports:['websocket','polling']}` (read from `main/script/main.js` and `nav/script/main.js`) |
| static files | `.js .css .png .jpg .ico .map .woff .woff2 .ttf .svg .mp3` under the frontend root only: the original nginx's asset set minus `.apk` (phone rental is hidden). **No `.html`**: pages are served only through the routes above, so the raw shell, with unreplaced placeholders and an untrimmed menu, is never reachable as a file |
| `/theme/*`, `/api/pay-intent`, `/api/status`, `/` | unchanged from #2; the customer portal is replaced in #8 |

The frontend root is the existing `legacy/wifi5-soft/frontend-decrypted/public` tree,
moved with `git mv` to `public/ui/` so product code does not depend on a folder named
`legacy` and no copy is added to the repository. Vendor files stay byte-identical in
git; every adaptation (placeholders, menu trimming) happens at serve time.

### Enabled-page registry

`lib/ui/pages.js` holds the list of admin pages: `{ id, group, enabled }`. The 32 ids are
the `?page=` links in `nav/index.html`. After this sub-project `dashboard` and `logs` are
enabled. The registry drives three things: the `?page=` check above, the menu trimming,
and the socket event table (a disabled page's events are not registered).

### Menu trimming

`nav/index.html` is served with the menu rewritten at serve time. The markup is
`<li class="nav-item menu-items">` per group, containing `<ul class="nav flex-column
sub-menu"><li class="nav-item"><a class="nav-link" href="?page=<id>">…` per page. The
rewriter removes each `sub-menu` block whose `href` page is not enabled, and removes a
whole group when none of its pages remain. Top-level single-page items are removed the
same way. After this sub-project the menu shows Dashboard and Logs.

### Sessions and cookies

The first `GET /admin` issues a session cookie (`vendo5_sid`: random 24 bytes hex,
`HttpOnly; SameSite=Strict; Path=/admin; Max-Age=3600`). Because it is scoped to
`/admin`, the browser sends it on the socket handshake (`/admin/?EIO=…`) and on
`POST /admin`; the socket middleware reads it to bind the connection to the session. The
store is in memory, like #5's tokens. There is **no hardcoded secret** (the original's
express-session secret was a fixed literal; ours is a random id, not a signing key).

## Components

```
lib/ui/static.js     file serving: extension allowlist, resolved-path prefix check,
                     content types, no-cache for html
lib/ui/pages.js      page registry + serve-time rendering: placeholders, menu trimming
lib/wire/server.js   attaches socket.io at /admin, binds sockets to sessions,
                     applies the per-event expiry guard, registers the event table
lib/wire/session.js  in-memory sessions keyed by cookie id: allowed, expiresAt, challenge
lib/wire/events.js   the table: opaque event id -> named handler (one file per group)
lib/wire/main.js     handlers: login token, login verify, version, change password
lib/wire/nav.js      handlers: dashboard poll, command passthrough, session actions,
                     logs, notifications, serial, restart, reset
lib/system/stats.js  cpu, ram, temperature, storage, interface counters
lib/system/mainlog.js  dated log files (format below), retention cap
lib/store/account.js plaintext account file, 0600, atomic writes
lib/licence.js       the offline licence object and the local device id
```

Handlers are plain functions `(payload, ctx) => reply | Promise<reply>` with no socket
inside, so each is unit-testable. `ctx` carries the session, an injected `runCommand`
(the same pattern as `lib/firewall.js`), the stores, and a clock. A handler never throws
into the socket: errors are logged and answered with the original's error shape.

### Login (the original protocol)

1. The login page emits `@main-48931`. The server creates a 32-hex-character token,
   stores `{token, at: now}` on the session, and acknowledges with the token string.
2. The browser computes, with `a = token.substring(0, (token.length-1)/2)` and
   `b = token.substring((token.length-1)/2, token.length)`:
   `username = md5(a + usernameLowercasedWithoutSpaces)`,
   `password = md5(b + passwordWithoutSpaces)`, and emits `@main-66589` with
   `{uname, username, password}`.
3. The server recomputes both from `account.main.{username,password}` using the same
   expressions (the fractional index truncates identically) and compares with strict
   equality. It also requires `now - challenge.at < 3000 ms`. On a match it marks the
   session allowed, records the expiry (now + 1 h) and acknowledges `{login: true}`;
   otherwise `{login: false}`. The challenge is consumed on any attempt. Every outcome is
   written to the main log (`Admin Success Login: user <u> from <ip>` /
   `Admin Failed Login: user <u> invalid user or password from <ip>`).
4. The page then submits its form, which is `POST /admin` above.

Other login-page events: `@main-66322` acknowledges `{version, prefix}` (package version
and the short device id; shown on the login page); `@main-84472` changes the password
(requires the old password; writes `account.json`; failure answers the original's
"Invalid Password").

### Account file

`<state>/account.json`, mode 0600, `{"main":{"username":"admin","password":"admin"}}`,
written atomically (temp file + rename). Created on first boot with the factory default
and the existing "factory-default password" warning. `config/admin.json` (hashed) is
retired: a hash cannot be converted to plaintext, so an existing install is reset to the
factory default on first boot with a logged warning. This is acceptable because nothing
is deployed yet (#3 is still pending real-hardware verification).

### Offline licence

`lib/licence.js` returns a constant object: `{serial: <device id>, expiration:
8640000000000000, hotspot: 1000000, pppoe: 1000000, custom_theme: true, movie: true,
checked: true}`. The device id is derived from the CPU serial in `/proc/cpuinfo`, else
`/etc/machine-id`, else a random id persisted once in the state directory. No code path
reads a licence from the network or from a vendor-signed blob. Handlers that the original
gated on the licence simply find it permissive.

### Event table for this slice

All `@nav-*` handlers start with the original expiry guard: if the session's expiry has
passed, the socket is disconnected and nothing runs. Event ids are the original's.

| Event | Purpose | Notes |
|---|---|---|
| `@main-48931` | login token | see above |
| `@main-66589` | login verify | see above |
| `@main-66322` | `{version, prefix}` | |
| `@main-84472` | change password | |
| `@nav-89554` | dashboard poll | reply keys: `cpuusage, temp, cpuinfo, ram, system, active, pppoelist, now, storage, Watching, interfaceInfo`. The dashboard reads `cpuusage`, `Watching`, `now`, `active.data` and `active.session` (maps keyed by MAC) and, per interface, `interfaceInfo[ifname].stats64.{rx,tx}.bytes`. `pppoelist` is `{}` and `Watching` is empty until those features exist |
| `@nav-23441` | command passthrough | the original's regex allowlist, read-only subset only in this slice: `ubus call system info`, `ubus call system board`, `ubus call network.interface.<name> status`, `ubus call network.device status`, `ip -j neigh`, `ip -j -d link show`, `ip -j -d route show`, and `ubus call system reboot`. Anything else is refused. The `uci set/commit/…` and `wg show` entries arrive with the network sub-project |
| `@nav-77833` | id-base / client | reply `{idbase, client}`. vendo5 has no unique-id mode, so `idbase` is `false` and `client` is `{}`; the exact shape is confirmed by the recorded contract |
| `@nav-89000` | extend a session | adds time to `expiresAt` (credit unchanged) and writes the original log line |
| `@nav-22313` | disconnect a client | **not implemented in this slice**: answers the original error shape and logs it. A "disconnected but still holding time" client needs the paused-session state that the money engine (#7) adds; without it the client would either be re-allowed by its next status poll within seconds or lose its remaining time. The button stays visible and reports that it is unavailable |
| `@nav-44232` | disconnect and remove | revokes the firewall rule first and only then removes the session (the ordering and the failure behaviour decided in #5 are kept: a firewall failure leaves the session in place and answers the error shape) |
| `@nav-67345` | bulk remove | applies `@nav-44232` per MAC; returns the original's success/error |
| `@nav-78663`, `@nav-65698` | PPPoE disconnect / remove | answer the original's error shape until the PPPoE sub-project |
| `@nav-645798` | list log files | returns an array of file names |
| `@nav-636547` | read a log file | returns the file text; the page splits on newlines |
| `@nav-362358` | delete one log file | replies with `success` |
| `@nav-365478` | delete log files by category | removes files whose name contains the category |
| `@nav-300214`, `@nav-30210` | read / delete a per-user log | |
| `@nav-63658987`, `@nav-3265892`, `@nav-3654780` | notification get / mark read / set | one JSON file in the state directory |
| `@nav-232003`, `@nav-1452357` | device serial (plain / base64) | the local device id, never the "no serial" sentinel |
| `@nav-3332145` | reset | removes only the files vendo5 owns under its state directory (sessions, logs, notification; `account.json` is recreated with the default) and then exits so the supervisor restarts it. It never runs a broad `rm`. The shell's confirm dialog is unchanged |
| `@nav-14433223`, `@nav-14433211` | licence redeem | no-op success: the licence is permanent |

**Contract discipline.** The field-level shapes of replies the dashboard reads come from
decompiled handlers plus the decoded client, which is evidence, not proof. The first
implementation task therefore runs the *unmodified* dashboard and logs scripts in
headless Firefox against the server with replies wrapped in a `Proxy` that records every
property the page dereferences, and commits the result as the contract fixture
(`test/contract/*.json`). Handlers are then written to that recorded contract, so no
field is guessed.

### Session adapter

vendo5 sessions are `{mac, creditPesos, expiresAt}`; the original rows carry more
(`type`, `duration`, `expiration`, `pauselimit`, limits, voucher `code`). The adapter
presents each session in the original row shape with defaults (`type: "consumable"`,
no limits, no code). The money-engine sub-project replaces the defaults with real
values. Nothing is invented: absent data stays absent.

### Logs on disk

`lib/system/mainlog.js` writes `<state>/mainlogs/<category>-<DD>-<MM>-<YYYY>.txt`
(zero-padded; this is the format the Logs page parses: it strips `<category>-` and
`.txt`, then orders by year, month, day). Each line is `<hh:mm:ss am|pm>: <text>` (the
page highlights that time pattern). Categories used in this slice: `system` (logins,
coins, admin actions). Retention: at most 30 files per category; the oldest are removed
on write, so flash cannot fill. This replaces #5's memory-only ring buffer as the log
the admin sees; the JSON stdout log is unchanged.

## Removed

`dashboardContent`, `adminPage`, the login form, the `/admin/login`, `/admin/logout`,
`/admin/api/sessions`, `/admin/api/logs`, `/admin/api/sessions/:mac/revoke|credit`
routes in `lib/portal.js`, `lib/admin.js` (hashed single-user auth), the `admin` entry of
`REQUIRED` in `lib/config.js`, `config/admin.json`, and their tests, once the original
admin passes the live test. The revoke/credit *behaviour* survives as `@nav-44232` and
`@nav-89000`. The logger's ring buffer and `session.revoke` stay (used by the handlers).

## Error handling

- A handler failure is logged at `error` with the event id, answered with the
  original's error shape, and never reaches the client as an exception.
- An unknown event is ignored (socket.io drops it); no disabled page is reachable, so
  none fires.
- An expired session disconnects the socket, as in the original; the page falls back to
  the login form on reconnect.
- `GET /admin?page=<id>` with an unknown or disabled id redirects to the dashboard.
- Static serving: a request whose resolved path is outside the frontend root, or whose
  extension is not allowlisted, is a 404 (no directory listing, no dotfiles).
- Stats: a failing command or unreadable `/proc` file yields that metric as absent, never
  a failed poll.
- Command passthrough: a command that does not match the allowlist is refused without
  being run; arguments are never joined into a shell string (`execFile` with an argv).

## Testing

1. **Unit** (`node --test`): each handler with fakes for `runCommand`, stores and clock:
   login accept/reject/stale-challenge/replayed-challenge, the exact token-splitting
   expression at several token lengths, change password, every passthrough allow/refuse
   case, log file naming and retention, account file mode and atomicity, the session
   adapter, the page registry and menu trimmer against the real `nav/index.html`.
2. **Socket contract** (real server on an ephemeral port + `socket.io-client`): the
   recorded fixtures drive assertions on reply shapes; the expiry guard; cookie scoping
   (a socket without the cookie cannot log in).
3. **Live Firefox** (the live driver from the superseded #5 branch, `scripts/live-test.py` on `fix/dashboard-header-and-focus`, is carried over as the base): the
   original login page, real challenge/response login, dashboard renders with the
   seeded sessions, the poll updates live, each session action, the logs page lists and
   reads a file, a notification round-trips, logout, expired session, and the
   `POST /admin` redirect. Screenshots are reviewed, not just produced. The run also
   asserts no JavaScript error and that every request the page makes is same-origin; where
   the host allows it (`unshare -rn`) the server runs without network access to show it
   never needs one.

## Risks

- The original JavaScript is obfuscated and self-defending, and could misbehave under
  headers or placeholders that differ from the original's. The first task is therefore a
  spike: serve it and log in before anything else is built.
- Reply shapes are inferred; the Proxy-recorded contract is the mitigation, and a field
  the page reads but we do not provide shows up as a failing contract test.
- `socket.io` must be present in the device image; the image build must install it
  (offline, from a vendored `node_modules`).
- `ubus` output is unverified on real OpenWrt; tests use fixtures. Real-hardware
  verification is the same open item as #3.
- Plaintext password at rest (D4): file mode 0600 on the device; same exposure as the
  original.

## Roadmap

| # | Sub-project | Adds |
|---|---|---|
| #6 | this | foundation, admin shell, dashboard, logs, notifications |
| #7 | Money engine | vouchers, credit codes, points, spin wheel, sales, redemption in the customer portal; real session fields |
| #8 | Customer portal parity | the original default and new themes at `/`, full status panel, pause/resume, extend, chat, media |
| #9 | Network admin | interfaces, DHCP/leases, NFT lists, walled garden, port forward, NTP, WAN modes, scheduler, game priority |
| #10 | Reseller portal | accounts, permissions, own vouchers/credits/sales, its login |
| #11 | PPPoE | server, RADIUS, billing, custom PPPoE portal |
| #12 | Media, themes, tickets | the remaining pages |

Cloud-only features are excluded from every sub-project.

## Open questions for review

None outstanding. Decisions D1 to D5 were taken during brainstorming. Two items are
judgement calls made while writing, flagged for review:

1. The factory reset (`@nav-3332145`) is a scoped reset of vendo5's own files plus a
   restart, not the original's `rm -r` of the whole data directory.
2. The Disconnect row action (`@nav-22313`) is visible but reports "unavailable" in this
   slice, because it needs the paused-session state from #7. The alternatives (treat it
   as Remove, or let the client be re-allowed) each lose time or defeat the action.

## Amendments (found while building the plan's prototype)

The plan's code was run against the real frontend in headless Firefox before the plan was
written. That showed the following; where it conflicts with the text above, this section
wins. The same list is at the end of the plan.

1. **Plaintext form post closed.** After a successful socket login the original page submits
   a form to `/admin` that carries the plaintext password. The login inputs lose their `name`
   attributes at serve time, so only the page's own hash ever leaves it.
2. **Logout** is `POST /admin` with JSON `{"logout": true}`, not a socket event.
3. **Menu trimming also covers** the navbar chat link, the `#console` button, and four profile
   items (system update, software up/down, export data, import data).
4. **Password hashing is latin1** (low 8 bits per character), matching the vendor `md5.js`.
5. **Frontend location:** not `git mv`'d to `public/ui`. Development serves
   `legacy/wifi5-soft/frontend-decrypted/public`; the device serves `/opt/vendo5/ui`
   (`VENDO5_UI_DIR`). Only `main` and `nav` (about 34 MB) go into the image.
6. **A leaving-shim** is injected after `socket.io.js`: the shell reloads the page on socket
   disconnect, and Firefox closes the socket on navigation, so Dashboard to Logs bounced back.
   The shim makes the disconnect handler stand down once the page is leaving.
7. **Contract fixtures** (`test/contract/*.json`) are replaced by the live test, which asserts
   the effects. The recorder found: notification keys are epoch milliseconds with a `message`
   field; `active.data[mac].uploadLimit/downloadLimit` are strings; session rows need `rx/tx`;
   system info needs `uptime`.
8. **Event set narrowed** to what an enabled page can send: no `@nav-78663/65698` (PPPoE),
   `@nav-300214/30210` (per-user logs) or `@nav-14433211`; the passthrough allowlist is the
   four lines the dashboard uses; `@nav-77833` answers `{client:{clientInfo:[]}}`.
9. **Factory reset** clears sessions, the login and the notices; it keeps the logs and does not
   restart the process.
10. **The old admin's "add credit" has no replacement here**; extend (`@nav-89000`) and remove
    (`@nav-44232`) do. Free credit returns with the money engine (#7).

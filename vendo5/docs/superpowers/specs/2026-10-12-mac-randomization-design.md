# MAC randomization: resume code + free-trial cap (sub-project 3 of the feature batch)

Decisions (2026-10-12): approach A (resume code, no portal UI change) and trial option 1 (vendo-wide hourly cap).

## Problem

Clients are identified only by MAC (sessions, firewall set, wallet, trial flag). Phones use a random MAC per
network and get a new one after "Forget network", a privacy-setting change, or (iOS "Rotating") over time. The
vendo then sees a new device: the customer's paid time stays on the old MAC, and the free trial can be taken
again and again.

## 1. Resume code

**Every session gets one.** When the session store creates a fresh session (`addCredit`, `addTime`), it sets
`resumeCode`: 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I), from `crypto.randomInt`.
A session that only gets more time keeps its code. About 10^12 codes: guessing is not practical even though
the per-MAC wrong-code lock can be dodged by changing MAC.

**Where the customer sees it** (no change to the original UI):
- Logs page (`@portal-0`): while the session is live, the reply ends with
  `Resume code: K7Q2M9XA - if your phone changes its MAC, enter this code in the voucher box to get your time back`.
- `@portal-2` `code` field: the voucher code when there is one, else the resume code (the page may show it).

**Taking the time to a new MAC.** In `money.redeemVoucher`, when the code is not a voucher and not a credit
code, it is looked up as a resume code. Also a voucher code that was already used finds the session that is
running it. Then, if that session is live on a *different* MAC:
- refused when the new MAC is blocked, or already has a live session (`This device already has time`);
- `sessions.move(oldMac, newMac)` moves the whole session object (time, paused/outage state, limits, data used,
  codes) to the new MAC;
- firewall: `revoke(oldMac)` (errors ignored, it may not be in the set), `allow(newMac)` unless the session is
  paused; if `allow` fails the move is undone;
- mainlog `Session moved from <old> to <new> (resume code)`, client log line on the new MAC, `Connected`.
A wrong code still counts toward the existing per-MAC lock.

**Not moved:** wallet credit and points (they stay on the old MAC). shortcut: move them too if customers ask.

## 2. Free-trial cap

`portal-ops.trial` refuses with `Free trial limit reached, try again later` when the vendo has already given
`trial_max_per_hour` trials in the last 60 minutes (all devices together). Default 10, set in `vendo.json`
(the original trial settings page has no field for it). Counting is in memory: shortcut: a restart resets the
count; persist it if owners see abuse around reboots.

## Testing

- `test/session.test.js`: fresh session gets an 8-char code from the alphabet; topping up keeps it; `move`
  carries the session and refuses when the target has a live session or the source has none.
- `test/money.test.js`: resume code moves the time, revokes old, allows new, logs; used voucher code moves too;
  refused for a blocked MAC or one with time; firewall allow failure leaves the session on the old MAC; a
  paused session moves without an allow; unknown code still counts toward the lock.
- `test/portal-wire.test.js` or the portal handler test: logs reply carries the resume code while live, not
  after expiry.
- portal-ops test: the 11th trial within an hour is refused; after the hour it is allowed again.

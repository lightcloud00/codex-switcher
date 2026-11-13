# Reminder: perhaps you no longer need this software

<img width="1015" height="244" alt="image" src="https://github.com/user-attachments/assets/3770389e-b2db-4b68-af1e-7bf4a5ff5ced" />


<p align="center">
  <img src="src-tauri/icons/logo.svg" alt="Codex Switcher" width="128" height="128">
</p>

<h1 align="center">Codex Switcher</h1>

<p align="center">
  A Desktop Application for Managing Multiple OpenAI <a href="https://github.com/openai/codex">Codex</a> Accounts<br>
  Easily switch between accounts, monitor usage, schedule warm-ups, and stay in control of your quota
</p>

<div align="center">

[![](https://dcbadge.limes.pink/api/server/4QzyJTC3S)](https://discord.gg/4QzyJTC3S)

</div>

## Features

The main window has five views: **Overview** (Codex, Claude, API credits and client status side by side), **Use next** (which account to use now), **Codex** (the accounts below), **Claude** (seats, usage and dates) and **Providers** (API credits, provider access with sign-in checks and plan dates, and the Gemini CLI quota card).

- **Multi-Account Management** – Add, rename, mask, import, export, and manage multiple Codex accounts in one place
- **Quick Switching** – Switch between accounts from the main window, native tray menu, or tray popup while preserving rotated ChatGPT sessions
- **Usage Stats** – View account usage stats for OAuth accounts, including lifetime tokens, daily buckets, streaks, activity insights, and top integrations
- **Manual Reset Credits** – See available manual reset credits beside each account plan badge, with the closest expiry highlighted as it approaches
- **Automatic Warm-Up** – Warm up one account or all accounts manually, after each 5-hour reset window, or at specific scheduled times of day
- **System Tray Controls** – Use the tray popup to switch accounts, inspect quota and active-account stats, refresh usage, open the main window, or quit the app
- **Tray Display Modes** – Choose between the app icon with session percentage (**Icon + Session**), a text-only hourly/weekly percentage display (**Hourly + Weekly**), the top account from the **Use next** view (**Use next**), or a hidden tray icon (**Hidden**)
- **macOS Dock Control** – Keep Codex Switcher in the Dock or run it as a menu bar only app, with a first-close prompt and a tray fallback
- **Rate-Limit Monitoring** – View real-time 5-hour session and weekly usage, reset timing, credits, and subscription expiry
- **Reset Countdowns** – The tray popup and the native tray menu show the time left until each window resets, for example `5h:73% ↻2h 5m`
- **Provider Outage Badges** – A badge in the tray popup and a line in the native tray menu when OpenAI, Claude, Cursor, Factory or GitHub Copilot report an incident on their public status pages (see [Provider outage badges](#provider-outage-badges))
- **Sign-In Expiry Alerts** – One local notification per provider when a login stops working (see [Sign-in expiry alerts](#sign-in-expiry-alerts))
- **Gemini CLI Quota** – A card on the Providers view with the Gemini CLI's remaining quota per model tier (see [Gemini CLI quota](#gemini-cli-quota))
- **Blocked Switch Recovery** – Detect running Codex sessions and offer a force-close flow before retrying the account switch
- **Conversation Recovery** – Optionally continue quota-stopped chats and running macOS chats interrupted by account switching
- **Dual Login Mode** – Authenticate with ChatGPT OAuth or import existing `auth.json` files

## Installation

### Download a Release

The links below point at the upstream project (`Lampese/codex-switcher`), not this fork. To run this fork's changes, [build from source](#build-from-source). The upstream release is the easiest way to try the original app:

[Download the latest release](https://github.com/Lampese/codex-switcher/releases/latest)

Choose the file for your platform:

- **macOS Apple Silicon:** `Codex.Switcher_*_aarch64.dmg`
- **macOS Intel:** `Codex.Switcher_*_x64.dmg`
- **Windows:** `Codex.Switcher_*_x64-setup.exe` or `Codex.Switcher_*_x64_en-US.msi`
- **Linux Debian/Ubuntu:** `Codex.Switcher_*_amd64.deb`
- **Linux AppImage:** `Codex.Switcher_*_amd64.AppImage`
- **Linux RPM:** `Codex.Switcher-*-1.x86_64.rpm`

> **macOS:** current release builds are not Apple-notarized. If macOS says the
> app is damaged, move it to `/Applications` and remove the quarantine flag:
>
> ```bash
> sudo xattr -dr com.apple.quarantine "/Applications/Codex Switcher.app"
> open "/Applications/Codex Switcher.app"
> ```

### Updates

This fork has no in-app updater: the app never checks for or installs a release,
so an upstream release cannot replace your build. Updates come from rebuilding
this fork (see [Build from Source](#build-from-source)).

### Build from Source

#### Prerequisites

- [Node.js](https://nodejs.org/) (v20.19+ or v22.12+ to build the app (Vite 7); v22.6+ to run `pnpm test`, which uses `node --experimental-strip-types`)
- [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/)

```bash
# Clone the repository
git clone https://github.com/Lampese/codex-switcher.git
cd codex-switcher

# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev

# Build for production
pnpm tauri build
```

> **Windows:** the `pnpm tauri` script runs through a POSIX shell wrapper
> (`sh ./scripts/tauri.sh`) and will not work in PowerShell/CMD. Use the
> `tauri:win` script instead: `pnpm tauri:win dev` and `pnpm tauri:win build`.

The built application will be in `src-tauri/target/release/bundle/`.

#### Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm preview` | Vite dev server, type-check plus production build, preview of the build |
| `pnpm tauri ...` / `pnpm tauri:win ...` | Tauri CLI (see the Windows note above) |
| `pnpm lan` | Build the frontend and serve it over HTTP (see below) |
| `pnpm test` | All tests in `tests/` |
| `pnpm test:claude-usage`, `test:desktop-reopen`, `test:browser-runtime`, `test:close-preference`, `test:reset-credits`, `test:updater` | One test file or group |
| `pnpm version:bump`, `version:patch`, `version:minor`, `version:major` | Keep versions in sync (see [Versioning](#versioning)) |
| `pnpm release`, `release:patch`, `release:minor`, `release:major` | Prepare a release commit and tag |

Rust tests: `cargo test --lib` from `src-tauri/`.

### Run the Dashboard in a Browser

You can also serve the built dashboard over HTTP instead of opening the Tauri shell.

```bash
# Build the frontend and start the web server on 0.0.0.0:3210
pnpm lan
```

Optional environment variables:

- `CODEX_SWITCHER_WEB_HOST` to override the bind host
- `CODEX_SWITCHER_WEB_PORT` to override the port

The browser dashboard serves the same UI through `/api/invoke/*`, which makes it usable over LAN, Tailscale, or a remote host tunnel when you expose the chosen port safely. It serves a subset of the desktop commands: account, usage, login, warm-up, Claude seat and provider-dates routes are there, plus the password-protected backup routes, which answer only a request that comes from the same machine (loopback with a `localhost` host). Window and tray commands, the display settings and monitoring switches, outage badges (`get_provider_status`), the Gemini quota card (`get_gemini_quota`), API credits, client status and the sign-in check are not served, so those parts need the desktop app. `codex-web` exits with status 1 and prints the error if it cannot bind the port.

## Usage and Reset Credits

Codex Switcher shows two kinds of account usage information:

- **Rate limits** – the account card shows the current 5-hour and weekly limit
  windows, remaining percentage, reset timing, credit balance, and subscription
  expiry when available.
- **Usage Stats** – ChatGPT OAuth accounts can expand the **Usage
  Stats** panel to view stats such as lifetime tokens,
  today, last 7 days, last 30 days, streaks, longest task, token activity,
  reasoning/activity insights, and most-used integrations. The active account
  opens this panel by default; other accounts keep it collapsed until needed.
- **Manual reset credits** – OAuth accounts with available reset credits show a
  compact badge next to the plan badge. It includes the available count and the
  closest expiry date, hides zero-count results, and turns amber within 10 days
  or red within 3 days of expiry.

The tray popup also includes compact active-account stats for today and
the last 7 days, while keeping the normal rate-limit refresh flow separate.

## Safe Account Switching

ChatGPT can replace an OAuth refresh token after using it. Once replaced, the
older token may no longer be accepted. Before Codex Switcher writes another
account to `~/.codex/auth.json`, it now saves the latest tokens from the account
that is currently active. Switching back therefore restores the current session
instead of an older snapshot.

Token refreshes and account switches are serialized so a background refresh
cannot finish late and overwrite the account you just selected. Codex Switcher
also avoids refreshing the active account while Codex or ChatGPT is running;
close the running app before switching accounts.

If an older Codex Switcher version already saved an invalid refresh token, sign
in to that account again or remove and re-add it once. An invalidated token
cannot be recovered locally.

When a switch needs to close Codex, enable **Auto-resume interrupted conversations after switching** in Settings or the close-and-switch confirmation dialog. Recovery scans local session logs modified in
the last 24 hours, excludes internal subagent sessions, and queues `Continue the previous task.` for up to 32
conversations whose latest failure has the `usage_limit_exceeded` error code
or a message beginning with “You've hit your usage limit.” It skips conversations
already continued, completed, or cancelled, and ignores error text quoted in
chat messages or tool output. On macOS, it also captures unfinished chats whose logs
are open in the Codex process tree before closing. Chats waiting for input or approval
are excluded, and log changes are rechecked before delivery. Explicit aborts are
never resumed, even if emitted during shutdown. Other platforms retain quota-error
recovery. It is off by default and requires a Codex CLI
supporting `codex queue` and a desktop app registered for `codex://` links.
Enable desktop reopening as well. After a successful reopen, Switcher opens each
queued conversation and waits up to 60 seconds for its recovery message in a new turn;
queue acceptance alone is not reported as success. The entire recovery run is capped
at two minutes, with live progress in the main window. Results stay visible until
dismissed, listing every conversation that needs attention with an **Open conversation**
button. Conversations not attempted before the limit are listed too; pending messages
and their receipts are kept to prevent duplicate continuations. A failed or timed-out delivery
is shown in the result. Each continuation includes a unique recovery marker, so
unrelated turns cannot confirm it. If the CLI fails or times out before confirming
queue acceptance, delivery is reported as unknown and requires queue inspection
before resubmitting. Unconfirmed deliveries are remembered across Switcher
restarts, so retrying opens the pending chat without adding another continuation.
Recovery receipts retain safe CLI exit-status or 10-second timeout details across retries. CLI output is not stored. Older receipts remain readable but may lack those details. User-created forks remain eligible for recovery.
This flow applies to switches through the main window that close and reopen Codex;
tray-only switches and switches made while Codex is already closed do not run it.

## macOS Dock and Menu Bar Mode

On macOS, Codex Switcher can either stay visible in the Dock or live only in the
menu bar. The first time you close the main window, the app asks which behavior
you want and lets you choose whether to show that prompt again.

You can change the same setting later from the tray popup or from the native
tray menu under **Dock Icon**. If you choose **Menu Bar Only**, the app keeps a
visible tray item so you can always reopen the main window or switch back to
Dock mode.

## Warm-Up

A warm-up sends one minimal request to an account so its current usage window
has activity before you need it.

- **Manual** – warm up a single or all accounts from the main window. The tray popup has only the **Auto: on/off** switch for warming all accounts; it has no manual warm-up button.
- **Automatic** – when enabled (per account or for all), the app tracks the
  5-hour window when available and warms it after each reset, as long as the
  weekly limit isn't exhausted. If only the weekly window is available, it
  warms once after the weekly reset and automatically returns to the 5-hour
  schedule if that window reappears.
- **Timed** – pick specific times of day (e.g. `08:00`, `13:00`, `18:00`) from
  the **Timed** control in the main window. At each time the app warms all
  accounts (skipping any whose weekly limit is exhausted), so you control when
  your 5-hour windows start instead of letting them drift.

Timed warm-up checks the schedule every 30 seconds, runs each configured minute
only once per day, and skips missed times if the machine was asleep instead of
warming accounts late.

On macOS you can keep the machine awake with the built-in `caffeinate` command,
which stops automatically when the app quits:

```bash
caffeinate -i -w "$(pgrep -x 'Codex Switcher')"
```

## Provider outage badges

Every few minutes the app reads the public Statuspage `status.json` of OpenAI, Claude, Cursor, Factory and GitHub Copilot (for Copilot it reads `summary.json` and watches the **Copilot** component, because GitHub's page-wide status covers unrelated products). A provider that is degraded, in an outage or under maintenance gets a badge row in the tray popup and a line in the native tray menu.

- Public endpoints only: no cookies, tokens or accounts are involved, and redirects must stay on https.
- It polls every 5 minutes, reuses an answer for 4 minutes, and drops an answer older than 20 minutes so a stale outage does not stick.
- On by default. Turn it off with **Settings → Show provider outage badges**.

## Sign-in expiry alerts

When a login stops working, the app shows one local notification for that provider, for example "Codex sign-in expired", with a short fix (for example `Open Codex Switcher to sign in again.` for Codex or `Run /login in Claude Code on the seat that signed out.` for Claude). The alert names the provider only, never an email, account name, token or raw error.

- One alert per provider (or per Claude seat) per failure episode. The episode ends when a fresh, successful check for the account that failed comes back, so repeated refreshes do not repeat the alert. A busy host, a rate limit or a network error never raises one.
- Codex accounts alert on the first failing check that says the login is bad (a 401, `invalid_grant`, an expired or reused token), even if the app never saw that account working. The other sources alert only after they were seen working in this run, so one that was already signed out when the app opened stays silent.
- It covers Codex accounts; Claude seats on this Mac, as reported by `claude-usage` (a seat must be confirmed signed in by two separate checks first; remote seats such as Windows or WSL and archived seats never alert, because `claude-usage` only reports sign-in state for local seats); the Grok, Cursor and CredVault sign-in checks on the Providers view; and the Gemini CLI quota check.
- Episodes live in memory, so restarting the app starts clean.
- On by default. Turn it off with **Settings → Notify me when a sign-in expires**.

## Gemini CLI quota

The **Providers** view has a **Gemini CLI quota** card with the percentage left and the reset time for the Pro, Flash and Flash Lite tiers. It uses the Gemini CLI's own sign-in (`~/.gemini`, OAuth login only): the login is read in memory for the check and is never shown, logged or saved. Answers are cached for 3 minutes. The card is desktop only.

The OAuth client the CLI uses is read from the installed CLI. If that cannot be found, set these environment variables:

- `GEMINI_OAUTH_CLIENT_ID` and `GEMINI_OAUTH_CLIENT_SECRET` – the client credentials directly
- `GEMINI_OAUTH2_JS_PATH` – path to the CLI's bundled JavaScript that contains them

## Settings switches

**Settings** has two switches for the monitoring above, both on by default: **Show provider outage badges** and **Notify me when a sign-in expires**. The tray display mode and, on macOS, the Dock icon are in the same place.

## Command-line tools and environment variables

Besides the app, the Rust crate builds two binaries:

- `codex-web` – the browser dashboard server (`pnpm lan`). It exits with status 1 on a startup error.
- `codex-switcher-capacity-export` – writes a sanitized capacity snapshot for the fleet router: `--output <file>` (required; exits with status 2 without it or when the export fails), `--admission <file>` (optional admission record) and `--include-claude-seats` (also export the Claude seat lanes).

Environment variables:

| Variable | Effect |
| --- | --- |
| `CODEX_SWITCHER_WEB_HOST`, `CODEX_SWITCHER_WEB_PORT` | Bind address of `codex-web` (default `0.0.0.0:3210`) |
| `CODEX_HOME` | Codex home directory instead of `~/.codex` |
| `CODEX_BIN` | Codex CLI binary used by conversation recovery |
| `CLAUDE_PROMETHEUS_URL` | Prometheus the Claude view overlays seat health from (default `http://127.0.0.1:9090`; loopback or tailnet hosts only) |
| `AOS_SWITCHER_CLAUDE_SEAT_SUBSCRIPTIONS` | Path to the Claude seat end-date file (default `~/.config/aos/claude-seat-subscriptions.json`) |
| `GEMINI_OAUTH_CLIENT_ID`, `GEMINI_OAUTH_CLIENT_SECRET`, `GEMINI_OAUTH2_JS_PATH` | Gemini quota card (see above) |

## Disclaimer

This tool is designed **exclusively for individuals who personally own multiple OpenAI/ChatGPT accounts**. It is intended to help users manage their own accounts more conveniently.

**This tool is NOT intended for:**

- Sharing accounts between multiple users
- Circumventing OpenAI's terms of service
- Any form of account pooling or credential sharing

By using this software, you agree that you are the rightful owner of all accounts you add to the application. The authors are not responsible for any misuse or violations of OpenAI's terms of service.

## Versioning

Use the version bump helper to keep app versions in sync across Tauri, Cargo, and the frontend.

```bash
# Exact version
pnpm version:bump 0.2.1

# Semver bumps
pnpm version:patch
pnpm version:minor
pnpm version:major

# Prepare a release commit and tag
# This prompts for a short release note and runs the version bump first.
pnpm release patch

# Prepare and push a release
# The tag stores the release note.
pnpm release patch -- --push

# For non-interactive use, pass the note explicitly.
pnpm release patch -- --push --note "Fixed account switching issues"
```

### Re-login after an authentication error

ChatGPT account cards show **Re-login** for a 401 or an invalid, expired, or reused token error. Open it, select **Start re-login**, and open the login link in your browser. Sign in with the original account and choose the same workspace. Switcher updates that saved account and refreshes usage while keeping its name, ID, and preferences. A different account or workspace is rejected.

For the active account, close Codex or switch to another account first. Switcher checks this again before saving so a running Codex process cannot overwrite the renewed credentials. Inactive accounts can be renewed while Codex stays open. Cancel leaves the saved credentials unchanged. API-key accounts do not use this OAuth flow.


### Account visibility and dates

In **Claude → Manage accounts**, use **Archive** or **Restore** to choose which seats
appear in Claude, Overview and newly refreshed capacity snapshots. Archiving keeps the
login and subscription. Preferences live in `codex-switcher/claude-seats.json` in the
OS configuration directory (`~/Library/Application Support` on macOS, `%APPDATA%` on
Windows, `~/.config` on Linux). A failed visibility refresh preserves the last list;
if no list has loaded, seats stay unavailable until visibility can be read.

**Edit dates** records the billing interval, renewal date, subscription end date,
evidence source and last verification date. These use the same `provider-dates.json`
store as Providers. A date with a source and verification date is labeled **Confirmed**;
other manually entered dates say **Recorded**. The app does not fetch billing receipts.
When only a paid subscription start date is available, the next monthly anniversary
is explicitly an **estimated monthly renewal**. Annual/free settings suppress that
monthly estimate. Unknown dates stay unrecorded.

Overview separates the current Codex login from availability. Missing usage is unknown,
old usage is stale, and Claude's remaining allowance reflects its limiting current
5-hour or weekly window. Compact rows fit the supported narrow window without horizontal
scrolling; probe errors are available under Details.

### Protected backups and saves

Choose **Account → Export Password-Protected Backup**, then enter and confirm a password
of at least 12 characters. New files use a salted PBKDF2-HMAC-SHA256 key and authenticated
XChaCha20-Poly1305 encryption. Keep the password separately: Switcher does not retain it.
**Restore Backup** imports missing accounts and preserves existing ones. Older files
require the explicit **Legacy backup (created without a password)** choice. Raw token
text export is no longer offered in the UI or LAN API. Backup operations are available
in the desktop app and local loopback browser only.

Account and settings saves use private temporary files and atomic replacement. Account
saves retain three private rotating local backups. These local recovery files are
separate from password-protected exports.

### Opt-in conversation recovery

The upstream recovery implementation is integrated. In Settings, enable **Auto-resume
interrupted conversations after switching** together with desktop reopening. It is off
by default. Recovery prepares eligible interrupted conversations before an explicit
close/switch/reopen, resumes them only after reopening succeeds, and reports consumed,
skipped, failed or timed-out results. Queue acceptance alone is not reported as recovery.
The implementation retains retry receipts to avoid duplicate resumes. Enabling the
setting does not switch accounts or close a current session.

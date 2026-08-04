# 5C Call Sync — the Android companion app

A deliberately tiny Android app (one screen, ~23 KB, **zero third-party
libraries**) that closes the honesty loop in the CRM: it uploads the phone's
own call log to `POST /device-logs/sync`, so a caller's dials and talk time
come from the handset's records, not from what they typed.

## How it behaves

- First open: server address + CRM email + password → Connect. The CRM's
  normal login is used; the app then asks for call-log permission.
- After that it syncs **every time it is opened** and about **once an hour**
  in the background (JobScheduler, persisted across reboots). The open-the-app
  trigger is the reliable one by design — Indian OEM battery managers
  (Xiaomi/Oppo/Vivo) throttle background work aggressively, and we don't
  fight them.
- Re-uploads are harmless: the server is idempotent on
  `(user, ANDROID_ID:call-log-row-id)`. Syncing twice can never double-count.
- When the 12-hour CRM session expires the app signs back in silently with
  the stored credentials and retries once.
- Only the last 3 days of calls are read per sync (the server has everything
  older), capped at 1500 rows, batched 500 per request.

## Privacy — say this to the floor, verbatim

The app uploads the phone's call list to the company's own CRM server.
**Only calls matching a lead already assigned to that caller are ever shown
to anyone.** Personal calls match nothing, appear on no screen and no report,
and the raw log is visible only to the caller themself and the admin — that
restriction is enforced by the database, not by policy.

## Installing on the floor (sideload)

1. Copy `5c-call-sync.apk` to the phone (WhatsApp-to-self works fine).
2. Tap it → Android asks to allow installs from that source → allow → Install.
3. Open, enter `https://crm.yourcompany.in`, the caller's CRM email and
   password, tap Connect, grant call-log access when asked.
4. Make one call to any lead, reopen the app, tap **Sync now** — then log
   that call in the CRM web app: the blue "phone shows a call…" strip should
   offer it. That's the whole verification.

**Do not distribute through the Play Store.** Google's policy restricts the
`READ_CALL_LOG` permission to default-dialer apps; an internal sideloaded
tool is the correct and legitimate channel for this app.

**iPhone: not possible.** iOS gives no app access to the call log. This app
is the reason the floor should carry Android handsets.

## Building it

Requires JDK 17+, Android SDK (platform 34, build-tools 34), Gradle 8.7+:

```bash
cd android
ANDROID_HOME=/path/to/android-sdk gradle assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

Or open the `android/` folder in Android Studio and press Run.

The debug-signed APK is fine for the pilot and for internal use. If you later
want a stable release signature (survives "app not installed" conflicts on
updates), create a keystore once and keep it safe:

```bash
keytool -genkeypair -v -keystore 5c-release.keystore -alias crm \
  -keyalg RSA -keysize 2048 -validity 10000
```

## What talks to what

```
Phone call log ──READ_CALL_LOG──> 5C Call Sync ──HTTPS──> POST /device-logs/sync
                                                             │ matches numbers to
                                                             │ the caller's leads
CRM log-call form <── one-click "use it" ── device-log suggestion
        └─> call_attempts.is_verified = true  →  "unverified dials" column
```

Server contract and tests: `api/src/routes/deviceLogs.ts`,
`api/test/api.test.ts` ("device call-log sync").

## Status

Code complete and compiling; the APK's package, permissions and signature are
verified. **Not yet run on a physical handset** — that ten-minute test (step 4
above) is the remaining step, and needs a real Android phone with a SIM.

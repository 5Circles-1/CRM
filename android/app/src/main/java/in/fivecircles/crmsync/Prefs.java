package in.fivecircles.crmsync;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * App-private storage for the server URL, the caller's credentials and the
 * current session token.
 *
 * Android sandboxes this file to the app itself; other apps cannot read it.
 * Credentials are kept so the app can sign back in silently when the 12-hour
 * CRM session expires - without this, callers would retype their password
 * every day and would simply stop using the app.
 */
final class Prefs {
    private static final String FILE = "crm-sync";

    private final SharedPreferences sp;

    Prefs(Context context) {
        sp = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    boolean isConfigured() {
        return !server().isEmpty() && !email().isEmpty() && !password().isEmpty();
    }

    String server()   { return sp.getString("server", ""); }
    String email()    { return sp.getString("email", ""); }
    String password() { return sp.getString("password", ""); }
    String token()    { return sp.getString("token", ""); }
    String userName() { return sp.getString("userName", ""); }
    long lastSyncAt() { return sp.getLong("lastSyncAt", 0L); }
    String lastResult() { return sp.getString("lastResult", ""); }

    void saveLogin(String server, String email, String password,
                   String token, String userName) {
        sp.edit()
          .putString("server", server)
          .putString("email", email)
          .putString("password", password)
          .putString("token", token)
          .putString("userName", userName)
          .apply();
    }

    void saveToken(String token) {
        sp.edit().putString("token", token).apply();
    }

    void saveSyncResult(String result) {
        sp.edit()
          .putLong("lastSyncAt", System.currentTimeMillis())
          .putString("lastResult", result)
          .apply();
    }

    void clear() {
        sp.edit().clear().apply();
    }
}

package in.fivecircles.crmsync;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Talks to the CRM over HTTPS using nothing but the JDK's HttpURLConnection.
 *
 * Two endpoints, both already live and tested on the server:
 *   POST /auth/login          -> { token, user: { full_name } }
 *   POST /device-logs/sync    -> { received, inserted, matched }
 *
 * When the 12-hour session expires the sync gets a 401; the client signs back
 * in with the stored credentials once and retries, so the caller never sees it.
 */
final class ApiClient {

    static final class HttpError extends IOException {
        final int status;
        HttpError(int status, String body) {
            super("HTTP " + status + ": " + body);
            this.status = status;
        }
    }

    private final Prefs prefs;

    ApiClient(Prefs prefs) {
        this.prefs = prefs;
    }

    /** Sign in and return {token, userName}. Throws HttpError on bad password. */
    String[] login(String server, String email, String password)
            throws IOException, JSONException {
        JSONObject body = new JSONObject()
                .put("email", email)
                .put("password", password);
        JSONObject res = post(server + "/auth/login", null, body);
        String token = res.getString("token");
        String name = res.optJSONObject("user") != null
                ? res.getJSONObject("user").optString("fullName",
                      res.getJSONObject("user").optString("full_name", email))
                : email;
        return new String[] { token, name };
    }

    /** Upload one batch (max 500 entries). Returns {inserted, matched}. */
    int[] syncBatch(JSONArray entries) throws IOException, JSONException {
        JSONObject body = new JSONObject().put("entries", entries);
        try {
            JSONObject res = post(prefs.server() + "/device-logs/sync", prefs.token(), body);
            return new int[] { res.getInt("inserted"), res.getInt("matched") };
        } catch (HttpError e) {
            if (e.status != 401) throw e;
            // Session expired: sign back in silently, then retry once.
            String[] fresh = login(prefs.server(), prefs.email(), prefs.password());
            prefs.saveToken(fresh[0]);
            JSONObject res = post(prefs.server() + "/device-logs/sync", prefs.token(), body);
            return new int[] { res.getInt("inserted"), res.getInt("matched") };
        }
    }

    private JSONObject post(String url, String bearer, JSONObject body)
            throws IOException, JSONException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(30_000);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            if (bearer != null && !bearer.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + bearer);
            }
            conn.setDoOutput(true);

            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(payload);
            }

            int status = conn.getResponseCode();
            InputStream stream = status < 400 ? conn.getInputStream() : conn.getErrorStream();
            String text = readAll(stream);
            if (status >= 400) throw new HttpError(status, text);
            return new JSONObject(text);
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(InputStream stream) throws IOException {
        if (stream == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader =
                 new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            char[] buf = new char[4096];
            int n;
            while ((n = reader.read(buf)) > 0) sb.append(buf, 0, n);
        }
        return sb.toString();
    }
}

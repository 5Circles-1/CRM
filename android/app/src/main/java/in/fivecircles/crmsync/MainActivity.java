package in.fivecircles.crmsync;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.text.format.DateFormat;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import org.json.JSONException;

import java.io.IOException;
import java.util.Date;

/**
 * Two states, one screen.
 *
 * Not signed in: server address + email + password -> Connect.
 * Signed in: who you are, permission status, last sync outcome, a big
 * "Sync now" button. The app also syncs itself every time it opens and
 * once an hour in the background.
 */
public final class MainActivity extends Activity {

    private static final int PERMISSION_REQUEST = 71;

    private Prefs prefs;
    private View setupGroup, statusGroup;
    private EditText serverInput, emailInput, passwordInput;
    private TextView setupError, whoText, serverText, permText, lastSyncText, resultText;
    private Button connectButton, syncButton, permButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        prefs = new Prefs(this);

        setupGroup = findViewById(R.id.setupGroup);
        statusGroup = findViewById(R.id.statusGroup);
        serverInput = findViewById(R.id.serverInput);
        emailInput = findViewById(R.id.emailInput);
        passwordInput = findViewById(R.id.passwordInput);
        setupError = findViewById(R.id.setupError);
        whoText = findViewById(R.id.whoText);
        serverText = findViewById(R.id.serverText);
        permText = findViewById(R.id.permText);
        lastSyncText = findViewById(R.id.lastSyncText);
        resultText = findViewById(R.id.resultText);
        connectButton = findViewById(R.id.connectButton);
        syncButton = findViewById(R.id.syncButton);
        permButton = findViewById(R.id.permButton);

        connectButton.setOnClickListener(v -> connect());
        syncButton.setOnClickListener(v -> runSync(true));
        permButton.setOnClickListener(v -> requestPermissions(
                new String[] { Manifest.permission.READ_CALL_LOG }, PERMISSION_REQUEST));
        findViewById(R.id.logoutButton).setOnClickListener(v -> logout());
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
        // Opening the app IS a sync - the most reliable trigger there is on
        // phones whose battery managers throttle background work.
        if (prefs.isConfigured() && hasCallLogPermission()) runSync(false);
    }

    /* ---------------- sign in ---------------- */

    private void connect() {
        String server = serverInput.getText().toString().trim();
        String email = emailInput.getText().toString().trim();
        String password = passwordInput.getText().toString();

        while (server.endsWith("/")) server = server.substring(0, server.length() - 1);
        if (!server.startsWith("https://")) {
            setupError.setText("Server address must start with https://");
            return;
        }
        if (email.isEmpty() || password.isEmpty()) {
            setupError.setText("Email and password are needed.");
            return;
        }

        setupError.setText("");
        connectButton.setEnabled(false);
        connectButton.setText("Connecting…");

        final String fServer = server, fEmail = email, fPassword = password;
        new Thread(() -> {
            String error = null;
            try {
                String[] result = new ApiClient(prefs).login(fServer, fEmail, fPassword);
                prefs.saveLogin(fServer, fEmail, fPassword, result[0], result[1]);
                SyncEngine.scheduleHourly(this);
            } catch (ApiClient.HttpError e) {
                error = e.status == 401 ? "Wrong email or password."
                      : e.status == 423 ? "Account locked - too many attempts. Wait a few minutes."
                      : "Server refused (" + e.status + ").";
            } catch (IOException | JSONException e) {
                error = "Could not reach that address. Check the URL and your internet.";
            }
            final String fError = error;
            runOnUiThread(() -> {
                connectButton.setEnabled(true);
                connectButton.setText("Connect");
                if (fError != null) setupError.setText(fError);
                else {
                    render();
                    if (!hasCallLogPermission()) {
                        requestPermissions(new String[] { Manifest.permission.READ_CALL_LOG },
                                PERMISSION_REQUEST);
                    }
                }
            });
        }, "crm-login").start();
    }

    private void logout() {
        SyncEngine.cancelHourly(this);
        prefs.clear();
        render();
    }

    /* ---------------- sync ---------------- */

    private void runSync(boolean manual) {
        if (!hasCallLogPermission()) {
            resultText.setText("Call log permission is needed first.");
            return;
        }
        if (manual) {
            syncButton.setEnabled(false);
            syncButton.setText("Syncing…");
        }
        new Thread(() -> {
            final String summary = SyncEngine.syncNow(getApplicationContext());
            runOnUiThread(() -> {
                syncButton.setEnabled(true);
                syncButton.setText("Sync now");
                resultText.setText(summary);
                renderTimes();
            });
        }, "crm-sync-manual").start();
    }

    /* ---------------- rendering ---------------- */

    private boolean hasCallLogPermission() {
        return checkSelfPermission(Manifest.permission.READ_CALL_LOG)
                == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        render();
        if (code == PERMISSION_REQUEST && hasCallLogPermission()) runSync(false);
    }

    private void render() {
        boolean configured = prefs.isConfigured();
        setupGroup.setVisibility(configured ? View.GONE : View.VISIBLE);
        statusGroup.setVisibility(configured ? View.VISIBLE : View.GONE);
        if (!configured) return;

        whoText.setText(prefs.userName());
        serverText.setText(prefs.server().replace("https://", ""));
        boolean granted = hasCallLogPermission();
        permText.setText(granted ? "Allowed ✓" : "NOT allowed - tap Grant");
        permButton.setVisibility(granted ? View.GONE : View.VISIBLE);
        renderTimes();
    }

    private void renderTimes() {
        long at = prefs.lastSyncAt();
        lastSyncText.setText(at == 0 ? "Never"
                : DateFormat.format("d MMM, HH:mm", new Date(at)).toString());
        resultText.setText(prefs.lastResult().isEmpty() ? "—" : prefs.lastResult());
    }
}

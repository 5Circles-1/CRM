package in.fivecircles.crmsync;

import android.annotation.SuppressLint;
import android.content.Context;
import android.database.Cursor;
import android.provider.CallLog;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;

/**
 * Reads the phone's own call log - the record Android itself keeps - and
 * turns it into the CRM's sync format.
 *
 * The deviceRowKey is this phone's ANDROID_ID plus the call-log row id, which
 * is what makes re-uploads harmless: the server ignores rows it has already
 * seen, so syncing twice (or after a reinstall on the same phone) can never
 * double-count a call.
 *
 * Privacy, enforced server-side, worth restating here: the CRM only ever
 * SURFACES calls whose number matches a lead already assigned to this caller.
 * Personal calls match nothing and appear on no screen and no report.
 */
final class CallLogReader {

    /** Only look back this far; the server has everything older already. */
    private static final long WINDOW_MS = 3L * 24 * 60 * 60 * 1000;
    /** Hard cap per sync, matching the server's batch ceiling. */
    private static final int MAX_ROWS = 1500;

    @SuppressLint("HardwareIds")
    static JSONArray read(Context context) throws JSONException {
        String deviceId = Settings.Secure.getString(
                context.getContentResolver(), Settings.Secure.ANDROID_ID);
        if (deviceId == null || deviceId.isEmpty()) deviceId = "unknown-device";

        JSONArray entries = new JSONArray();
        long since = System.currentTimeMillis() - WINDOW_MS;

        String[] projection = {
                CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE,
                CallLog.Calls.DATE, CallLog.Calls.DURATION,
        };

        try (Cursor cursor = context.getContentResolver().query(
                CallLog.Calls.CONTENT_URI, projection,
                CallLog.Calls.DATE + " > ?", new String[] { String.valueOf(since) },
                CallLog.Calls.DATE + " DESC")) {

            if (cursor == null) return entries;

            int idCol = cursor.getColumnIndexOrThrow(CallLog.Calls._ID);
            int numberCol = cursor.getColumnIndexOrThrow(CallLog.Calls.NUMBER);
            int typeCol = cursor.getColumnIndexOrThrow(CallLog.Calls.TYPE);
            int dateCol = cursor.getColumnIndexOrThrow(CallLog.Calls.DATE);
            int durationCol = cursor.getColumnIndexOrThrow(CallLog.Calls.DURATION);

            while (cursor.moveToNext() && entries.length() < MAX_ROWS) {
                String direction = direction(cursor.getInt(typeCol));
                if (direction == null) continue;

                String number = cursor.getString(numberCol);
                if (number == null || number.trim().length() < 4) continue;

                entries.put(new JSONObject()
                        .put("deviceRowKey", deviceId + ":" + cursor.getLong(idCol))
                        .put("msisdn", number.trim())
                        .put("direction", direction)
                        .put("startedAt",
                             Instant.ofEpochMilli(cursor.getLong(dateCol)).toString())
                        .put("durationSeconds",
                             Math.max(0, (int) cursor.getLong(durationCol))));
            }
        }
        return entries;
    }

    private static String direction(int type) {
        switch (type) {
            case CallLog.Calls.INCOMING_TYPE: return "incoming";
            case CallLog.Calls.OUTGOING_TYPE: return "outgoing";
            case CallLog.Calls.MISSED_TYPE:   return "missed";
            case CallLog.Calls.REJECTED_TYPE: return "rejected";
            default: return null; // voicemail, blocked, external - not calls we track
        }
    }
}

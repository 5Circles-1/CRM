package in.fivecircles.crmsync;

import android.content.ComponentName;
import android.content.Context;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;

import org.json.JSONArray;

/**
 * One sync = read the recent call log, upload it in batches of 500, remember
 * the outcome. Both the "Sync now" button and the hourly background job call
 * this; it is safe to run as often as you like because the server ignores
 * anything it has already seen.
 */
final class SyncEngine {

    private static final int BATCH = 500;
    private static final int JOB_ID = 5100;

    /** Runs the sync and returns a human-readable one-line result. */
    static String syncNow(Context context) {
        Prefs prefs = new Prefs(context);
        if (!prefs.isConfigured()) return "Not signed in yet.";

        try {
            JSONArray all = CallLogReader.read(context);
            if (all.length() == 0) {
                prefs.saveSyncResult("No calls in the last 3 days.");
                return prefs.lastResult();
            }

            ApiClient api = new ApiClient(prefs);
            int uploaded = 0, matched = 0;
            for (int start = 0; start < all.length(); start += BATCH) {
                JSONArray chunk = new JSONArray();
                for (int i = start; i < Math.min(start + BATCH, all.length()); i++) {
                    chunk.put(all.get(i));
                }
                int[] result = api.syncBatch(chunk);
                uploaded += result[0];
                matched += result[1];
            }

            String summary = uploaded == 0
                    ? "Already up to date (" + all.length() + " calls checked)."
                    : uploaded + " new call" + (uploaded == 1 ? "" : "s") + " uploaded, "
                      + matched + " matched to your leads.";
            prefs.saveSyncResult(summary);
            return summary;
        } catch (ApiClient.HttpError e) {
            String summary = e.status == 401
                    ? "Sign-in expired and re-login failed - open the app and sign in again."
                    : "Server said no (" + e.status + "). Tell your admin.";
            prefs.saveSyncResult(summary);
            return summary;
        } catch (Exception e) {
            String summary = "Could not reach the CRM (" +
                    (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage())
                    + "). Will retry on the next sync.";
            prefs.saveSyncResult(summary);
            return summary;
        }
    }

    /** Hourly background sync; survives reboots. Best effort by design -
     *  aggressive battery managers may delay it, which is why the app also
     *  syncs every time it is opened. */
    static void scheduleHourly(Context context) {
        JobScheduler scheduler =
                (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return;
        if (scheduler.getPendingJob(JOB_ID) != null) return;

        JobInfo job = new JobInfo.Builder(JOB_ID,
                new ComponentName(context, SyncJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(60L * 60 * 1000)
                .setPersisted(true)
                .build();
        scheduler.schedule(job);
    }

    static void cancelHourly(Context context) {
        JobScheduler scheduler =
                (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler != null) scheduler.cancel(JOB_ID);
    }
}

package in.fivecircles.crmsync;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** The hourly background sync. All the work lives in SyncEngine. */
public final class SyncJobService extends JobService {

    private Thread worker;

    @Override
    public boolean onStartJob(JobParameters params) {
        worker = new Thread(() -> {
            SyncEngine.syncNow(getApplicationContext());
            jobFinished(params, false);
        }, "crm-sync");
        worker.start();
        return true; // still working on a background thread
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        if (worker != null) worker.interrupt();
        return true; // reschedule
    }
}

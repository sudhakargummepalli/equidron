package in.equidron.jobs;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Drains the job queue.
 *
 * One job at a time, because the queue already guarantees a claim is exclusive: a worker that takes
 * two jobs and dies half way through has two leases to lose. A kind with no handler fails the job
 * rather than completing it silently, so a typo in a job kind shows up as dead work instead of work
 * that quietly never happened.
 *
 * The runner is off unless JOBS_RUNNER_ENABLED=true, because the Node worker reads the same table and
 * two drainers are not needed to prove the queue works.
 */
@Service
public class JobRunner {

    private static final Logger log = LoggerFactory.getLogger(JobRunner.class);

    private final JobQueue queue;
    private final Map<String, Consumer<Map<String, Object>>> handlers = new HashMap<>();

    public JobRunner(JobQueue queue) {
        this.queue = queue;
    }

    public JobRunner on(String kind, Consumer<Map<String, Object>> handler) {
        handlers.put(kind, handler);
        return this;
    }

    /** One pass: claim at most one job, run it, and say whether anything was done. */
    public boolean tickOnce() {
        Map<String, Object> job = queue.claim();
        if (job == null) return false;
        long id = ((Number) job.get("id")).longValue();
        String kind = String.valueOf(job.get("kind"));
        Consumer<Map<String, Object>> handler = handlers.get(kind);
        if (handler == null) {
            log.warn("No handler for job kind {}", kind);
            queue.fail(id, "No handler for kind " + kind);
            return true;
        }
        try {
            handler.accept(job);
            queue.complete(id);
        } catch (RuntimeException e) {
            log.warn("Job {} ({}) failed: {}", id, kind, e.getMessage());
            queue.fail(id, e.getMessage());
        }
        return true;
    }

    /** Drain what is ready now, with a bound so a stuck queue cannot spin forever. */
    public int drain(int max) {
        int done = 0;
        while (done < max && tickOnce()) done++;
        return done;
    }
}
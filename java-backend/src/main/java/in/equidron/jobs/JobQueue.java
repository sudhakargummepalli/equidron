package in.equidron.jobs;

import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * The job queue: the same table the Node worker uses, so either process can drain it.
 *
 * Four properties this must hold, because every one of them is a way to lose or duplicate work:
 *   1. A dedupe key means "queue this once". A second enqueue with the same key writes nothing.
 *   2. Claiming is FOR UPDATE SKIP LOCKED, so two workers never take the same job.
 *   3. A claim carries a lease (locked_until). A worker that dies leaves a job that becomes claimable
 *      again instead of stuck forever.
 *   4. A failure retries with backoff, and after max_attempts the job is dead - visible, not silent.
 */
@Service
public class JobQueue {

    private static final int LEASE_SECONDS = 120;

    private final JdbcTemplate jdbc;

    public JobQueue(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Returns the new job id, or 0 when the dedupe key was already queued. */
    public long enqueue(String kind, String payloadJson, String dedupeKey, int maxAttempts) {
        List<Long> ids = jdbc.queryForList(
            "INSERT INTO jobs (kind, payload, status, attempts, max_attempts, run_after, dedupe_key, created_at) " +
            "VALUES (?, ?::jsonb, 'queued', 0, ?, now(), ?, now()) " +
            "ON CONFLICT (dedupe_key) DO NOTHING RETURNING id",
            Long.class, kind, payloadJson == null ? "{}" : payloadJson, Math.max(1, maxAttempts), dedupeKey);
        return ids.isEmpty() ? 0 : ids.get(0);
    }

    /** One job, or null if the queue is empty. Safe to call from several workers at once. */
    public Map<String, Object> claim() {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "UPDATE jobs SET status = 'running', attempts = attempts + 1, " +
            "                locked_until = now() + make_interval(secs => ?) " +
            "WHERE id = (" +
            "  SELECT id FROM jobs WHERE status = 'queued' AND run_after <= now() " +
            "  ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1" +
            ") RETURNING id, kind, payload, attempts, max_attempts", LEASE_SECONDS);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public void complete(long jobId) {
        jdbc.update("UPDATE jobs SET status = 'done', locked_until = NULL, finished_at = now(), last_error = NULL WHERE id = ?", jobId);
    }

    /** Retry with backoff, or bury it. The decision is made here, in Java, and written plainly. */
    public String fail(long jobId, String error) {
        List<Map<String, Object>> rows = jdbc.queryForList(
            "SELECT attempts, max_attempts FROM jobs WHERE id = ?", jobId);
        if (rows.isEmpty()) return "missing";
        int attempts = ((Number) rows.get(0).get("attempts")).intValue();
        int max = ((Number) rows.get(0).get("max_attempts")).intValue();
        if (attempts >= max) {
            jdbc.update("UPDATE jobs SET status = 'dead', last_error = ?, locked_until = NULL, finished_at = now() WHERE id = ?",
                error, jobId);
            return "dead";
        }
        int delaySeconds = Math.min(300, 2 * attempts);
        jdbc.update("UPDATE jobs SET status = 'queued', last_error = ?, locked_until = NULL, " +
                    "run_after = now() + make_interval(secs => ?) WHERE id = ?", error, delaySeconds, jobId);
        return "queued";
    }

    public Map<String, Object> stats() {
        return jdbc.queryForMap(
            "SELECT count(*) FILTER (WHERE status = 'queued') AS queued, " +
            "       count(*) FILTER (WHERE status = 'running') AS running, " +
            "       count(*) FILTER (WHERE status = 'dead') AS dead, " +
            "       count(*) FILTER (WHERE status = 'failed') AS failed, " +
            "       count(*) FILTER (WHERE status = 'done') AS done FROM jobs");
    }
}

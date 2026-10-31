package in.equidron.jobs;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/** The queue's four promises, each asserted against the real jobs table. */
@SpringBootTest
class JobQueueIT {

    @Autowired JobQueue queue;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach
    void clear() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        // claim() takes the oldest due job of any kind, so a job left by another test - or by a previous run of
    // this suite - is what the test would pick up instead of its own. The queue tests start from an empty
    // queue, which is also the only state in which "the next claim is mine" is true.
    jdbc.update("DELETE FROM jobs");
    }

    @Test
    void aDedupeKeyQueuesOnce() {
        long first = queue.enqueue("test:once", "{}", "test:once:1", 3);
        long second = queue.enqueue("test:once", "{}", "test:once:1", 3);
        assertTrue(first > 0);
        assertEquals(0, second, "the second enqueue writes nothing");
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM jobs WHERE dedupe_key = 'test:once:1'", Integer.class));
    }

    @Test
    void twoClaimsTakeDifferentJobs() {
        queue.enqueue("test:a", "{}", "test:a:1", 3);
        queue.enqueue("test:b", "{}", "test:b:1", 3);
        Map<String, Object> one = queue.claim();
        Map<String, Object> two = queue.claim();
        assertNotNull(one);
        assertNotNull(two);
        assertNotEquals(((Number) one.get("id")).longValue(), ((Number) two.get("id")).longValue());
    }

    @Test
    void aClaimHoldsALease() {
        queue.enqueue("test:lease", "{}", "test:lease:1", 3);
        Map<String, Object> job = queue.claim();
        assertNotNull(job);
        Object lease = jdbc.queryForObject("SELECT locked_until FROM jobs WHERE id = ?", Object.class, job.get("id"));
        assertNotNull(lease, "a claimed job carries a lease, so a dead worker's job can be retaken");
    }

    @Test
    void failuresRetryAndThenDie() {
        queue.enqueue("test:fail", "{}", "test:fail:1", 2);
        for (int attempt = 1; attempt <= 2; attempt++) {
            Map<String, Object> job = queue.claim();
            assertNotNull(job, "attempt " + attempt);
            String status = queue.fail(((Number) job.get("id")).longValue(), "boom " + attempt);
            if (attempt < 2) {
                assertEquals("queued", status, "it goes back for another try");
                // The retry waits for its backoff; this test does not, so make it due now.
                jdbc.update("UPDATE jobs SET run_after = now() WHERE dedupe_key = 'test:fail:1'");
            }
            else assertEquals("dead", status, "after max_attempts it is buried, not retried forever");
        }
        assertEquals("boom 2", jdbc.queryForObject("SELECT last_error FROM jobs WHERE dedupe_key = 'test:fail:1'", String.class));
    }

    @Test
    void completingRemovesItFromTheQueue() {
        queue.enqueue("test:done", "{}", "test:done:1", 3);
        Map<String, Object> job = queue.claim();
        queue.complete(((Number) job.get("id")).longValue());
        Map<String, Object> stats = queue.stats();
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM jobs WHERE status = 'queued' AND kind LIKE 'test:%'", Integer.class));
        assertNotNull(stats.get("done"));
    }
}

package in.equidron.jobs;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/** The runner drains a job, fails an unknown kind, and retries a throwing handler. */
@SpringBootTest
class JobRunnerIT {

    @Autowired JobQueue queue;
    @Autowired JobRunner runner;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach
    void clear() {
        assumeTrue(System.getenv("DATABASE_URL") != null, "needs a real PostgreSQL (DATABASE_URL)");
        jdbc.update("DELETE FROM jobs WHERE kind LIKE 'runner:%'");
    }

    @Test
    void aJobWithAHandlerIsRunAndCompleted() {
        AtomicInteger ran = new AtomicInteger();
        runner.on("runner:ok", job -> ran.incrementAndGet());
        queue.enqueue("runner:ok", "{}", "runner:ok:1", 3);
        assertTrue(runner.tickOnce());
        assertEquals(1, ran.get());
        assertEquals("done", jdbc.queryForObject("SELECT status FROM jobs WHERE dedupe_key = 'runner:ok:1'", String.class));
    }

    @Test
    void anUnknownKindIsBuriedRatherThanCompletedSilently() {
        queue.enqueue("runner:nobody", "{}", "runner:nobody:1", 1);
        assertTrue(runner.tickOnce());
        assertEquals("dead", jdbc.queryForObject("SELECT status FROM jobs WHERE dedupe_key = 'runner:nobody:1'", String.class));
        assertEquals("No handler for kind runner:nobody",
            jdbc.queryForObject("SELECT last_error FROM jobs WHERE dedupe_key = 'runner:nobody:1'", String.class));
    }

    @Test
    void aThrowingHandlerIsRetriedAndItsErrorKept() {
        runner.on("runner:boom", job -> { throw new IllegalStateException("kaboom"); });
        queue.enqueue("runner:boom", "{}", "runner:boom:1", 2);
        runner.tickOnce();
        assertEquals("queued", jdbc.queryForObject("SELECT status FROM jobs WHERE dedupe_key = 'runner:boom:1'", String.class));
        jdbc.update("UPDATE jobs SET run_after = now() WHERE dedupe_key = 'runner:boom:1'");
        runner.tickOnce();
        assertEquals("dead", jdbc.queryForObject("SELECT status FROM jobs WHERE dedupe_key = 'runner:boom:1'", String.class));
        assertEquals("kaboom", jdbc.queryForObject("SELECT last_error FROM jobs WHERE dedupe_key = 'runner:boom:1'", String.class));
    }

    @Test
    void anEmptyQueueIsNotAnError() {
        assertFalse(runner.tickOnce());
        assertEquals(0, runner.drain(5));
    }
}
package in.equidron.jobs;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Ticks the queue every few seconds. On unless JOBS_RUNNER_ENABLED=false, because nothing else drains it. */
@Component
@ConditionalOnProperty(name = "JOBS_RUNNER_ENABLED", havingValue = "true", matchIfMissing = true)
public class JobSchedule {

    private final JobRunner runner;

    public JobSchedule(JobRunner runner, in.equidron.notify.OutboxMailer mailer) {
        this.runner = runner;
        // One kind for now, and it is safe to run twice: an email that was already sent is no longer pending.
        runner.on("email:deliver", payload -> mailer.drain(20));
    }

    @Scheduled(fixedDelayString = "${JOBS_TICK_MS:5000}")
    public void tick() {
        runner.drain(10);
    }
}
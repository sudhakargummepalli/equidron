package in.equidron.jobs;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Ticks the runner when the Java side is asked to be the worker. Off by default. */
@Component
@ConditionalOnProperty(name = "JOBS_RUNNER_ENABLED", havingValue = "true")
public class JobSchedule {

    private final JobRunner runner;

    public JobSchedule(JobRunner runner) {
        this.runner = runner;
    }

    @Scheduled(fixedDelayString = "${JOBS_TICK_MS:5000}")
    public void tick() {
        runner.drain(10);
    }
}
package in.equidron;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * The Java side of Equidron, built to sit beside the Node server on the same database.
 *
 * The migration files in netlify/database/migrations are the schema of record, and Flyway reads
 * them as they are, so the two implementations cannot drift apart by accident.
 */
// The job tick is a @Scheduled method; without this it silently never runs.
@org.springframework.scheduling.annotation.EnableScheduling
@SpringBootApplication
public class ApiApplication {
    public static void main(String[] args) {
        SpringApplication.run(ApiApplication.class, args);
    }
}
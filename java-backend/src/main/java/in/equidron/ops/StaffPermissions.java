package in.equidron.ops;

import java.util.List;
import org.springframework.stereotype.Component;

/**
 * Who may do what inside Ops.
 *
 * The schema allows the roles customer, seller, ops and agent - there is no "admin" role, and inventing
 * one would mean changing a CHECK constraint that the Node server also relies on. So admin is a
 * permission, granted per address, and the pages already read a permission list.
 *
 * This is the honest interim: a list of addresses in one place, rather than a table. When the team grows,
 * this becomes staff_permissions with the same shape and nothing else changes.
 */
@Component
public class StaffPermissions {

    /** The addresses that may do everything. */
    private static final List<String> ADMINS = List.of("sudhakargummepalli+ops@gmail.com", "ops@example.com");

    /** Everything a reviewer needs: the panels, without the money and agent controls. */
    private static final List<String> REVIEWER = List.of("review", "returns", "support");

    public List<String> forEmail(String email) {
        return ADMINS.contains(String.valueOf(email).toLowerCase())
            ? List.of("admin")
            : REVIEWER;
    }
}
package in.equidron.shipping;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The one place that decides what a shipment may become next.
 *
 * There were two, and they disagreed: Ops walked pending, packed, shipped, in_transit, out_for_delivery,
 * delivered, while Seller Central jumped from shipped straight to delivered - so the same parcel had a
 * different history depending on who clicked. A parcel's states are a fact about the world, not a preference
 * of the screen you happen to be on, so they live here and both callers ask.
 *
 * A failed attempt is not an end: the parcel goes back out. That is why it has a next state rather than
 * being terminal.
 */
public final class ShipmentStates {

    /** What each state may become. A state missing from this map is finished. */
    private static final Map<String, String> NEXT = new LinkedHashMap<>();

    static {
        NEXT.put("pending", "packed");
        NEXT.put("packed", "shipped");
        NEXT.put("shipped", "in_transit");
        NEXT.put("in_transit", "out_for_delivery");
        NEXT.put("out_for_delivery", "delivered");
        // Nobody was in: try again. A parcel that comes back becomes returned, never pending again.
        NEXT.put("failed_attempt", "out_for_delivery");
        NEXT.put("returning", "returned");
    }

    /** States a parcel may be in, including the ones a carrier reports. */
    public static final Set<String> ALL = Set.of(
        "pending", "packed", "shipped", "in_transit", "out_for_delivery", "delivered",
        "failed_attempt", "returning", "returned", "cancelled");

    private ShipmentStates() {
    }

    /** The next state, or null when this one is finished. */
    public static String next(String current) {
        return current == null ? null : NEXT.get(current);
    }

    public static boolean finished(String current) {
        return next(current) == null;
    }

    /**
     * Whether a carrier's report may move a parcel from one state to another.
     *
     * A carrier may report a forward state, and may report a failed attempt - but it may not walk a finished
     * parcel backwards, and it may never move one to "pending", because that is a state only we create.
     */
    public static boolean accepts(String from, String to) {
        if (from == null || to == null) return false;
        if (!ALL.contains(to) || "pending".equals(to)) return false;
        if (from.equals(to)) return false;
        // A pending parcel has not been handed to a carrier yet, so a carrier cannot report anything about it.
        // Otherwise "delivered" for a parcel nobody collected would be believed.
        if ("pending".equals(from)) return false;
        if ("failed_attempt".equals(to)) {
            return List.of("out_for_delivery", "in_transit", "delivered", "shipped").contains(from);
        }
        // A carrier that catches up in one message is believed: shipped -> delivered happens in the real world.
        String walk = from;
        for (int i = 0; i < ALL.size(); i++) {
            walk = next(walk);
            if (walk == null) return false;
            if (walk.equals(to)) return true;
        }
        return false;
    }
}

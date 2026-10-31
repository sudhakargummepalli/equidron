package in.equidron.shipping;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** A parcel's states are a fact, so they are asserted rather than trusted to the last person who edited a screen. */
class ShipmentStatesTest {

    @Test
    void walksForwardOneStepAtATime() {
        assertTrue(ShipmentStates.next("pending").equals("packed"));
        assertTrue(ShipmentStates.next("packed").equals("shipped"));
        assertTrue(ShipmentStates.next("shipped").equals("in_transit"));
        assertTrue(ShipmentStates.next("in_transit").equals("out_for_delivery"));
        assertTrue(ShipmentStates.next("out_for_delivery").equals("delivered"));
        assertTrue(ShipmentStates.next("delivered") == null, "delivered is finished");
    }

    @Test
    void aFailedAttemptTriesAgain() {
        assertTrue(ShipmentStates.next("failed_attempt").equals("out_for_delivery"));
        assertTrue(ShipmentStates.accepts("out_for_delivery", "failed_attempt"));
        assertTrue(ShipmentStates.accepts("delivered", "failed_attempt"), "a customer can say it never arrived");
    }

    @Test
    void aCarrierMayNotWalkBackwardsOrInventAPendingParcel() {
        assertFalse(ShipmentStates.accepts("delivered", "in_transit"));
        assertFalse(ShipmentStates.accepts("delivered", "pending"));
        assertFalse(ShipmentStates.accepts("pending", "delivered"), "only we create a pending parcel");
        assertFalse(ShipmentStates.accepts("returned", "out_for_delivery"));
        assertFalse(ShipmentStates.accepts("in_transit", "nonsense"));
    }

    @Test
    void aCarrierMayCatchUpInOneMessage() {
        assertTrue(ShipmentStates.accepts("shipped", "delivered"));
        assertTrue(ShipmentStates.accepts("packed", "out_for_delivery"));
    }
}
package in.equidron.integrations;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

/** Order creation: the minimum, the amount echoed back, and a refusal without keys. */
class RazorpayOrdersTest {

    @Test
    void aSimulatedOrderCarriesTheAmountAndSaysItIsSimulated() {
        RazorpayOrders.CreatedOrder order = RazorpayOrders.provider(false, "", "").create(50000, "order-1");
        assertEquals(50000, order.amountPaise());
        assertEquals("order-1", order.receipt());
        assertEquals("simulated", order.mode());
        assertTrue(order.id().startsWith("order_sim_"));
    }

    @Test
    void oneRupeeIsTheMinimumAndLessIsRefused() {
        assertEquals(100, RazorpayOrders.provider(false, "", "").create(100, "r").amountPaise());
        assertThrows(IllegalArgumentException.class, () -> RazorpayOrders.provider(false, "", "").create(99, "r"));
        assertThrows(IllegalArgumentException.class, () -> RazorpayOrders.provider(false, "", "").create(0, "r"));
    }

    @Test
    void theLiveProviderRefusesWithoutKeys() {
        assertThrows(IllegalStateException.class, () -> RazorpayOrders.provider(true, "", "").create(50000, "r"));
        assertThrows(IllegalStateException.class, () -> RazorpayOrders.provider(true, "rzp_test_x", "").create(50000, "r"));
    }

    @Test
    void theMinimumCheckHappensBeforeAnyNetworkCall() {
        assertThrows(IllegalArgumentException.class, () -> RazorpayOrders.provider(true, "rzp_test_x", "secret").create(50, "r"));
    }
}

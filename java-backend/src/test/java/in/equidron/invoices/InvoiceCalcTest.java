package in.equidron.invoices;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

/** The arithmetic that goes on every invoice a customer keeps. */
class InvoiceCalcTest {

    @Test
    void taxIsBackedOutOfAnInclusiveTotal() {
        InvoiceCalc.Tax t = InvoiceCalc.splitTax(118000, false); // 1180 rupees including 18%
        assertEquals(100000, t.taxablePaise());
        assertEquals(18000, t.cgstPaise() + t.sgstPaise());
        assertEquals(118000, t.totalPaise());
    }

    @Test
    void theSplitAddsBackToTheTotalExactlyEvenWhenItIsOdd() {
        for (long total : new long[] { 100, 101, 999, 10000, 1234567, 99999999 }) {
            InvoiceCalc.Tax t = InvoiceCalc.splitTax(total, false);
            assertEquals(total, t.taxablePaise() + t.cgstPaise() + t.sgstPaise(), "intra-state: " + total);
            InvoiceCalc.Tax across = InvoiceCalc.splitTax(total, true);
            assertEquals(total, across.taxablePaise() + across.igstPaise(), "inter-state: " + total);
        }
    }

    @Test
    void interStateIsOneIgstAndNoCgst() {
        InvoiceCalc.Tax t = InvoiceCalc.splitTax(50000, true);
        assertEquals(0, t.cgstPaise());
        assertEquals(0, t.sgstPaise());
        assertTrue(t.igstPaise() > 0);
        assertEquals(50000, t.taxablePaise() + t.igstPaise());
    }

    @Test
    void aNegativeTotalIsRefusedRatherThanInvoiced() {
        assertThrows(IllegalArgumentException.class, () -> InvoiceCalc.splitTax(-1, false));
    }

    @Test
    void numbersSortInTheOrderTheyWereIssued() {
        assertEquals("INV-202610-0001", InvoiceCalc.number("202610", 1));
        assertEquals("INV-202610-0042", InvoiceCalc.number("202610", 42));
        assertEquals("INV-202611-0001", InvoiceCalc.number("202611", 1));
        assertThrows(IllegalArgumentException.class, () -> InvoiceCalc.number("2026-10", 1));
        assertThrows(IllegalArgumentException.class, () -> InvoiceCalc.number("202610", 0));
    }
}
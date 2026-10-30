package in.equidron.invoices;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

/** A PDF a reader will actually open: header, xref, trailer, and the figures it claims. */
class InvoicePdfTest {

    private byte[] pdf() {
        return InvoicePdf.render("INV-202610-0001", "30 October 2026", List.of(
            new InvoicePdf.Line("Order", "12"),
            new InvoicePdf.Line("Taxable", "Rs. 1000.00"),
            new InvoicePdf.Line("CGST 9%", "Rs. 90.00"),
            new InvoicePdf.Line("SGST 9%", "Rs. 90.00"),
            new InvoicePdf.Line("Total", "Rs. 1180.00")));
    }

    @Test
    void itIsAPdfWithACatalogPagesPageFontAndTrailer() {
        String text = new String(pdf(), StandardCharsets.ISO_8859_1);
        assertTrue(text.startsWith("%PDF-1.4"));
        assertTrue(text.trim().endsWith("%%EOF"));
        assertTrue(text.contains("/Type/Catalog"));
        assertTrue(text.contains("/BaseFont/Helvetica"));
        assertTrue(text.contains("startxref"));
        assertTrue(text.contains("INV-202610-0001"));
    }

    @Test
    void theFiguresAndLabelsAreInTheDocument() {
        String text = new String(pdf(), StandardCharsets.ISO_8859_1);
        assertTrue(text.contains("Taxable"));
        assertTrue(text.contains("Rs. 1180.00"));
    }

    @Test
    void parenthesesAndBackslashesAreEscapedSoTheyCannotBreakThePage() {
        assertEquals("a \\(b\\) c", InvoicePdf.esc("a (b) c"));
        assertEquals("back\\\\slash", InvoicePdf.esc("back\\slash"));
        assertEquals("Rs. 5", InvoicePdf.esc("\u20b9 5"));
        assertDoesNotThrow(() -> InvoicePdf.render("INV-1", "x", List.of(new InvoicePdf.Line("(", ")"))));
    }
}
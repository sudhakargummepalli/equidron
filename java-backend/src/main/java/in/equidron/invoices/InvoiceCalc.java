package in.equidron.invoices;

import java.util.Locale;

/**
 * Invoice arithmetic: GST inside a tax-inclusive price.
 *
 * Indian prices are quoted inclusive of tax, so the tax is backed out rather than added: taxable is
 * total / (1 + rate), and the tax is the remainder. Getting that backwards overcharges every customer
 * by 18 percent, which is why it is a pure function with tests instead of arithmetic scattered in a
 * PDF builder.
 *
 * Intra-state supply splits the tax into CGST and SGST; inter-state is a single IGST. Rounding stays
 * in integer paise, and the split always adds back to the total exactly.
 */
public final class InvoiceCalc {

    public static final int GST_BPS = 1800; // 18%

    public record Tax(long taxablePaise, long cgstPaise, long sgstPaise, long igstPaise, long totalPaise) {}

    private InvoiceCalc() {}

    public static Tax splitTax(long totalPaise, boolean interState) {
        if (totalPaise < 0) throw new IllegalArgumentException("An invoice total cannot be negative.");
        long taxable = Math.round(totalPaise * 10_000.0 / (10_000 + GST_BPS));
        long tax = totalPaise - taxable;
        if (interState) return new Tax(taxable, 0, 0, tax, totalPaise);
        long half = tax / 2;
        return new Tax(taxable, half, tax - half, 0, totalPaise);
    }

    /** INV-YYYYMM-0001, with the sequence zero-padded so the files sort in the order they were issued. */
    public static String number(String yearMonth, int sequence) {
        if (yearMonth == null || !yearMonth.matches("\\d{6}")) {
            throw new IllegalArgumentException("The period must be YYYYMM.");
        }
        if (sequence < 1) throw new IllegalArgumentException("Invoice numbers start at 1.");
        return String.format(Locale.ROOT, "INV-%s-%04d", yearMonth, sequence);
    }
}
package in.equidron.invoices;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * A one-page A4 invoice, written as PDF bytes directly - no library, no fonts to embed.
 *
 * A PDF is a header, a few numbered objects, a page that draws text at coordinates, and a trailer
 * pointing at the catalog. That is small enough to write by hand, and it keeps the dependency list at
 * zero, which matters more here than elegance: this file is the one a customer keeps.
 */
public final class InvoicePdf {

    private InvoicePdf() {}

    public record Line(String label, String value) {}

    public static byte[] render(String number, String issuedOn, List<Line> lines) {
        List<String> content = new ArrayList<>();
        content.add("BT /F1 18 Tf 60 780 Td (Invoice " + esc(number) + ") Tj ET");
        content.add("BT /F1 10 Tf 60 760 Td (Issued " + esc(issuedOn) + ") Tj ET");
        content.add("0.8 w 60 745 m 535 745 l S");

        int y = 720;
        for (Line line : lines) {
            content.add("BT /F1 10 Tf 60 " + y + " Td (" + esc(line.label()) + ") Tj ET");
            content.add("BT /F1 10 Tf 400 " + y + " Td (" + esc(line.value()) + ") Tj ET");
            y -= 18;
        }
        String stream = String.join("\n", content);

        StringBuilder pdf = new StringBuilder();
        List<Integer> offsets = new ArrayList<>();
        pdf.append("%PDF-1.4\n");

        offsets.add(pdf.length());
        pdf.append("1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n");
        offsets.add(pdf.length());
        pdf.append("2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n");
        offsets.add(pdf.length());
        pdf.append("3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n");
        offsets.add(pdf.length());
        pdf.append("4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n");
        offsets.add(pdf.length());
        pdf.append("5 0 obj<</Length ").append(stream.getBytes(StandardCharsets.ISO_8859_1).length)
           .append(">>stream\n").append(stream).append("\nendstream endobj\n");

        int xref = pdf.length();
        pdf.append("xref\n0 6\n0000000000 65535 f \n");
        for (int offset : offsets) pdf.append(String.format(Locale.ROOT, "%010d 00000 n \n", offset));
        pdf.append("trailer<</Size 6/Root 1 0 R>>\nstartxref\n").append(xref).append("\n%%EOF\n");
        return pdf.toString().getBytes(StandardCharsets.ISO_8859_1);
    }

    /** PDF strings are parenthesised, so parentheses and backslashes escape; rupees stay as "Rs." */
    static String esc(String text) {
        return String.valueOf(text)
            .replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            .replace("\u20b9", "Rs.");
    }
}
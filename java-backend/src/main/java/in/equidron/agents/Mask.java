package in.equidron.agents;

/** What a person is allowed to see: personal data is replaced before it is stored or shown. */
public final class Mask {

    private Mask() {}

    private static final java.util.regex.Pattern EMAIL = java.util.regex.Pattern.compile("[\\w.+-]+@[\\w-]+\\.[\\w.]+");
    private static final java.util.regex.Pattern PHONE = java.util.regex.Pattern.compile("\\+?\\d[\\d ()-]{8,}\\d");
    private static final java.util.regex.Pattern CARD = java.util.regex.Pattern.compile("\\b\\d{13,19}\\b");
    private static final java.util.regex.Pattern TOKEN = java.util.regex.Pattern.compile("\\b(sk|ghp|ghs|rzp|whsec)_[A-Za-z0-9_]{8,}\\b");

    public static String mask(String text) {
        if (text == null) return null;
        String out = CARD.matcher(text).replaceAll("[card]");
        out = EMAIL.matcher(out).replaceAll("[email]");
        out = PHONE.matcher(out).replaceAll("[phone]");
        return TOKEN.matcher(out).replaceAll("[secret]");
    }
}
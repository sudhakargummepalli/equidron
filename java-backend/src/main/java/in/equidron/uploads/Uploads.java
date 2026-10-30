package in.equidron.uploads;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Uploads: seller documents and product photos.
 *
 * The three rules that matter, in order:
 *   1. The stored name is generated, never the caller's. A filename from the browser is a path
 *      traversal waiting to happen, and "vacation.png" can carry anything.
 *   2. The type is checked against an allow list, and against the bytes as far as is cheap to do.
 *   3. The size is capped before the file is written, not after.
 *
 * Files land in a folder the Java app owns; the database stores the returned URL, not the bytes.
 */
@Service
public class Uploads {

    public static final long MAX_BYTES = 5L * 1024 * 1024;
    private static final Set<String> ALLOWED = Set.of("png", "jpg", "jpeg", "pdf", "webp");

    private final Path root;
    private final SecureRandom random = new SecureRandom();

    public Uploads(@Value("${UPLOAD_DIR:uploads}") String directory) {
        this.root = Path.of(directory).toAbsolutePath().normalize();
    }

    public record Stored(String name, String url, long bytes, String extension) {}

    public Stored store(String originalName, String contentType, byte[] bytes) {
        if (bytes == null || bytes.length == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The file is empty.");
        }
        if (bytes.length > MAX_BYTES) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "That file is larger than 5 MB.");
        }
        String extension = extensionOf(originalName);
        if (!ALLOWED.contains(extension)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Only PNG, JPEG, WEBP and PDF files are accepted.");
        }
        if (!looksLike(bytes, extension)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "That file's contents do not match its name.");
        }

        byte[] raw = new byte[16];
        random.nextBytes(raw);
        String name = HexFormat.of().formatHex(raw) + "." + extension;
        try {
            Files.createDirectories(root);
            Files.copy(new java.io.ByteArrayInputStream(bytes), root.resolve(name), StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "The file could not be stored.");
        }
        return new Stored(name, "/uploads/" + name, bytes.length, extension);
    }

    static String extensionOf(String name) {
        if (name == null) return "";
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    /** The first bytes tell the truth about a type more cheaply than the name does. */
    static boolean looksLike(byte[] bytes, String extension) {
        if (bytes.length < 4) return false;
        return switch (extension) {
            case "png" -> (bytes[0] & 0xFF) == 0x89 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G';
            case "jpg", "jpeg" -> (bytes[0] & 0xFF) == 0xFF && (bytes[1] & 0xFF) == 0xD8;
            case "webp" -> bytes.length > 11 && bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F';
            case "pdf" -> bytes[0] == '%' && bytes[1] == 'P' && bytes[2] == 'D' && bytes[3] == 'F';
            default -> false;
        };
    }
}
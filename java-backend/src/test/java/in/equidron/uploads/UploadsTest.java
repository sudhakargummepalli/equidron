package in.equidron.uploads;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.server.ResponseStatusException;

/** The rules that keep an upload handler from being a way to write files on the server. */
class UploadsTest {

    private static final byte[] PNG = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0};

    @Test
    void aPngIsStoredUnderAGeneratedNameNotTheCallers(@TempDir Path dir) throws Exception {
        Uploads uploads = new Uploads(dir.toString());
        Uploads.Stored stored = uploads.store("../../etc/passwd.png", "image/png", PNG);
        assertEquals("png", stored.extension());
        assertTrue(stored.name().matches("[0-9a-f]{32}\\.png"), stored.name());
        assertTrue(Files.exists(dir.resolve(stored.name())), "stored inside the folder it owns");
        assertEquals("/uploads/" + stored.name(), stored.url());
    }

    @Test
    void aDisallowedExtensionIsRefused(@TempDir Path dir) {
        Uploads uploads = new Uploads(dir.toString());
        assertEquals(400, assertThrows(ResponseStatusException.class,
            () -> uploads.store("shell.exe", "application/octet-stream", PNG)).getStatusCode().value());
        assertEquals(400, assertThrows(ResponseStatusException.class,
            () -> uploads.store("noextension", "image/png", PNG)).getStatusCode().value());
    }

    @Test
    void theContentsMustMatchTheName(@TempDir Path dir) {
        Uploads uploads = new Uploads(dir.toString());
        assertEquals(400, assertThrows(ResponseStatusException.class,
            () -> uploads.store("photo.png", "image/png", "<?php echo 1; ?>".getBytes())).getStatusCode().value());
    }

    @Test
    void emptyAndOversizedFilesAreRefused(@TempDir Path dir) {
        Uploads uploads = new Uploads(dir.toString());
        assertEquals(400, assertThrows(ResponseStatusException.class,
            () -> uploads.store("a.png", "image/png", new byte[0])).getStatusCode().value());
        byte[] huge = new byte[(int) Uploads.MAX_BYTES + 1];
        huge[0] = (byte) 0x89; huge[1] = 'P'; huge[2] = 'N'; huge[3] = 'G';
        assertEquals(413, assertThrows(ResponseStatusException.class,
            () -> uploads.store("big.png", "image/png", huge)).getStatusCode().value());
    }
}
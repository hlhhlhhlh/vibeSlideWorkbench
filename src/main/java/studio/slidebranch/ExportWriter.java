package studio.slidebranch;

import java.awt.Dimension;
import java.awt.geom.Rectangle2D;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.Map;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.poi.sl.usermodel.PictureData.PictureType;
import org.apache.poi.xslf.usermodel.XMLSlideShow;
import static studio.slidebranch.Database.number;

final class ExportWriter {
    private static final int WIDTH = 960;
    private static final int HEIGHT = 540;

    static void write(Path target, String format, Path directory, List<Map<String, Object>> rows) throws IOException {
        Path temp = Files.createTempFile(target.getParent(), "export-", ".tmp");
        try {
            if (format.equals("pptx")) {
                pptx(temp, directory, rows);
            } else {
                pdf(temp, directory, rows);
            }
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    private static Rectangle2D frame(Map<String, Object> row) {
        long width = number(row, "width");
        long height = number(row, "height");
        double scale = Math.min((double) WIDTH / width, (double) HEIGHT / height);
        return new Rectangle2D.Double((WIDTH - width * scale) / 2, (HEIGHT - height * scale) / 2,
                width * scale, height * scale);
    }

    private static void pptx(Path file, Path directory, List<Map<String, Object>> rows) throws IOException {
        try (var deck = new XMLSlideShow(); var output = Files.newOutputStream(file)) {
            deck.setPageSize(new Dimension(WIDTH, HEIGHT));
            for (var row : rows) {
                PictureType type = PictureType.PNG;
                if ("image/jpeg".equals(row.get("mime_type"))) {
                    type = PictureType.JPEG;
                }
                var image = deck.addPicture(directory.resolve((String) row.get("storage_key")).toFile(), type);
                deck.createSlide().createPicture(image).setAnchor(frame(row));
            }
            deck.write(output);
        }
    }

    private static void pdf(Path file, Path directory, List<Map<String, Object>> rows) throws IOException {
        try (var pdf = new PDDocument()) {
            for (var row : rows) {
                var page = new PDPage(new PDRectangle(WIDTH, HEIGHT));
                pdf.addPage(page);
                var image = PDImageXObject.createFromFileByContent(directory.resolve((String) row.get("storage_key")).toFile(), pdf);
                var frame = frame(row);
                try (var output = new PDPageContentStream(pdf, page)) {
                    output.drawImage(image, (float) frame.getX(), (float) frame.getY(),
                            (float) frame.getWidth(), (float) frame.getHeight());
                }
            }
            pdf.save(file.toFile());
        }
    }
}

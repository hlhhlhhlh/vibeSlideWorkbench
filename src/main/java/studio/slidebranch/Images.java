package studio.slidebranch;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.awt.Color;
import java.awt.Font;
import java.awt.GradientPaint;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import java.util.function.Consumer;
import javax.imageio.ImageIO;

final class Images {
    static final int MAX_BYTES = 20 * 1024 * 1024;
    private final String key = environment("IMAGE_API_KEY", "");
    private final String base = environment("IMAGE_API_BASE", "https://api.openai.com/v1").replaceAll("/+$", "");
    private final String configuredModel;
    private final String size;
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();

    private final RightApi rightApi;

    Images(String rightApiKey, String model, String size) {
        rightApi = new RightApi(client, rightApiKey);
        configuredModel = model;
        this.size = size;
    }

    String provider() {
        if (rightApi.configured()) {
            return "rightapi";
        }
        if (key.isBlank()) {
            return "demo";
        }
        return "image-api";
    }

    String model() {
        if (!rightApi.configured() && key.isBlank()) {
            return "local-preview";
        }
        return configuredModel;
    }

    String size() {
        return size;
    }

    byte[] generate(String provider, String model, String size, Path parent, String instruction, long jobId,
                    Consumer<String> taskSubmitted) throws Exception {
        if (provider.equals("rightapi")) {
            return rightApi.generate(model, size, instruction, parent, taskSubmitted);
        }
        if (provider.equals("demo")) {
            return demo(parent, instruction, jobId);
        }
        if (key.isBlank()) {
            throw new IOException("当前未配置生图 API 密钥，请配置后重试。");
        }
        var request = HttpRequest.newBuilder()
                .timeout(Duration.ofMinutes(5))
                .header("Authorization", "Bearer " + key);
        if (parent == null) {
            var body = new JsonObject();
            body.addProperty("model", model);
            body.addProperty("prompt", instruction);
            body.addProperty("size", size);
            request.uri(URI.create(base + "/images/generations"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body.toString()));
        } else {
            String boundary = "slidebranch-" + UUID.randomUUID();
            var output = new ByteArrayOutputStream();
            part(output, boundary, "model", model);
            part(output, boundary, "prompt", instruction);
            part(output, boundary, "size", size);
            String extension = parent.toString().substring(parent.toString().lastIndexOf('.') + 1);
            output.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"slide."
                    + extension + "\"\r\nContent-Type: image/" + extension + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            Files.copy(parent, output);
            output.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
            request.uri(URI.create(base + "/images/edits"))
                    .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                    .POST(HttpRequest.BodyPublishers.ofByteArray(output.toByteArray()));
        }
        var response = client.send(request.build(), HttpResponse.BodyHandlers.ofInputStream());
        try (var stream = response.body()) {
            if (response.statusCode() / 100 != 2) {
                throw new IOException("生图服务返回 HTTP " + response.statusCode() + "。");
            }
            int limit = MAX_BYTES * 2;
            byte[] data = stream.readNBytes(limit + 1);
            if (data.length > limit) {
                throw new IOException("生图响应超过大小限制。");
            }
            var image = JsonParser.parseString(new String(data, StandardCharsets.UTF_8))
                    .getAsJsonObject().getAsJsonArray("data").get(0).getAsJsonObject().get("b64_json");
            if (image == null || image.isJsonNull()) {
                throw new IOException("生图服务没有返回 Base64 图片。");
            }
            return Base64.getDecoder().decode(image.getAsString());
        }
    }

    private static void part(ByteArrayOutputStream output, String boundary, String name, String value) throws IOException {
        output.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name
                + "\"\r\n\r\n" + value + "\r\n").getBytes(StandardCharsets.UTF_8));
    }

    record Asset(String hash, String key, String mime, int width, int height, int size) {}

    static Asset save(Path directory, byte[] bytes) throws Exception {
        if (bytes.length == 0 || bytes.length > MAX_BYTES) {
            throw new Problem(400, "图片大小须在 1 字节到 20 MB 之间。");
        }
        String format;
        int width;
        int height;
        try (var stream = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            var readers = ImageIO.getImageReaders(stream);
            if (!readers.hasNext()) {
                throw new Problem(400, "请使用 PNG 或 JPEG 图片。");
            }
            var reader = readers.next();
            try {
                reader.setInput(stream, true, true);
                format = reader.getFormatName().toLowerCase(java.util.Locale.ROOT);
                if (!format.equals("png") && !format.equals("jpeg")) {
                    throw new Problem(400, "请使用 PNG 或 JPEG 图片。");
                }
                width = reader.getWidth(0);
                height = reader.getHeight(0);
                if (width < 1 || height < 1 || (long) width * height > 25_000_000) {
                    throw new Problem(400, "图片不能超过 2500 万像素。");
                }
                reader.read(0);
            } finally {
                reader.dispose();
            }
        } catch (IOException failure) {
            throw new Problem(400, "图片无法解码。");
        }
        String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        String storageKey = hash + "." + format;
        Path target = directory.resolve(storageKey);
        if (!Files.exists(target)) {
            Path temp = Files.createTempFile(directory, "image-", ".tmp");
            try {
                Files.write(temp, bytes);
                Files.move(temp, target, java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            } finally {
                Files.deleteIfExists(temp);
            }
        }
        return new Asset(hash, storageKey, "image/" + format, width, height, bytes.length);
    }

    private static byte[] demo(Path parent, String instruction, long id) throws IOException {
        var image = new BufferedImage(1280, 720, BufferedImage.TYPE_INT_RGB);
        var graphics = image.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            graphics.setPaint(new GradientPaint(0, 0, new Color(21, 38, 33), 1280, 720, new Color(57, 88, 74)));
            graphics.fillRect(0, 0, 1280, 720);
            if (parent != null) {
                var original = ImageIO.read(parent.toFile());
                double scale = Math.min(1280.0 / original.getWidth(), 720.0 / original.getHeight());
                int width = (int) Math.round(original.getWidth() * scale);
                int height = (int) Math.round(original.getHeight() * scale);
                graphics.drawImage(original, (1280 - width) / 2, (720 - height) / 2, width, height, null);
                graphics.setColor(new Color(16, 32, 26, 225));
                graphics.fillRoundRect(48, 500, 1184, 172, 24, 24);
            }
            int y = 190;
            if (parent != null) {
                y = 552;
            }
            graphics.setColor(new Color(205, 238, 156));
            graphics.setFont(new Font("Dialog", Font.BOLD, 25));
            graphics.drawString("DEMO  /  " + id, 78, y);
            graphics.setColor(Color.WHITE);
            graphics.setFont(new Font("Dialog", Font.PLAIN, 38));
            String line = instruction.replaceAll("\\s+", " ");
            if (line.codePointCount(0, line.length()) > 28) {
                line = line.substring(0, line.offsetByCodePoints(0, 28)) + "…";
            }
            graphics.drawString(line, 78, y + 68);
        } finally {
            graphics.dispose();
        }
        var output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        return output.toByteArray();
    }

    static String environment(String name, String fallback) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            return fallback;
        }
        return value.strip();
    }
}

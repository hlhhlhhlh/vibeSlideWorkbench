package studio.slidebranch;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Base64;
import java.util.Set;
import java.util.function.Consumer;

final class RightApi {
    private final HttpClient client;
    private final String key;
    private final String base = Images.environment("RIGHTAPI_BASE", "https://api.site/v1").replaceAll("/+$", "");

    RightApi(HttpClient client, String key) {
        this.key = key;
        this.client = client;
    }

    boolean configured() {
        return !key.isEmpty();
    }

    byte[] generate(String model, String size, String prompt, Path parent, Consumer<String> taskSubmitted) throws Exception {
        if (!configured()) {
            throw new IOException("请配置 RIGHTAPI_KEY 后重试。");
        }
        var body = new JsonObject();
        body.addProperty("model", model);
        body.addProperty("size", size);
        body.addProperty("prompt", prompt);
        body.addProperty("async", true);
        body.addProperty("output_format", "png");
        String path = "/images/generations";
        if (parent != null) {
            path = "/images/edits";
            String mime = "image/png";
            if (parent.toString().endsWith(".jpeg")) {
                mime = "image/jpeg";
            }
            var inputs = new JsonArray();
            inputs.add("data:" + mime + ";base64," + Base64.getEncoder().encodeToString(Files.readAllBytes(parent)));
            body.add("image", inputs);
        }

        var submit = request(path)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body.toString())).build();
        JsonObject result = json(submit);
        String taskId = "";
        long deadline = System.nanoTime() + Duration.ofMinutes(10).toNanos();
        while (true) {
            if (taskId.isEmpty() && result.has("task_id") && result.get("task_id").isJsonPrimitive()) {
                taskId = result.get("task_id").getAsString();
                if (!taskId.matches("[A-Za-z0-9_-]{1,200}")) {
                    throw new IOException("RightAPI 未返回有效的任务编号。");
                }
                taskSubmitted.accept(taskId);
            }
            String status = "";
            if (result.has("status") && result.get("status").isJsonPrimitive()) {
                status = result.get("status").getAsString();
            }
            if (Set.of("failed", "expired", "canceled").contains(status)) {
                throw new IOException("RightAPI 任务 " + taskId + " " + status + "。" + message(result));
            }
            if (result.has("data")) {
                var items = result.getAsJsonArray("data");
                if (items.isEmpty() || !items.get(0).getAsJsonObject().has("url")) {
                    throw new IOException("RightAPI 未返回图片地址。");
                }
                return download(items.get(0).getAsJsonObject().get("url").getAsString());
            }
            if (taskId.isEmpty()) {
                throw new IOException("RightAPI 未返回有效的任务编号。" + message(result));
            }
            if (System.nanoTime() >= deadline) {
                throw new IOException("等待 RightAPI 结果超时，任务编号 " + taskId);
            }
            Thread.sleep(3000);
            result = json(request("/tasks/" + taskId).GET().build());
        }
    }

    private HttpRequest.Builder request(String path) {
        return HttpRequest.newBuilder(URI.create(base + path))
                .timeout(Duration.ofSeconds(60))
                .header("Authorization", "Bearer " + key);
    }

    private JsonObject json(HttpRequest request) throws Exception {
        var response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
        try (var stream = response.body()) {
            byte[] bytes = stream.readNBytes(65537);
            String context = "RightAPI HTTP " + response.statusCode();
            if (bytes.length > 65536) {
                throw new IOException(context + "，任务响应过大。");
            }
            JsonObject result;
            try {
                result = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
            } catch (RuntimeException error) {
                throw new IOException(context + "，任务响应格式无效。", error);
            }
            if (response.statusCode() / 100 != 2) {
                throw new IOException(context + "。" + message(result));
            }
            return result;
        }
    }

    private String message(JsonObject result) {
        var error = result.get("error");
        if (error != null && error.isJsonObject()) {
            error = error.getAsJsonObject().get("message");
        }
        if (error == null || !error.isJsonPrimitive()) {
            return "";
        }
        return error.getAsString().replace(key, "[已隐藏]");
    }

    private byte[] download(String url) throws Exception {
        URI uri = URI.create(url);
        if (!"https".equalsIgnoreCase(uri.getScheme()) && !URI.create(base).resolve("/").equals(uri.resolve("/"))) {
            throw new IOException("RightAPI 返回了无效的图片地址。");
        }
        var request = HttpRequest.newBuilder(uri).timeout(Duration.ofMinutes(1)).GET().build();
        var response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
        try (var stream = response.body()) {
            if (response.statusCode() / 100 != 2) {
                throw new IOException("下载 RightAPI 图片失败，HTTP " + response.statusCode());
            }
            byte[] bytes = stream.readNBytes(Images.MAX_BYTES + 1);
            if (bytes.length > Images.MAX_BYTES) {
                throw new IOException("RightAPI 图片超过 20 MB。");
            }
            return bytes;
        }
    }
}

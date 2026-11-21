package studio.slidebranch;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Map;
import java.util.List;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public final class Main {
    private static final Gson JSON = new GsonBuilder().serializeNulls().create();
    private final Studio studio;

    private Main(Studio studio) {
        this.studio = studio;
    }

    public static void main(String[] args) throws Exception {
        System.setProperty("java.awt.headless", "true");
        Path dir = Files.createDirectories(Path.of(Images.environment("SLIDEBRANCH_DATA", "data")).toAbsolutePath());
        int port = Integer.parseInt(Images.environment("SLIDEBRANCH_PORT", "8080"));
        start(dir, port);
    }

    static int start(Path dir, int port) throws Exception {
        var lockFile = FileChannel.open(dir.resolve("instance.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE);
        var lock = lockFile.tryLock();
        if (lock == null) {
            lockFile.close();
            throw new IllegalStateException("此数据目录已有运行中的应用。");
        }
        var db = new Database(dir.resolve("slidebranch.db"));
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 32);
        var studio = new Studio(db, dir);
        var main = new Main(studio);
        var workers = Executors.newScheduledThreadPool(2);
        var generations = new GenerationQueue(studio);
        var requests = Executors.newVirtualThreadPerTaskExecutor();
        server.createContext("/", main::handle);
        server.setExecutor(requests);
        workers.scheduleWithFixedDelay(() -> run(generations::dispatch), 0, 350, TimeUnit.MILLISECONDS);
        workers.scheduleWithFixedDelay(() -> run(studio::runExport), 0, 350, TimeUnit.MILLISECONDS);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop(0);
            workers.shutdownNow();
            requests.shutdownNow();
            run(() -> {
                generations.close();
                db.close();
                lock.release();
                lockFile.close();
            });
        }));
        server.start();
        System.out.println("SlideBranch http://127.0.0.1:" + server.getAddress().getPort() + " [" + studio.images.provider() + "]");
        return server.getAddress().getPort();
    }

    @FunctionalInterface
    private interface Task {
        void run() throws Exception;
    }

    private static void run(Task task) {
        try {
            task.run();
        } catch (Exception failure) {
            failure.printStackTrace(System.err);
        }
    }

    private void handle(HttpExchange exchange) throws IOException {
        try {
            exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("Content-Security-Policy",
                    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; "
                            + "font-src https://fonts.gstatic.com; img-src 'self' data:; "
                            + "object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
            String method = exchange.getRequestMethod();
            String host = exchange.getRequestHeaders().getFirst("Host");
            if (host == null || !host.matches("(127\\.0\\.0\\.1|localhost)(:[0-9]+)?")) {
                throw new Problem(403, "仅支持本地访问。");
            }
            if (!method.equals("GET") && !"1".equals(exchange.getRequestHeaders().getFirst("X-SlideBranch"))) {
                throw new Problem(403, "请求缺少应用标识。");
            }
            route(exchange, method, exchange.getRequestURI().getPath());
        } catch (Problem failure) {
            json(exchange, failure.status, Map.of("error", failure.getMessage()));
        } catch (IllegalArgumentException | JsonParseException failure) {
            json(exchange, 400, Map.of("error", "请求数据无效。"));
        } catch (Exception failure) {
            failure.printStackTrace(System.err);
            if (exchange.getResponseCode() == -1) {
                json(exchange, 500, Map.of("error", "操作失败，请查看服务器日志。"));
            }
        } finally {
            exchange.close();
        }
    }

    private void route(HttpExchange exchange, String method, String path) throws Exception {
        if (method.equals("GET") && !path.startsWith("/api/")) {
            staticFile(exchange, path);
            return;
        }
        if (path.equals("/api/settings")) {
            if (method.equals("GET")) {
                json(exchange, 200, studio.settings.view());
                return;
            }
            if (method.equals("POST")) {
                var data = body(exchange);
                String replacement = optionalText(data, "key");
                boolean remove = data.has("removeKey") && data.get("removeKey").getAsBoolean();
                synchronized (studio.settings) {
                    int concurrency = studio.settings.generationConcurrency();
                    if (data.has("generationConcurrency")) {
                        var value = data.get("generationConcurrency");
                        if (!value.isJsonPrimitive() || !value.getAsString().matches("[0-9]+")) {
                            throw new Problem(400, "并发任务数须为非负整数，0 表示不限。");
                        }
                        concurrency = Integer.parseInt(value.getAsString());
                    }
                    studio.settings.save(field(data, "model", 100), field(data, "size", 20), replacement, remove, concurrency);
                    studio.images = studio.settings.images();
                    json(exchange, 200, Map.of("provider", studio.images.provider(), "model", studio.images.model()));
                }
                return;
            }
        }
        if (method.equals("POST") && path.equals("/api/decks/import")) {
            var input = JsonParser.parseString(new String(read(exchange, 8 * 1024 * 1024), StandardCharsets.UTF_8));
            if (!input.isJsonObject()) {
                throw new Problem(400, "文稿须为 JSON 对象。");
            }
            created(exchange, new ProjectActions(studio).importDeck(input.getAsJsonObject()));
            return;
        }
        if (path.equals("/api/decks")) {
            if (method.equals("GET")) {
                json(exchange, 200, Map.of("decks", studio.decks(),
                        "provider", studio.images.provider(), "model", studio.images.model()));
                return;
            }
            if (method.equals("POST")) {
                String title = field(body(exchange), "title", 100);
                created(exchange, studio.db.insert("INSERT INTO decks(title) VALUES(?)", title));
                return;
            }
        }
        if (method.equals("GET") && path.equals("/api/library")) {
            var parameters = queryParameters(exchange);
            String query = queryValue(parameters, "q", "");
            String tag = queryValue(parameters, "tag", "");
            if (query.length() > 100 || tag.length() > 40) {
                throw new Problem(400, "筛选条件过长。");
            }
            json(exchange, 200, Map.of("items", studio.library(query, tag)));
            return;
        }
        if (method.equals("POST") && path.equals("/api/library/upload")) {
            var parameters = queryParameters(exchange);
            String name = queryValue(parameters, "name", "未命名素材");
            var tags = parameters.getOrDefault("tag", List.of());
            created(exchange, studio.uploadLibrary(read(exchange, Images.MAX_BYTES), name, tags));
            return;
        }
        String[] parts = path.split("/");
        if (parts.length < 4 || parts.length > 5 || !parts[1].equals("api")) {
            throw new Problem(404, "地址不存在。");
        }
        long id = Long.parseLong(parts[3]);
        String resource = parts[2];
        String action = "";
        if (parts.length == 5) {
            action = parts[4];
        }
        if (resource.equals("library")) {
            if (method.equals("GET") && action.equals("image")) {
                var asset = studio.libraryAsset(id);
                file(exchange, studio.assets.resolve((String) asset.get("storage_key")), (String) asset.get("mime_type"));
                return;
            }
            if (action.isEmpty()) {
                if (method.equals("GET")) {
                    json(exchange, 200, studio.libraryItem(id));
                    return;
                }
                if (method.equals("PATCH")) {
                    var data = body(exchange);
                    String name = null;
                    List<String> tags = null;
                    if (data.has("name")) {
                        name = field(data, "name", 100);
                    }
                    if (data.has("tags")) {
                        tags = tags(data);
                    }
                    studio.updateLibrary(id, name, tags);
                    json(exchange, 200, studio.libraryItem(id));
                    return;
                }
                if (method.equals("DELETE")) {
                    studio.deleteLibrary(id);
                    json(exchange, 200, Map.of("ok", true));
                    return;
                }
            }
            throw new Problem(404, "地址不存在。");
        }
        if (method.equals("GET") && resource.equals("decks") && action.equals("cleanup")) {
            json(exchange, 200, new ProjectActions(studio).previewCleanup(id));
            return;
        }
        if (method.equals("GET") && resource.equals("decks") && action.equals("costs")) {
            json(exchange, 200, studio.costs(id));
            return;
        }
        if (method.equals("GET") && action.isEmpty()) {
            switch (resource) {
                case "decks" -> json(exchange, 200, studio.deck(id));
                case "jobs" -> json(exchange, 200, studio.job(id));
                case "nodes" -> {
                    var asset = studio.nodeAsset(id);
                    exchange.getResponseHeaders().set("Cache-Control", "private, max-age=31536000, immutable");
                    file(exchange, studio.assets.resolve((String) asset.get("storage_key")), (String) asset.get("mime_type"));
                }
                case "exports" -> {
                    var export = studio.db.one("SELECT * FROM exports WHERE id=? AND status='succeeded'", id);
                    String format = (String) export.get("format");
                    String type = "application/pdf";
                    if (format.equals("pptx")) {
                        type = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
                    }
                    exchange.getResponseHeaders().set("Content-Disposition", "attachment; filename=\"deck-" + id + "." + format + "\"");
                    file(exchange, studio.exportFile(id, format), type);
                }
                default -> throw new Problem(404, "地址不存在。");
            }
            return;
        }
        if (method.equals("DELETE") && resource.equals("decks") && action.isEmpty()) {
            studio.deleteDeck(id);
            json(exchange, 200, Map.of("ok", true));
            return;
        }
        if (method.equals("POST") && resource.equals("decks")) {
            JsonObject data = body(exchange);
            switch (action) {
                case "cleanup" -> {
                    String token = null;
                    if (data.has("token")) {
                        token = optionalText(data, "token");
                    }
                    json(exchange, 200, new ProjectActions(studio).cleanup(id, token));
                }
                case "generate" -> json(exchange, 201, Map.of("jobs", new ProjectActions(studio).generateDeck(id, count(data))));
                case "style" -> {
                    if (studio.db.execute("UPDATE decks SET style=? WHERE id=?", optionalText(data,"style"), id) == 0) {
                        throw new Problem(404, "演示稿不存在。");
                    }
                    json(exchange, 200, Map.of("ok",true));
                }
                case "slides" -> {
                    String title = "";
                    if (data.has("title")) {
                        title = field(data, "title", 100);
                    }
                    created(exchange, studio.addSlide(id, title, optionalId(data, "after")));
                }
                case "exports" -> created(exchange, studio.enqueueExport(id, field(data, "format", 10)));
                default -> throw new Problem(404, "地址不存在。");
            }
            return;
        }
        if (resource.equals("slides")) {
            if (method.equals("POST")) {
                slideAction(exchange, id, action);
                return;
            }
            if (method.equals("DELETE") && action.isEmpty()) {
                if (studio.db.execute("UPDATE slides SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL", id) == 0) {
                    throw new Problem(404, "页面不存在。");
                }
                json(exchange, 200, Map.of("ok", true));
                return;
            }
        }
        throw new Problem(404, "地址不存在。");
    }

    private void slideAction(HttpExchange exchange, long id, String action) throws Exception {
        if (action.equals("upload")) {
            String header = exchange.getRequestHeaders().getFirst("X-Requirements-Revision");
            if (header == null) {
                header = exchange.getRequestHeaders().getFirst("X-Board-Id");
            }
            Long revision = null;
            if (header != null) {
                if (!header.matches("[1-9][0-9]*")) {
                    throw new Problem(400, "页面要求版本无效。");
                }
                revision = Long.valueOf(header);
            }
            created(exchange, studio.upload(id, revision, read(exchange, Images.MAX_BYTES)));
            return;
        }
        JsonObject data = body(exchange);
        switch (action) {
            case "generate" -> {
                String instruction = "";
                if (data.has("instruction")) {
                    instruction = optionalText(data, "instruction");
                }
                var jobs = new ProjectActions(studio).generate(id, expectedRevision(data), optionalId(data, "parent"), instruction, count(data));
                json(exchange, 201, Map.of("id", jobs.getFirst(), "jobs", jobs));
            }
            case "retry" -> created(exchange, studio.retry(id, optionalId(data,"job")));
            case "board", "requirements" -> {
                long revision = studio.saveRequirements(id, expectedRevision(data), field(data, "page_type", 20),
                        optionalText(data, "required_text"), optionalText(data, "content"), optionalText(data, "local_style"));
                json(exchange, 201, Map.of("id", revision, "revision", revision));
            }
            case "library" -> {
                Long item = optionalId(data, "item");
                if (item == null) {
                    throw new Problem(400, "请选择素材。");
                }
                created(exchange, studio.useLibrary(id, item, expectedRevision(data)));
            }
            case "restore" -> {
                studio.restore(id);
                json(exchange,200,Map.of("ok",true));
            }
            case "move" -> {
                Long position = optionalId(data, "position");
                if (position != null) {
                    studio.moveTo(id, position);
                } else {
                    studio.move(id, field(data, "direction", 10));
                }
                json(exchange, 200, Map.of("ok", true));
            }
            case "select" -> {
                Long node = optionalId(data, "node");
                if (node == null) {
                    throw new Problem(400, "请选择图片。");
                }
                studio.select(id, node);
                json(exchange, 200, Map.of("ok", true));
            }
            case "rename" -> {
                if (studio.db.execute("UPDATE slides SET title=? WHERE id=? AND deleted_at IS NULL",
                        field(data, "title", 100), id) == 0) {
                    throw new Problem(404, "页面不存在。");
                }
                json(exchange, 200, Map.of("ok", true));
            }
            default -> throw new Problem(404, "地址不存在。");
        }
    }

    private static int count(JsonObject data) {
        if (!data.has("count")) {
            return 1;
        }
        Long count = optionalId(data, "count");
        if (count == null || count > 16) {
            throw new Problem(400, "候选数量须为 1 到 16。");
        }
        return count.intValue();
    }

    private static Long expectedRevision(JsonObject data) {
        Long revision = optionalId(data, "revision");
        Long board = optionalId(data, "board");
        if (revision != null && board != null && !revision.equals(board)) {
            throw new Problem(400, "页面要求版本不一致。");
        }
        if (revision != null) {
            return revision;
        }
        return board;
    }

    private static List<String> tags(JsonObject data) {
        if (!data.get("tags").isJsonArray()) {
            throw new Problem(400, "标签须为字符串列表。");
        }
        var result = new ArrayList<String>();
        for (var tag : data.getAsJsonArray("tags")) {
            if (!tag.isJsonPrimitive() || !tag.getAsJsonPrimitive().isString()) {
                throw new Problem(400, "标签须为字符串列表。");
            }
            result.add(tag.getAsString());
        }
        return result;
    }

    private static Map<String, List<String>> queryParameters(HttpExchange exchange) {
        var result = new LinkedHashMap<String, List<String>>();
        String query = exchange.getRequestURI().getRawQuery();
        if (query == null) {
            return result;
        }
        if (query.length() > 8192) {
            throw new Problem(400, "查询参数过长。");
        }
        for (String parameter : query.split("&")) {
            String[] pair = parameter.split("=", 2);
            String name = URLDecoder.decode(pair[0], StandardCharsets.UTF_8);
            String value = "";
            if (pair.length == 2) {
                value = URLDecoder.decode(pair[1], StandardCharsets.UTF_8);
            }
            result.computeIfAbsent(name, key -> new ArrayList<>()).add(value);
        }
        return result;
    }

    private static String queryValue(Map<String, List<String>> parameters, String name, String fallback) {
        var values = parameters.get(name);
        if (values == null) {
            return fallback;
        }
        return values.getFirst().strip();
    }

    private static Long optionalId(JsonObject data, String field) {
        var value = data.get(field);
        if (value == null || value.isJsonNull()) {
            return null;
        }
        if (!value.isJsonPrimitive() || !value.getAsString().matches("[1-9][0-9]*")) {
            throw new IllegalArgumentException("Invalid ID");
        }
        return Long.parseLong(value.getAsString());
    }

    private static String optionalText(JsonObject data, String name) {
        var value = data.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()
                || value.getAsString().length() > 4000) {
            throw new Problem(400,"文本须在 4000 个字符以内。");
        }
        return value.getAsString().strip();
    }

    private static String field(JsonObject data, String name, int max) {
        var value = data.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new Problem(400, "请填写必填文本。");
        }
        String text = value.getAsString().strip();
        if (text.isEmpty() || text.length() > max) {
            throw new Problem(400, "文本长度须在 1 到 " + max + " 个字符之间。");
        }
        return text;
    }

    private static JsonObject body(HttpExchange exchange) throws IOException {
        var value = JsonParser.parseString(new String(read(exchange, 64 * 1024), StandardCharsets.UTF_8));
        if (!value.isJsonObject()) {
            throw new Problem(400, "请输入 JSON 对象。");
        }
        return value.getAsJsonObject();
    }

    private static byte[] read(HttpExchange exchange, int limit) throws IOException {
        byte[] bytes = exchange.getRequestBody().readNBytes(limit + 1);
        if (bytes.length > limit) {
            throw new Problem(413, "请求超过大小限制。");
        }
        return bytes;
    }

    private static void created(HttpExchange exchange, long id) throws IOException {
        json(exchange, 201, Map.of("id", id));
    }

    private static void json(HttpExchange exchange, int status, Object value) throws IOException {
        bytes(exchange, status, "application/json; charset=utf-8", JSON.toJson(value).getBytes(StandardCharsets.UTF_8));
    }

    private static void bytes(HttpExchange exchange, int status, String type, byte[] data) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", type);
        exchange.sendResponseHeaders(status, data.length);
        exchange.getResponseBody().write(data);
    }

    private static void file(HttpExchange exchange, Path path, String type) throws IOException {
        if (!Files.isRegularFile(path)) {
            throw new Problem(404, "文件不存在。");
        }
        exchange.getResponseHeaders().set("Content-Type", type);
        exchange.sendResponseHeaders(200, Files.size(path));
        Files.copy(path, exchange.getResponseBody());
    }

    private static void staticFile(HttpExchange exchange, String path) throws IOException {
        String resource = path;
        String type = switch (path) {
            case "/import-example.json" -> "application/json";
            case "/" -> "text/html";
            case "/app.css" -> "text/css";
            case "/app.js", "/theme.js" -> "text/javascript";
            default -> throw new Problem(404, "地址不存在。");
        };
        if (path.equals("/")) {
            resource = "/index.html";
        }
        try (var stream = Main.class.getResourceAsStream("/web" + resource)) {
            if (stream == null) {
                throw new Problem(404, "资源不存在。");
            }
            bytes(exchange, 200, type + "; charset=utf-8", stream.readAllBytes());
        }
    }
}

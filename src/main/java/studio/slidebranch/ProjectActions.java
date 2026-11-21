package studio.slidebranch;

import com.google.gson.JsonObject;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.HexFormat;
import static studio.slidebranch.Database.number;

final class ProjectActions {
    private final Studio studio;
    private final Database db;

    ProjectActions(Studio studio) {
        this.studio = studio;
        db = studio.db;
    }

    long importDeck(JsonObject input) throws Exception {
        String title = text(input, "title", "", 100);
        String style = text(input, "style", "", 4000);
        if (title.isBlank() || !input.has("slides") || !input.get("slides").isJsonArray()
                || input.getAsJsonArray("slides").isEmpty()) {
            throw new Problem(400, "请提供 title 和非空的 slides 数组。");
        }
        return db.transaction(() -> {
            long deck = db.insert("INSERT INTO decks(title,style) VALUES(?,?)", title, style);
            int position = 0;
            for (var entry : input.getAsJsonArray("slides")) {
                position++;
                if (!entry.isJsonObject()) {
                    throw new Problem(400, "第 " + position + " 页须为对象。");
                }
                var page = entry.getAsJsonObject();
                try {
                    String type = text(page, "page_type", "内容", 20);
                    if (!List.of("封面", "内容", "章节", "总结").contains(type)) {
                        throw new Problem(400, "page_type 无效。");
                    }
                    db.insert("""
                            INSERT INTO slides(deck_id,position,title,page_type,required_text,content,local_style)
                            VALUES(?,?,?,?,?,?,?)
                            """, deck, position, text(page, "title", "", 100), type,
                            text(page, "required_text", "", 4000), text(page, "content", "", 4000),
                            text(page, "local_style", "", 4000));
                } catch (Problem error) {
                    throw new Problem(400, "第 " + position + " 页 " + error.getMessage());
                }
            }
            return deck;
        });
    }

    private static String text(JsonObject object, String name, String fallback, int limit) {
        if (!object.has(name)) {
            return fallback;
        }
        var value = object.get(name);
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()
                || value.getAsString().length() > limit) {
            throw new Problem(400, name + " 须为不超过 " + limit + " 字符的文本。");
        }
        return value.getAsString().strip();
    }

    List<Long> generate(long slide, Long revision, Long parent, String instruction, int count) throws Exception {
        return db.transaction(() -> {
            var jobs = new ArrayList<Long>();
            for (int index = 0; index < count; index++) {
                jobs.add(studio.enqueue(slide, revision, parent, instruction));
            }
            return jobs;
        });
    }

    List<Long> generateDeck(long deck, int count) throws Exception {
        return db.transaction(() -> {
            db.one("SELECT id FROM decks WHERE id=? AND deleted_at IS NULL", deck);
            var pages = db.rows("SELECT id FROM slides WHERE deck_id=? AND deleted_at IS NULL ORDER BY position", deck);
            if (pages.isEmpty()) {
                throw new Problem(409, "请先添加页面。");
            }
            var jobs = new ArrayList<Long>();
            for (var page : pages) {
                jobs.addAll(generate(number(page, "id"), null, null, "", count));
            }
            return jobs;
        });
    }

    Map<String, Object> storage(long deck) throws Exception {
        return db.transaction(() -> {
            long imageBytes = 0;
            for (var asset : db.rows("""
                    SELECT DISTINCT a.id,a.storage_key FROM assets a JOIN image_nodes n ON n.asset_id=a.id
                    JOIN slides s ON s.id=n.slide_id WHERE s.deck_id=? AND n.cleared_at IS NULL
                    """, deck)) {
                var path = studio.assets.resolve((String) asset.get("storage_key"));
                if (Files.isRegularFile(path)) {
                    imageBytes += Files.size(path);
                }
            }
            long exportBytes = 0;
            for (var export : db.rows("SELECT id,format FROM exports WHERE deck_id=?", deck)) {
                var path = studio.exportFile(number(export, "id"), (String) export.get("format"));
                if (Files.isRegularFile(path)) {
                    exportBytes += Files.size(path);
                }
            }
            return Map.of("image_bytes", imageBytes, "export_bytes", exportBytes, "total_bytes", imageBytes + exportBytes);
        });
    }

    private List<Map<String, Object>> candidates(long deck) throws Exception {
        db.one("SELECT id FROM decks WHERE id=? AND deleted_at IS NULL", deck);
        if (db.rows("SELECT id FROM exports WHERE deck_id=? AND status='succeeded' LIMIT 1", deck).isEmpty()) {
            throw new Problem(409, "请先成功导出此项目。");
        }
        return db.rows("""
                SELECT DISTINCT a.* FROM assets a JOIN image_nodes n ON n.asset_id=a.id
                JOIN slides s ON s.id=n.slide_id
                WHERE s.deck_id=? AND a.purged_at IS NULL
                AND NOT EXISTS(SELECT 1 FROM library_items l WHERE l.asset_id=a.id AND l.deleted_at IS NULL)
                AND NOT EXISTS(SELECT 1 FROM image_nodes x JOIN export_items e ON e.node_id=x.id WHERE x.asset_id=a.id)
                AND NOT EXISTS(SELECT 1 FROM image_nodes x JOIN slides p ON p.id=x.slide_id
                    WHERE x.asset_id=a.id AND (p.deck_id<>? OR p.selected_node_id=x.id) AND x.cleared_at IS NULL)
                AND NOT EXISTS(SELECT 1 FROM image_nodes x JOIN generation_jobs j ON j.source_node_id=x.id
                    WHERE x.asset_id=a.id AND j.status IN ('queued','running'))
                ORDER BY a.id
                """, deck, deck);
    }

    Map<String, Object> previewCleanup(long deck) throws Exception {
        return db.transaction(() -> {
            var candidates = candidates(deck);
            long bytes = 0;
            for (var asset : candidates) {
                var path = studio.assets.resolve((String) asset.get("storage_key"));
                if (Files.isRegularFile(path)) {
                    bytes += Files.size(path);
                }
            }
            var ids = new ArrayList<Long>();
            for (var asset : candidates) {
                ids.add(number(asset, "id"));
            }
            String token = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(ids.toString().getBytes(StandardCharsets.UTF_8)));
            return Map.of("file_count", candidates.size(), "bytes", bytes, "token", token);
        });
    }

    Map<String, Object> cleanup(long deck, String token) throws Exception {
        var result = db.transaction(() -> {
            var preview = previewCleanup(deck);
            if (token != null && !token.equals(preview.get("token"))) {
                throw new Problem(409, "可清理图片已变化，请重新预览后确认。");
            }
            for (var asset : candidates(deck)) {
                db.execute("UPDATE image_nodes SET cleared_at=CURRENT_TIMESTAMP WHERE asset_id=?", asset.get("id"));
                db.execute("UPDATE assets SET purged_at=CURRENT_TIMESTAMP WHERE id=?", asset.get("id"));
            }
            return preview;
        });
        purgeFiles();
        return result;
    }

    // The committed marker is a durable deletion queue. Startup retries interrupted filesystem work.
    void purgeFiles() throws Exception {
        db.transaction(() -> {
            for (var asset : db.rows("SELECT storage_key FROM assets WHERE purged_at IS NOT NULL")) {
                Files.deleteIfExists(studio.assets.resolve((String) asset.get("storage_key")));
            }
            return null;
        });
    }
}

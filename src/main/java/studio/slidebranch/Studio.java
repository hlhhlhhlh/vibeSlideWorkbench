package studio.slidebranch;

import com.google.gson.Gson;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import static studio.slidebranch.Database.number;

final class Studio {
    private static final Gson JSON = new Gson();
    final Database db;
    final LocalSettings settings;
    volatile Images images;
    final Path assets;
    final Path exports;

    Studio(Database db, Path data) throws Exception {
        this.db = db;
        settings = new LocalSettings(data);
        images = settings.images();
        assets = Files.createDirectories(data.resolve("assets"));
        exports = Files.createDirectories(data.resolve("exports"));
        db.transaction(() -> {
            for (String table : List.of("generation_jobs", "exports")) {
                db.execute("UPDATE " + table + " SET status='failed', error_message=?, finished_at=CURRENT_TIMESTAMP "
                        + "WHERE status='running'", "服务曾中断，请重新提交。");
            }
            return null;
        });
    }

    // 首页的项目列表：页数、封面（第一页采用的图片）和最近修改时间
    List<Map<String, Object>> decks() throws SQLException {
        return db.rows("""
                SELECT d.id, d.title, d.created_at,
                    (SELECT COUNT(*) FROM slides s WHERE s.deck_id=d.id AND s.deleted_at IS NULL) AS slide_count,
                    (SELECT s.selected_node_id FROM slides s WHERE s.deck_id=d.id AND s.deleted_at IS NULL
                        ORDER BY s.position LIMIT 1) AS cover_node_id,
                    COALESCE((SELECT MAX(n.created_at) FROM image_nodes n JOIN slides s ON s.id=n.slide_id
                        WHERE s.deck_id=d.id), d.created_at) AS updated_at
                FROM decks d WHERE d.deleted_at IS NULL ORDER BY updated_at DESC, d.id DESC
                """);
    }

    void deleteDeck(long id) throws Exception {
        if (db.execute("UPDATE decks SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL", id) == 0) {
            throw new Problem(404, "演示稿不存在。");
        }
    }

    private void activeDeck(long id) throws SQLException {
        db.one("SELECT id FROM decks WHERE id=? AND deleted_at IS NULL", id);
    }

    Map<String, Object> deck(long id) throws Exception {
        return db.transaction(() -> Map.of(
                "deck", db.one("SELECT * FROM decks WHERE id=? AND deleted_at IS NULL", id),
                "slides", db.rows("""
                        SELECT s.*, s.requirements_revision AS board_id FROM slides s
                        WHERE deck_id=? AND deleted_at IS NULL ORDER BY position
                        """, id),
                "trash", db.rows("SELECT id,title FROM slides WHERE deck_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC,id DESC", id),
                "boards", db.rows("""
                        SELECT requirements_revision AS id, id AS slide_id, page_type, required_text,
                            content, local_style, 1 AS active
                        FROM slides WHERE deck_id=? AND deleted_at IS NULL ORDER BY position
                        """, id),
                "nodes", db.rows("""
                        SELECT n.*, n.job_id AS generation_job_id, j.source_node_id AS parent_id,
                            json_extract(COALESCE(j.requirements_snapshot_json, n.requirements_snapshot_json), '$.revision') AS board_id,
                            j.instruction, j.provider
                        FROM image_nodes n JOIN slides s ON s.id=n.slide_id
                        LEFT JOIN generation_jobs j ON j.id=n.job_id
                        WHERE s.deck_id=? AND s.deleted_at IS NULL ORDER BY n.id
                        """, id),
                "jobs", db.rows("""
                        SELECT j.*, j.source_node_id AS parent_node_id,
                            json_extract(j.requirements_snapshot_json, '$.revision') AS board_id
                        FROM generation_jobs j JOIN slides s ON s.id=j.slide_id
                        WHERE s.deck_id=? AND s.deleted_at IS NULL ORDER BY j.id DESC
                        """, id),
                "exports", db.rows("""
                        SELECT e.*, (SELECT COUNT(*) FROM export_items i WHERE i.export_id=e.id) AS slide_count
                        FROM exports e WHERE deck_id=? ORDER BY id DESC
                        """, id),
                "costs", costs(id)));
    }

    long addSlide(long deck, String title, Long after) throws Exception {
        return db.transaction(() -> {
            activeDeck(deck);
            long max = maxPosition(deck);
            long position = max + 1;
            if (after != null) {
                var anchor = activeSlide(after);
                if (number(anchor, "deck_id") != deck) {
                    throw new Problem(400, "插入位置不属于这套演示稿。");
                }
                position = number(anchor, "position") + 1;
                long offset = max + 1;
                db.execute("UPDATE slides SET position=position+? WHERE deck_id=? AND deleted_at IS NULL AND position>=?",
                        offset, deck, position);
                db.execute("UPDATE slides SET position=position-?+1 WHERE deck_id=? AND deleted_at IS NULL AND position>?",
                        offset, deck, max);
            }
            return db.insert("INSERT INTO slides(deck_id, position, title) VALUES(?,?,?)", deck, position, title);
        });
    }

    void move(long slide, String direction) throws Exception {
        if (!List.of("up", "down").contains(direction)) {
            throw new Problem(400, "移动方向无效。");
        }
        db.transaction(() -> {
            var current = activeSlide(slide);
            long deck = number(current, "deck_id");
            long position = number(current, "position");
            String order = "position < ? ORDER BY position DESC";
            if (direction.equals("down")) {
                order = "position > ? ORDER BY position ASC";
            }
            var neighbors = db.rows("SELECT id, position FROM slides WHERE deck_id=? AND deleted_at IS NULL AND "
                    + order + " LIMIT 1", deck, position);
            if (!neighbors.isEmpty()) {
                var neighbor = neighbors.getFirst();
                db.execute("UPDATE slides SET position=? WHERE id=?", maxPosition(deck) + 1, slide);
                db.execute("UPDATE slides SET position=? WHERE id=?", position, number(neighbor, "id"));
                db.execute("UPDATE slides SET position=? WHERE id=?", number(neighbor, "position"), slide);
            }
            return null;
        });
    }

    // 拖拽排序：把页面移到第 target 位（从 1 开始），其余页面依次顺延
    void moveTo(long slide, long target) throws Exception {
        db.transaction(() -> {
            long deck = number(activeSlide(slide), "deck_id");
            var ids = new java.util.ArrayList<Long>();
            for (var row : db.rows("SELECT id FROM slides WHERE deck_id=? AND deleted_at IS NULL ORDER BY position", deck)) {
                ids.add(number(row, "id"));
            }
            if (target < 1 || target > ids.size()) {
                throw new Problem(400, "目标位置无效。");
            }
            ids.remove(Long.valueOf(slide));
            ids.add((int) target - 1, slide);
            // 先整体挪到现有位置之后，避免与唯一索引冲突
            long offset = maxPosition(deck);
            db.execute("UPDATE slides SET position=position+? WHERE deck_id=? AND deleted_at IS NULL", offset, deck);
            for (int index = 0; index < ids.size(); index++) {
                db.execute("UPDATE slides SET position=? WHERE id=?", index + 1, ids.get(index));
            }
            return null;
        });
    }

    private long maxPosition(long deck) throws SQLException {
        return number(db.one("SELECT COALESCE(MAX(position), 0) AS last FROM slides WHERE deck_id=? "
                + "AND deleted_at IS NULL", deck), "last");
    }

    private Map<String, Object> activeSlide(long id) throws SQLException {
        return db.one("""
                SELECT s.* FROM slides s JOIN decks d ON d.id=s.deck_id
                WHERE s.id=? AND s.deleted_at IS NULL AND d.deleted_at IS NULL
                """, id);
    }

    void select(long slide, long node) throws Exception {
        db.transaction(() -> {
            activeSlide(slide);
            db.one("SELECT id FROM image_nodes WHERE id=? AND slide_id=?", node, slide);
            db.execute("UPDATE slides SET selected_node_id=? WHERE id=?", node, slide);
            return null;
        });
    }

    private Map<String, Object> requirements(long slide, Long expected) throws SQLException {
        var current = db.one("""
                SELECT s.*, d.style FROM slides s JOIN decks d ON d.id=s.deck_id
                WHERE s.id=? AND s.deleted_at IS NULL AND d.deleted_at IS NULL
                """, slide);
        if (expected != null && expected != number(current, "requirements_revision")) {
            throw new Problem(409, "页面要求已更新，请刷新后再试。");
        }
        return current;
    }

    long saveRequirements(long slide, Long expected, String type, String text, String content, String style) throws Exception {
        if (!List.of("封面", "内容", "章节", "总结").contains(type)) {
            throw new Problem(400, "页面类型无效。");
        }
        return db.transaction(() -> {
            var current = requirements(slide, expected);
            if (type.equals(current.get("page_type")) && text.equals(current.get("required_text"))
                    && content.equals(current.get("content")) && style.equals(current.get("local_style"))) {
                return number(current, "requirements_revision");
            }
            db.execute("""
                    UPDATE slides SET page_type=?, required_text=?, content=?, local_style=?,
                        requirements_revision=requirements_revision+1 WHERE id=?
                    """, type, text, content, style, slide);
            return number(current, "requirements_revision") + 1;
        });
    }

    void restore(long slide) throws Exception {
        db.transaction(() -> {
            var row = db.one("SELECT deck_id FROM slides WHERE id=? AND deleted_at IS NOT NULL", slide);
            activeDeck(number(row, "deck_id"));
            db.execute("UPDATE slides SET position=?, deleted_at=NULL WHERE id=?", maxPosition(number(row,"deck_id")) + 1, slide);
            return null;
        });
    }

    long upload(long slide, Long expected, byte[] bytes) throws Exception {
        Images.Asset file = Images.save(assets, bytes);
        return db.transaction(() -> {
            var current = requirements(slide, expected);
            return db.insert("INSERT INTO image_nodes(slide_id, asset_id, requirements_snapshot_json) VALUES(?,?,?)",
                    slide, saveAsset(file), snapshot(current));
        });
    }

    long enqueue(long slide, Long expected, Long parent, String instruction) throws Exception {
        return db.transaction(() -> {
            var current = requirements(slide, expected);
            String prompt = instruction;
            if (parent == null) {
                var lines = new java.util.ArrayList<String>();
                for (String field : List.of("required_text", "content", "style", "local_style")) {
                    String value = (String) current.get(field);
                    if (!value.isBlank()) {
                        String label = switch (field) {
                            case "required_text" -> "必须原样出现的文字";
                            case "content" -> "内容要求";
                            case "style" -> "项目风格";
                            default -> "本页风格";
                        };
                        lines.add(label + "：" + value);
                    }
                }
                if (!instruction.isBlank()) {
                    lines.add(instruction);
                }
                lines.add("页面类型：" + current.get("page_type"));
                prompt = String.join("\n", lines);
            } else {
                var source = db.one("""
                        SELECT COALESCE(j.requirements_snapshot_json, n.requirements_snapshot_json) AS snapshot
                        FROM image_nodes n LEFT JOIN generation_jobs j ON j.id=n.job_id
                        WHERE n.id=? AND n.slide_id=?
                        """, parent, slide);
                if (instruction.isBlank()) {
                    prompt = requirementChanges((String) source.get("snapshot"), current);
                    if (prompt.isEmpty()) {
                        throw new Problem(400, "请填写修改指令，或先修改页面要求。");
                    }
                }
            }
            return insertJob(slide, parent, null, snapshot(current), prompt);
        });
    }

    private static String snapshot(Map<String, Object> current) {
        var result = new LinkedHashMap<String, Object>();
        result.put("revision", current.get("requirements_revision"));
        for (String field : List.of("page_type", "required_text", "content", "local_style", "style")) {
            result.put(field, current.get(field));
        }
        return JSON.toJson(result);
    }

    private static String requirementChanges(String snapshot, Map<String, Object> current) {
        var source = JsonParser.parseString(snapshot).getAsJsonObject();
        var changes = new java.util.ArrayList<String>();
        for (String field : List.of("page_type", "required_text", "content", "local_style")) {
            String original = source.get(field).getAsString();
            if (original.equals(current.get(field))) {
                continue;
            }
            String label = switch (field) {
                case "page_type" -> "页面类型";
                case "required_text" -> "必须出现的文字";
                case "content" -> "内容要求";
                default -> "本页风格";
            };
            changes.add(label + "由「" + original + "」改为「" + current.get(field) + "」。");
        }
        return String.join("\n", changes);
    }

    private long saveAsset(Images.Asset file) throws SQLException {
        db.execute("""
                INSERT INTO assets(sha256, storage_key, mime_type, width, height, byte_size)
                VALUES(?,?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING
                """, file.hash(), file.key(), file.mime(), file.width(), file.height(), file.size());
        return number(db.one("SELECT id FROM assets WHERE sha256=?", file.hash()), "id");
    }

    List<Map<String, Object>> library(String query, String tag) throws SQLException {
        var values = new ArrayList<Object>();
        String filter = "";
        if (!query.isBlank()) {
            filter += " AND instr(lower(l.name), lower(?)) > 0";
            values.add(query);
        }
        if (!tag.isBlank()) {
            filter += " AND EXISTS (SELECT 1 FROM json_each(l.tags_json) WHERE value=?)";
            values.add(tag);
        }
        var rows = db.rows("""
                SELECT l.*, a.mime_type, a.width, a.height, a.byte_size,
                    (SELECT COUNT(*) FROM image_nodes n JOIN slides s ON s.id=n.slide_id
                        JOIN decks d ON d.id=s.deck_id WHERE n.library_item_id=l.id
                        AND s.deleted_at IS NULL AND d.deleted_at IS NULL) AS usage_count
                FROM library_items l JOIN assets a ON a.id=l.asset_id WHERE l.deleted_at IS NULL
                """ + filter + " ORDER BY l.id DESC", values.toArray());
        for (var row : rows) {
            addTags(row);
        }
        return rows;
    }

    Map<String, Object> libraryItem(long id) throws SQLException {
        var row = db.one("""
                SELECT l.*, a.mime_type, a.width, a.height, a.byte_size,
                    (SELECT COUNT(*) FROM image_nodes n JOIN slides s ON s.id=n.slide_id
                        JOIN decks d ON d.id=s.deck_id WHERE n.library_item_id=l.id
                        AND s.deleted_at IS NULL AND d.deleted_at IS NULL) AS usage_count
                FROM library_items l JOIN assets a ON a.id=l.asset_id
                WHERE l.id=? AND l.deleted_at IS NULL
                """, id);
        addTags(row);
        return row;
    }

    private static void addTags(Map<String, Object> row) {
        var tags = new ArrayList<String>();
        for (var tag : JsonParser.parseString((String) row.remove("tags_json")).getAsJsonArray()) {
            tags.add(tag.getAsString());
        }
        row.put("tags", tags);
    }

    long uploadLibrary(byte[] bytes, String name, List<String> tags) throws Exception {
        String title = libraryName(name);
        String serializedTags = libraryTags(tags);
        Images.Asset file = Images.save(assets, bytes);
        return db.transaction(() -> db.insert("INSERT INTO library_items(asset_id,name,tags_json) VALUES(?,?,?)",
                saveAsset(file), title, serializedTags));
    }

    void updateLibrary(long id, String name, List<String> tags) throws Exception {
        db.transaction(() -> {
            var previous = db.one("SELECT * FROM library_items WHERE id=? AND deleted_at IS NULL", id);
            String title = (String) previous.get("name");
            String serializedTags = (String) previous.get("tags_json");
            if (name != null) {
                title = libraryName(name);
            }
            if (tags != null) {
                serializedTags = libraryTags(tags);
            }
            db.execute("UPDATE library_items SET name=?, tags_json=? WHERE id=?", title, serializedTags, id);
            return null;
        });
    }

    void deleteLibrary(long id) throws SQLException {
        if (db.execute("UPDATE library_items SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL", id) == 0) {
            throw new Problem(404, "素材不存在。");
        }
    }

    Map<String, Object> libraryAsset(long id) throws SQLException {
        return db.one("""
                SELECT a.* FROM assets a JOIN library_items l ON l.asset_id=a.id
                WHERE l.id=? AND l.deleted_at IS NULL
                """, id);
    }

    long useLibrary(long slide, long item, Long expected) throws Exception {
        return db.transaction(() -> {
            var current = requirements(slide, expected);
            var material = db.one("SELECT asset_id FROM library_items WHERE id=? AND deleted_at IS NULL", item);
            return db.insert("""
                    INSERT INTO image_nodes(slide_id,asset_id,library_item_id,requirements_snapshot_json) VALUES(?,?,?,?)
                    """, slide, material.get("asset_id"), item, snapshot(current));
        });
    }

    private static String libraryName(String name) {
        String result = name.strip();
        if (result.isEmpty() || result.length() > 100) {
            throw new Problem(400, "素材名称须在 1 到 100 个字符之间。");
        }
        return result;
    }

    private static String libraryTags(List<String> tags) {
        if (tags.size() > 20) {
            throw new Problem(400, "每个素材最多设置 20 个标签。");
        }
        var result = new ArrayList<String>();
        for (String tag : tags) {
            String value = tag.strip();
            if (value.isEmpty() || value.length() > 40) {
                throw new Problem(400, "标签须在 1 到 40 个字符之间。");
            }
            if (!result.contains(value)) {
                result.add(value);
            }
        }
        return JSON.toJson(result);
    }

    long retry(long slide, Long jobId) throws Exception {
        return db.transaction(() -> {
            activeSlide(slide);
            var job = db.one("SELECT * FROM generation_jobs WHERE id=? AND slide_id=? AND status='failed'",
                    jobId, slide);
            return insertJob(slide, job.get("source_node_id"), jobId,
                    (String) job.get("requirements_snapshot_json"), (String) job.get("instruction"));
        });
    }

    private long insertJob(long slide, Object source, Long retryOf, String snapshot, String instruction) throws SQLException {
        Images configured = images;
        String provider = configured.provider();
        String model = configured.model();
        Integer price = unitPrice(provider, model);
        Integer cost = null;
        String billing = "pending";
        if (price == null) {
            billing = "unknown";
        } else if (price == 0) {
            billing = "estimated";
            cost = 0;
        }
        return db.insert("""
                INSERT INTO generation_jobs(slide_id, source_node_id, retry_of_job_id, requirements_snapshot_json,
                    instruction, provider, model, image_size, unit_price_cents, estimated_cost_cents, billing_status, status)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued')
                """, slide, source, retryOf, snapshot, instruction, provider, model, configured.size(), price, cost, billing);
    }

    private static Integer unitPrice(String provider, String model) {
        if (provider.equals("demo")) {
            return 0;
        }
        return switch (model) {
            case "gpt-image-2" -> 10;
            case "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
                    "gpt-image-2.6-flare", "gpt-image-2.6-sunburst" -> 20;
            default -> null;
        };
    }

    Map<String, Object> job(long id) throws SQLException {
        return db.one("SELECT * FROM generation_jobs WHERE id=?", id);
    }

    Map<String, Object> costs(long deck) throws SQLException {
        db.one("SELECT id FROM decks WHERE id=?", deck);
        return db.one("""
                SELECT 'USD' AS currency, COALESCE(SUM(j.estimated_cost_cents),0) AS estimated_cost_cents,
                    COUNT(*) AS job_count,
                    COUNT(CASE WHEN j.billing_status='pending' THEN 1 END) AS pending_job_count,
                    COUNT(CASE WHEN j.billing_status='unknown' THEN 1 END) AS unknown_job_count
                FROM generation_jobs j JOIN slides s ON s.id=j.slide_id WHERE s.deck_id=?
                """, deck);
    }

    private Map<String, Object> claim(String table) throws Exception {
        return db.transaction(() -> {
            var queued = db.rows("SELECT * FROM " + table + " WHERE status='queued' ORDER BY id LIMIT 1");
            if (queued.isEmpty()) {
                return null;
            }
            var row = queued.getFirst();
            String started = "";
            if (table.equals("generation_jobs")) {
                started = ", started_at=CURRENT_TIMESTAMP";
            }
            db.execute("UPDATE " + table + " SET status='running'" + started + " WHERE id=?", number(row, "id"));
            return row;
        });
    }

    void runGeneration() throws Exception {
        var job = claim("generation_jobs");
        if (job == null) {
            return;
        }
        long jobId = number(job, "id");
        long slide = number(job, "slide_id");
        Object parent = job.get("source_node_id");
        try {
            activeSlide(slide);
            Path input = null;
            if (parent != null) {
                input = assets.resolve((String) nodeAsset(((Number) parent).longValue()).get("storage_key"));
            }
            String size = (String) job.get("image_size");
            if (size == null) {
                // Historical queued tasks used the configured size at execution time.
                size = images.size();
            }
            var file = Images.save(assets, images.generate((String) job.get("provider"), (String) job.get("model"),
                    size, input, (String) job.get("instruction"), jobId,
                    task -> recordProviderTask(jobId, task)));
            db.transaction(() -> {
                // Keep completed results and their cost even if the page was deleted during the API call.
                db.insert("""
                        INSERT INTO image_nodes(slide_id,asset_id,job_id) VALUES(?,?,?)
                        """, slide, saveAsset(file), jobId);
                db.execute("""
                        UPDATE generation_jobs SET status='succeeded', finished_at=CURRENT_TIMESTAMP,
                            estimated_cost_cents=unit_price_cents,
                            billing_status=CASE WHEN unit_price_cents IS NULL THEN 'unknown' ELSE 'estimated' END
                        WHERE id=?
                        """, jobId);
                return null;
            });
        } catch (Exception failure) {
            fail("generation_jobs", jobId, failure);
        }
    }

    private void recordProviderTask(long jobId, String task) {
        try {
            db.execute("UPDATE generation_jobs SET provider_task_id=? WHERE id=?", task, jobId);
        } catch (SQLException failure) {
            throw new IllegalStateException("无法保存供应商任务号。", failure);
        }
    }

    Map<String, Object> nodeAsset(long node) throws SQLException {
        return db.one("SELECT a.* FROM assets a JOIN image_nodes n ON n.asset_id=a.id WHERE n.id=?", node);
    }

    long enqueueExport(long deck, String format) throws Exception {
        if (!List.of("pptx", "pdf").contains(format)) {
            throw new Problem(400, "请选择 PPTX 或 PDF。");
        }
        return db.transaction(() -> {
            activeDeck(deck);
            var slides = db.rows("SELECT selected_node_id FROM slides WHERE deck_id=? AND deleted_at IS NULL ORDER BY position", deck);
            if (slides.isEmpty() || slides.stream().anyMatch(slide -> slide.get("selected_node_id") == null)) {
                throw new Problem(409, "请先添加页面，并为每一页选用图片。");
            }
            long id = db.insert("INSERT INTO exports(deck_id, format, status) VALUES(?,?,'queued')", deck, format);
            int position = 1;
            for (var slide : slides) {
                db.execute("INSERT INTO export_items(export_id, position, node_id) VALUES(?,?,?)",
                        id, position, slide.get("selected_node_id"));
                position++;
            }
            return id;
        });
    }

    void runExport() throws Exception {
        var job = claim("exports");
        if (job == null) {
            return;
        }
        long id = number(job, "id");
        String format = (String) job.get("format");
        try {
            var rows = db.rows("""
                    SELECT a.* FROM export_items i JOIN image_nodes n ON i.node_id=n.id
                    JOIN assets a ON a.id=n.asset_id WHERE i.export_id=? ORDER BY i.position
                    """, id);
            ExportWriter.write(exportFile(id, format), format, assets, rows);
            db.execute("UPDATE exports SET status='succeeded', finished_at=CURRENT_TIMESTAMP WHERE id=?", id);
        } catch (Exception failure) {
            fail("exports", id, failure);
        }
    }

    Path exportFile(long id, String format) {
        return exports.resolve(id + "." + format);
    }

    private void fail(String table, long id, Exception failure) throws SQLException {
        String message = failure.getMessage();
        if (message == null || message.isBlank()) {
            message = failure.getClass().getSimpleName();
        }
        db.execute("UPDATE " + table + " SET status='failed', error_message=?, finished_at=CURRENT_TIMESTAMP WHERE id=?",
                message.substring(0, Math.min(400, message.length())), id);
    }
}

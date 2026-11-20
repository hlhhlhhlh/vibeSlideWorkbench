package studio.slidebranch;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import static studio.slidebranch.Database.number;

final class Studio {
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

    Map<String, Object> deck(long id) throws Exception {
        return db.transaction(() -> Map.of(
                "deck", db.one("SELECT * FROM decks WHERE id=?", id),
                "slides", db.rows("""
                        SELECT s.*, b.id AS board_id, b.page_type,b.required_text,b.content,b.local_style
                        FROM slides s JOIN boards b ON s.id=b.slide_id AND b.active=1
                        WHERE deck_id=? AND deleted_at IS NULL ORDER BY position
                        """, id),
                "trash", db.rows("SELECT id,title FROM slides WHERE deck_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC,id DESC", id),
                "boards", db.rows("""
                        SELECT b.* FROM boards b JOIN slides s ON s.id=b.slide_id
                        WHERE s.deck_id=? AND s.deleted_at IS NULL ORDER BY b.id
                        """, id),
                "nodes", db.rows("""
                        SELECT n.*, j.instruction, j.provider
                        FROM image_nodes n JOIN slides s ON s.id=n.slide_id
                        LEFT JOIN generation_jobs j ON j.id=n.generation_job_id
                        WHERE s.deck_id=? AND s.deleted_at IS NULL ORDER BY n.id
                        """, id),
                "jobs", db.rows("""
                        SELECT j.* FROM generation_jobs j JOIN slides s ON s.id=j.slide_id
                        WHERE s.deck_id=? AND s.deleted_at IS NULL ORDER BY j.id DESC
                        """, id),
                "exports", db.rows("""
                        SELECT e.*, (SELECT COUNT(*) FROM export_items i WHERE i.export_id=e.id) AS slide_count
                        FROM exports e WHERE deck_id=? ORDER BY id DESC
                        """, id)));
    }

    long addSlide(long deck, String title, Long after) throws Exception {
        return db.transaction(() -> {
            db.one("SELECT id FROM decks WHERE id=?", deck);
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

    private long maxPosition(long deck) throws SQLException {
        return number(db.one("SELECT COALESCE(MAX(position), 0) AS last FROM slides WHERE deck_id=? "
                + "AND deleted_at IS NULL", deck), "last");
    }

    private Map<String, Object> activeSlide(long id) throws SQLException {
        return db.one("SELECT * FROM slides WHERE id=? AND deleted_at IS NULL", id);
    }

    void select(long slide, long node) throws Exception {
        db.transaction(() -> {
            activeSlide(slide);
            db.one("SELECT id FROM image_nodes WHERE id=? AND slide_id=?", node, slide);
            db.execute("UPDATE slides SET selected_node_id=? WHERE id=?", node, slide);
            return null;
        });
    }

    private Map<String,Object> board(long slide, Long expected) throws SQLException {
        var current = db.one("SELECT b.*, d.style FROM boards b JOIN slides s ON b.slide_id=s.id JOIN decks d ON d.id=s.deck_id "
                + "WHERE b.slide_id=? AND b.active=1 AND s.deleted_at IS NULL", slide);
        if (expected != null && expected != number(current, "id")) {
            throw new Problem(409, "底板已更新，请刷新后再试。");
        }
        return current;
    }

    long saveBoard(long slide, Long expected, String type, String text, String content, String style) throws Exception {
        if (expected == null || !List.of("封面", "内容", "章节", "总结").contains(type)) {
            throw new Problem(400, "请指定当前底板和页面类型。");
        }
        return db.transaction(() -> {
            var current = board(slide, expected);
            if (type.equals(current.get("page_type")) && text.equals(current.get("required_text"))
                    && content.equals(current.get("content")) && style.equals(current.get("local_style"))) {
                return expected;
            }
            db.execute("UPDATE boards SET active=0 WHERE id=?", expected);
            return db.insert("INSERT INTO boards(slide_id,page_type,required_text,content,local_style) VALUES(?,?,?,?,?)",
                    slide, type, text, content, style);
        });
    }

    void restore(long slide) throws Exception {
        db.transaction(() -> {
            var row = db.one("SELECT deck_id FROM slides WHERE id=? AND deleted_at IS NOT NULL", slide);
            db.execute("UPDATE slides SET position=?, deleted_at=NULL WHERE id=?", maxPosition(number(row,"deck_id")) + 1, slide);
            return null;
        });
    }

    long upload(long slide, Long expected, byte[] bytes) throws Exception {
        Images.Asset file = Images.save(assets, bytes);
        return db.transaction(() -> {
            long boardId = number(board(slide,expected),"id");
            return db.insert("INSERT INTO image_nodes(slide_id, board_id, asset_id) VALUES(?,?,?)", slide, boardId, saveAsset(file));
        });
    }

    long enqueue(long slide, Long expected, Long parent, String instruction) throws Exception {
        return db.transaction(() -> {
            var current = board(slide,expected);
            long boardId = number(current,"id");
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
                        SELECT b.* FROM image_nodes n JOIN boards b ON b.id=n.board_id
                        WHERE n.id=? AND n.slide_id=?
                        """, parent, slide);
                if (instruction.isBlank()) {
                    prompt = requirementChanges(source, current);
                    if (prompt.isEmpty()) {
                        throw new Problem(400, "请填写修改指令，或先修改页面要求。");
                    }
                }
            }
            return db.insert("""
                    INSERT INTO generation_jobs(slide_id,board_id,parent_node_id,instruction,provider,model,status)
                    VALUES(?,?,?,?,?,?,'queued')
                    """, slide, boardId, parent, prompt, images.provider(), images.model());
        });
    }

    private static String requirementChanges(Map<String,Object> source, Map<String,Object> current) {
        var changes = new java.util.ArrayList<String>();
        for (String field : List.of("page_type", "required_text", "content", "local_style")) {
            if (source.get(field).equals(current.get(field))) {
                continue;
            }
            String label = switch (field) {
                case "page_type" -> "页面类型";
                case "required_text" -> "必须出现的文字";
                case "content" -> "内容要求";
                default -> "本页风格";
            };
            changes.add(label + "由「" + source.get(field) + "」改为「" + current.get(field) + "」。");
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

    long retry(long slide, Long jobId) throws Exception {
        return db.transaction(() -> {
            activeSlide(slide);
            var job = db.one("SELECT * FROM generation_jobs WHERE id=? AND slide_id=? AND status='failed'",
                    jobId, slide);
            return db.insert("""
                    INSERT INTO generation_jobs(slide_id,board_id,parent_node_id,instruction,provider,model,status)
                    VALUES(?,?,?,?,?,?,'queued')
                    """, slide, job.get("board_id"),job.get("parent_node_id"),job.get("instruction"),images.provider(),images.model());
        });
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
        Object parent = job.get("parent_node_id");
        try {
            activeSlide(slide);
            Path input = null;
            if (parent != null) {
                input = assets.resolve((String) nodeAsset(((Number) parent).longValue()).get("storage_key"));
            }
            var file = Images.save(assets, images.generate((String) job.get("provider"), (String) job.get("model"),
                    input, (String) job.get("instruction"), jobId));
            db.transaction(() -> {
                activeSlide(slide);
                db.insert("""
                        INSERT INTO image_nodes(slide_id,board_id,parent_id,asset_id,generation_job_id) VALUES(?,?,?,?,?)
                        """, slide, job.get("board_id"), parent, saveAsset(file), jobId);
                db.execute("UPDATE generation_jobs SET status='succeeded', finished_at=CURRENT_TIMESTAMP WHERE id=?", jobId);
                return null;
            });
        } catch (Exception failure) {
            fail("generation_jobs", jobId, failure);
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
            db.one("SELECT id FROM decks WHERE id=?", deck);
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

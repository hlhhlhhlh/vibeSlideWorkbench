ALTER TABLE decks ADD COLUMN style TEXT NOT NULL DEFAULT '';
--
CREATE TABLE boards (
    id INTEGER PRIMARY KEY,
    slide_id INTEGER NOT NULL REFERENCES slides(id),
    page_type TEXT NOT NULL DEFAULT '内容',
    required_text TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    local_style TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
--
CREATE UNIQUE INDEX current_board ON boards(slide_id) WHERE active=1;
--
INSERT INTO boards(id,slide_id,content)
SELECT s.id,s.id,COALESCE((SELECT j.instruction FROM image_nodes n JOIN generation_jobs j
ON j.id=n.generation_job_id WHERE n.slide_id=s.id AND n.parent_id IS NULL),'') FROM slides s;
--
CREATE TRIGGER slide_board AFTER INSERT ON slides BEGIN
    INSERT INTO boards(slide_id) VALUES(NEW.id);
END;
--
ALTER TABLE image_nodes ADD COLUMN board_id INTEGER REFERENCES boards(id);
--
ALTER TABLE generation_jobs ADD COLUMN board_id INTEGER REFERENCES boards(id);
--
DROP TRIGGER immutable_image_node;
--
UPDATE image_nodes SET board_id=slide_id;
--
UPDATE generation_jobs SET board_id=slide_id;
--
CREATE TRIGGER immutable_image_node BEFORE UPDATE ON image_nodes BEGIN
    SELECT RAISE(ABORT,'Image nodes are immutable');
END;
--
DROP INDEX one_image_root;
--
DROP INDEX active_root_job;
--
CREATE UNIQUE INDEX one_image_root ON image_nodes(board_id) WHERE parent_id IS NULL;
--
CREATE UNIQUE INDEX active_root_job ON generation_jobs(board_id)
WHERE parent_node_id IS NULL AND status IN ('queued','running');
--
CREATE TRIGGER job_board BEFORE INSERT ON generation_jobs
WHEN NOT EXISTS(SELECT 1 FROM boards WHERE id=NEW.board_id AND slide_id=NEW.slide_id AND active=1)
OR (NEW.parent_node_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM image_nodes
WHERE id=NEW.parent_node_id AND board_id=NEW.board_id))
BEGIN
    SELECT RAISE(ABORT,'Invalid generation board');
END;
--
CREATE TRIGGER node_board BEFORE INSERT ON image_nodes
WHEN NOT EXISTS(SELECT 1 FROM boards WHERE id=NEW.board_id AND slide_id=NEW.slide_id)
OR (NEW.generation_job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM generation_jobs
WHERE id=NEW.generation_job_id AND board_id=NEW.board_id))
BEGIN
    SELECT RAISE(ABORT,'Invalid image board');
END;
--
CREATE TRIGGER selected_board BEFORE UPDATE OF selected_node_id ON slides
WHEN NEW.selected_node_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM image_nodes n JOIN boards b ON b.id=n.board_id
WHERE n.id=NEW.selected_node_id AND b.slide_id=NEW.id AND b.active=1)
BEGIN
    SELECT RAISE(ABORT,'Selected image must belong to current board');
END;

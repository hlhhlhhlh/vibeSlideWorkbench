DROP TRIGGER slide_board;
--
DROP TRIGGER job_board;
--
DROP TRIGGER node_board;
--
DROP TRIGGER node_job_input;
--
DROP TRIGGER immutable_image_node;
--
DROP TRIGGER export_node_deck;
--
CREATE TABLE library_items (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
    tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
);
--
CREATE TABLE slides_new (
    id INTEGER PRIMARY KEY,
    deck_id INTEGER NOT NULL REFERENCES decks(id),
    position INTEGER NOT NULL CHECK (position > 0),
    title TEXT NOT NULL,
    selected_node_id INTEGER,
    deleted_at TEXT,
    page_type TEXT NOT NULL DEFAULT '内容',
    required_text TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    local_style TEXT NOT NULL DEFAULT '',
    requirements_revision INTEGER NOT NULL DEFAULT 1 CHECK (requirements_revision > 0),
    FOREIGN KEY (id, selected_node_id) REFERENCES image_nodes(slide_id, id)
);
--
INSERT INTO slides_new
SELECT s.id, s.deck_id, s.position, s.title, s.selected_node_id, s.deleted_at,
    COALESCE(b.page_type, '内容'), COALESCE(b.required_text, ''), COALESCE(b.content, ''),
    COALESCE(b.local_style, ''), COALESCE(b.id, 1)
FROM slides s LEFT JOIN boards b ON b.slide_id=s.id AND b.active=1;
--
CREATE TABLE generation_jobs_new (
    id INTEGER PRIMARY KEY,
    slide_id INTEGER NOT NULL REFERENCES slides(id),
    source_node_id INTEGER,
    retry_of_job_id INTEGER REFERENCES generation_jobs(id),
    requirements_snapshot_json TEXT NOT NULL CHECK (json_valid(requirements_snapshot_json)),
    instruction TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    image_size TEXT,
    provider_task_id TEXT,
    unit_price_cents INTEGER CHECK (unit_price_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    estimated_cost_cents INTEGER CHECK (estimated_cost_cents >= 0),
    billing_status TEXT NOT NULL DEFAULT 'unknown' CHECK (billing_status IN ('unknown', 'pending', 'estimated')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    finished_at TEXT,
    FOREIGN KEY (slide_id, source_node_id) REFERENCES image_nodes(slide_id, id)
);
--
INSERT INTO generation_jobs_new (
    id, slide_id, source_node_id, requirements_snapshot_json, instruction, provider, model,
    unit_price_cents, estimated_cost_cents, billing_status, status, error_message, created_at, started_at, finished_at
)
SELECT j.id, j.slide_id, j.parent_node_id,
    json_object('revision', j.board_id, 'page_type', COALESCE(b.page_type, '内容'),
        'required_text', COALESCE(b.required_text, ''), 'content', COALESCE(b.content, ''),
        'local_style', COALESCE(b.local_style, ''), 'style', NULL),
    j.instruction, j.provider, j.model,
    CASE WHEN j.provider='demo' THEN 0 ELSE NULL END,
    CASE WHEN j.provider='demo' THEN 0 ELSE NULL END,
    CASE WHEN j.provider='demo' THEN 'estimated' ELSE 'unknown' END,
    j.status, j.error_message, j.created_at, j.started_at, j.finished_at
FROM generation_jobs j LEFT JOIN boards b ON b.id=j.board_id;
--
CREATE TABLE image_nodes_new (
    id INTEGER PRIMARY KEY,
    slide_id INTEGER NOT NULL REFERENCES slides(id),
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    job_id INTEGER UNIQUE REFERENCES generation_jobs(id),
    library_item_id INTEGER REFERENCES library_items(id),
    requirements_snapshot_json TEXT CHECK (requirements_snapshot_json IS NULL OR json_valid(requirements_snapshot_json)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (slide_id, id),
    CHECK (job_id IS NOT NULL OR requirements_snapshot_json IS NOT NULL),
    CHECK (job_id IS NULL OR library_item_id IS NULL)
);
--
INSERT INTO image_nodes_new (id, slide_id, asset_id, job_id, requirements_snapshot_json, created_at)
SELECT n.id, n.slide_id, n.asset_id, n.generation_job_id,
    CASE WHEN n.generation_job_id IS NULL THEN
        json_object('revision', n.board_id, 'page_type', COALESCE(b.page_type, '内容'),
            'required_text', COALESCE(b.required_text, ''), 'content', COALESCE(b.content, ''),
            'local_style', COALESCE(b.local_style, ''), 'style', NULL)
    ELSE NULL END,
    n.created_at
FROM image_nodes n LEFT JOIN boards b ON b.id=n.board_id;
--
DROP TABLE image_nodes;
--
DROP TABLE generation_jobs;
--
DROP TABLE boards;
--
DROP TABLE slides;
--
ALTER TABLE slides_new RENAME TO slides;
--
ALTER TABLE generation_jobs_new RENAME TO generation_jobs;
--
ALTER TABLE image_nodes_new RENAME TO image_nodes;
--
CREATE UNIQUE INDEX active_slide_position ON slides(deck_id, position) WHERE deleted_at IS NULL;
--
CREATE INDEX jobs_by_slide ON generation_jobs(slide_id, id);
--
CREATE INDEX nodes_by_library_item ON image_nodes(library_item_id, slide_id);
--
CREATE INDEX nodes_by_slide ON image_nodes(slide_id, id);
--
CREATE TRIGGER node_job_input BEFORE INSERT ON image_nodes
WHEN NEW.job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM generation_jobs
    WHERE id=NEW.job_id AND slide_id=NEW.slide_id AND status='running'
)
BEGIN
    SELECT RAISE(ABORT, 'Result node does not match its running job');
END;
--
CREATE TRIGGER node_library_asset BEFORE INSERT ON image_nodes
WHEN NEW.library_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM library_items WHERE id=NEW.library_item_id AND asset_id=NEW.asset_id AND deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'Library image must use the original asset');
END;
--
CREATE TRIGGER immutable_image_node BEFORE UPDATE ON image_nodes
BEGIN
    SELECT RAISE(ABORT, 'Image nodes are immutable');
END;
--
CREATE TRIGGER immutable_job_input BEFORE UPDATE OF
    slide_id, source_node_id, retry_of_job_id, requirements_snapshot_json, instruction,
    provider, model, image_size, unit_price_cents, currency ON generation_jobs
BEGIN
    SELECT RAISE(ABORT, 'Job inputs are immutable');
END;
--
CREATE TRIGGER successful_job_result BEFORE UPDATE OF status ON generation_jobs
WHEN NEW.status='succeeded' AND NOT EXISTS (SELECT 1 FROM image_nodes WHERE job_id=NEW.id)
BEGIN
    SELECT RAISE(ABORT, 'Successful jobs require a result image');
END;
--
CREATE TRIGGER immutable_library_asset BEFORE UPDATE OF asset_id ON library_items
BEGIN
    SELECT RAISE(ABORT, 'Library assets are immutable');
END;
--
CREATE TRIGGER export_node_deck BEFORE INSERT ON export_items
WHEN NOT EXISTS (
    SELECT 1 FROM image_nodes
    JOIN slides ON slides.id=image_nodes.slide_id
    JOIN exports ON exports.deck_id=slides.deck_id
    WHERE image_nodes.id=NEW.node_id AND exports.id=NEW.export_id
)
BEGIN
    SELECT RAISE(ABORT, 'Export node does not belong to deck');
END;

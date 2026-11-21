CREATE TABLE IF NOT EXISTS decks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--
CREATE TABLE IF NOT EXISTS slides (
    id INTEGER PRIMARY KEY,
    deck_id INTEGER NOT NULL REFERENCES decks(id),
    position INTEGER NOT NULL CHECK (position > 0),
    title TEXT NOT NULL,
    selected_node_id INTEGER,
    deleted_at TEXT,
    FOREIGN KEY (id, selected_node_id) REFERENCES image_nodes(slide_id, id)
);
--
CREATE UNIQUE INDEX IF NOT EXISTS active_slide_position
    ON slides (deck_id, position) WHERE deleted_at IS NULL;
--
CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    storage_key TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    byte_size INTEGER NOT NULL
);
--
CREATE TABLE IF NOT EXISTS generation_jobs (
    id INTEGER PRIMARY KEY,
    slide_id INTEGER NOT NULL REFERENCES slides(id),
    parent_node_id INTEGER,
    instruction TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    finished_at TEXT,
    FOREIGN KEY (slide_id, parent_node_id) REFERENCES image_nodes(slide_id, id)
);
--
CREATE INDEX IF NOT EXISTS jobs_by_slide ON generation_jobs (slide_id, id);
--
CREATE UNIQUE INDEX IF NOT EXISTS active_root_job ON generation_jobs (slide_id)
    WHERE parent_node_id IS NULL AND status IN ('queued', 'running');
--
CREATE TABLE IF NOT EXISTS image_nodes (
    id INTEGER PRIMARY KEY,
    slide_id INTEGER NOT NULL REFERENCES slides(id),
    parent_id INTEGER,
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    generation_job_id INTEGER REFERENCES generation_jobs(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (slide_id, id),
    CHECK (parent_id IS NULL OR (parent_id < id AND generation_job_id IS NOT NULL)),
    FOREIGN KEY (slide_id, parent_id) REFERENCES image_nodes(slide_id, id)
);
--
CREATE UNIQUE INDEX IF NOT EXISTS one_image_root ON image_nodes (slide_id)
    WHERE parent_id IS NULL;
--
CREATE TRIGGER IF NOT EXISTS node_job_input BEFORE INSERT ON image_nodes
WHEN NEW.generation_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM generation_jobs
    WHERE id = NEW.generation_job_id AND slide_id = NEW.slide_id
      AND parent_node_id IS NEW.parent_id AND status = 'running'
)
BEGIN
    SELECT RAISE(ABORT, 'Result node does not match its running job');
END;
--
CREATE TRIGGER IF NOT EXISTS immutable_image_node BEFORE UPDATE ON image_nodes
BEGIN
    SELECT RAISE(ABORT, 'Image nodes are immutable');
END;
--
CREATE TABLE IF NOT EXISTS exports (
    id INTEGER PRIMARY KEY,
    deck_id INTEGER NOT NULL REFERENCES decks(id),
    format TEXT NOT NULL CHECK (format IN ('pptx', 'pdf')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT
);
--
CREATE INDEX IF NOT EXISTS exports_by_deck ON exports (deck_id, id);
--
CREATE TABLE IF NOT EXISTS export_items (
    export_id INTEGER NOT NULL REFERENCES exports(id),
    position INTEGER NOT NULL,
    node_id INTEGER NOT NULL REFERENCES image_nodes(id),
    PRIMARY KEY (export_id, position)
);
--
CREATE TRIGGER IF NOT EXISTS export_node_deck BEFORE INSERT ON export_items
WHEN NOT EXISTS (
    SELECT 1 FROM image_nodes
    JOIN slides ON slides.id = image_nodes.slide_id
    JOIN exports ON exports.deck_id = slides.deck_id
    WHERE image_nodes.id = NEW.node_id AND exports.id = NEW.export_id
)
BEGIN
    SELECT RAISE(ABORT, 'Export node does not belong to deck');
END;

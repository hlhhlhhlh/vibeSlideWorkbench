ALTER TABLE assets ADD COLUMN purged_at TEXT;
--
ALTER TABLE image_nodes ADD COLUMN cleared_at TEXT;
--
DROP TRIGGER immutable_image_node;
--
CREATE TRIGGER immutable_image_node BEFORE UPDATE OF
    id,slide_id,asset_id,job_id,library_item_id,requirements_snapshot_json,created_at ON image_nodes
BEGIN
    SELECT RAISE(ABORT, 'Image node history is immutable');
END;

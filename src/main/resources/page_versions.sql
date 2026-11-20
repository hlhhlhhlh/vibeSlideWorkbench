DROP INDEX one_image_root;
--
DROP INDEX active_root_job;
--
DROP TRIGGER selected_board;
--
DROP TRIGGER job_board;
--
CREATE TRIGGER job_board BEFORE INSERT ON generation_jobs
WHEN NOT EXISTS (SELECT 1 FROM boards WHERE id=NEW.board_id AND slide_id=NEW.slide_id)
BEGIN
    SELECT RAISE(ABORT, 'Job requirements must belong to the same slide');
END;

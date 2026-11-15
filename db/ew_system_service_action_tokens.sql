-- ── ew_system: one-time service action tokens ─────────────────────────────────
-- Owned by ew-account-service-api (it owns the ew_system schema for now, Pre-Launch Security
-- Design §4.2). Replaces, for the actions listed in the mint routine, the ew_index
-- service_action_tokens / mint_service_action_token pair. Access is through the two
-- SQL SECURITY DEFINER routines only: no component gets table privileges.
--
--   sp_mint_service_action_token(action, subject_user_id, acting_user_id)
--       → one row { token_id } (valid 30 s). Called by the component that authorises the action.
--   sp_consume_service_action_token(token_id)
--       → one row { found, action, subject_user_id, acting_user_id }. found = 1 when the token
--         existed and hadn't expired; it is deleted either way (one-time). The consumer checks
--         action and subject_user_id against the request.
--
-- Run as a DB admin (the routines run with the creator's rights), once per environment:
--   dev:        USE dev_ew_system;   production: USE ew_system;
-- Names below are unqualified on purpose: they resolve to the current database, and inside the
-- routines to the routine's own database.

CREATE DATABASE IF NOT EXISTS ew_system;   -- dev: CREATE DATABASE IF NOT EXISTS dev_ew_system;
-- USE ew_system;                           -- dev: USE dev_ew_system;

CREATE TABLE IF NOT EXISTS service_action_tokens (
  token_id        CHAR(36)     NOT NULL PRIMARY KEY,   -- random v4 UUID (RANDOM_BYTES)
  action          VARCHAR(64)  NOT NULL,               -- see the allowed list in the mint routine
  subject_user_id CHAR(36)     NOT NULL,               -- user being acted on (BMS Users.UserId)
  acting_user_id  CHAR(36)     NOT NULL,               -- user/system making the call
  created_at      DATETIME     NOT NULL,               -- UTC
  expires_at      DATETIME     NOT NULL,               -- UTC, created_at + 30 s
  KEY ix_service_action_tokens_expires (expires_at)
) ENGINE=InnoDB;

DROP PROCEDURE IF EXISTS sp_mint_service_action_token;
DROP PROCEDURE IF EXISTS sp_consume_service_action_token;

DELIMITER $$

-- Purge expired tokens, then create one that lives 30 seconds. Result set: one row { token_id }.
CREATE PROCEDURE sp_mint_service_action_token(
  IN p_action          VARCHAR(64),
  IN p_subject_user_id CHAR(36),
  IN p_acting_user_id  CHAR(36)
)
  MODIFIES SQL DATA
  SQL SECURITY DEFINER
  COMMENT 'Mint a one-time service action token (30 s)'
BEGIN
  DECLARE v_b VARBINARY(16);
  DECLARE v_hex CHAR(32);
  DECLARE v_token CHAR(36);

  -- system:set-password = forgot-password reset (account service POST /users/:userId/password/reset);
  -- the caller mints it with subject = acting = the user's id.
  IF p_action IS NULL OR p_action NOT IN ('system:set-password') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INVALID_ACTION';
  END IF;
  IF p_subject_user_id IS NULL OR p_acting_user_id IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'VALIDATION_ERROR';
  END IF;

  -- Random version-4 UUID (version nibble 4, variant bits 10)
  SET v_b = RANDOM_BYTES(16);
  SET v_b = CONCAT(SUBSTRING(v_b, 1, 6),
                   UNHEX(LPAD(HEX((ORD(SUBSTRING(v_b, 7, 1)) & 0x0F) | 0x40), 2, '0')),
                   SUBSTRING(v_b, 8, 1),
                   UNHEX(LPAD(HEX((ORD(SUBSTRING(v_b, 9, 1)) & 0x3F) | 0x80), 2, '0')),
                   SUBSTRING(v_b, 10, 7));
  SET v_hex = LOWER(HEX(v_b));
  SET v_token = CONCAT_WS('-', SUBSTRING(v_hex, 1, 8), SUBSTRING(v_hex, 9, 4), SUBSTRING(v_hex, 13, 4),
                               SUBSTRING(v_hex, 17, 4), SUBSTRING(v_hex, 21, 12));

  START TRANSACTION;
  DELETE FROM service_action_tokens WHERE expires_at <= UTC_TIMESTAMP();
  INSERT INTO service_action_tokens
    (token_id, action, subject_user_id, acting_user_id, created_at, expires_at)
  VALUES
    (v_token, p_action, LOWER(p_subject_user_id), LOWER(p_acting_user_id),
     UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 30 SECOND);
  COMMIT;

  SELECT v_token AS token_id;
END$$

-- Look up and delete a token in one transaction. Result set: one row
-- { found (0/1), action, subject_user_id, acting_user_id } (the last three NULL when not found).
CREATE PROCEDURE sp_consume_service_action_token(
  IN p_token_id CHAR(36)
)
  MODIFIES SQL DATA
  SQL SECURITY DEFINER
  COMMENT 'Consume (delete) a one-time service action token'
BEGIN
  DECLARE v_action  VARCHAR(64) DEFAULT NULL;
  DECLARE v_subject CHAR(36)    DEFAULT NULL;
  DECLARE v_acting  CHAR(36)    DEFAULT NULL;
  DECLARE v_expires DATETIME    DEFAULT NULL;

  START TRANSACTION;
  SELECT action, subject_user_id, acting_user_id, expires_at
    INTO v_action, v_subject, v_acting, v_expires
    FROM service_action_tokens
   WHERE token_id = LOWER(p_token_id)
   FOR UPDATE;
  DELETE FROM service_action_tokens WHERE token_id = LOWER(p_token_id);
  COMMIT;

  IF v_expires IS NULL OR v_expires <= UTC_TIMESTAMP() THEN
    SELECT 0 AS found, NULL AS action, NULL AS subject_user_id, NULL AS acting_user_id;
  ELSE
    SELECT 1 AS found, v_action AS action, v_subject AS subject_user_id, v_acting AS acting_user_id;
  END IF;
END$$

DELIMITER ;

-- ── Grants (EXECUTE only) ────────────────────────────────────────────────────
-- Account service (consumes system:set-password):
GRANT EXECUTE ON PROCEDURE ew_system.sp_consume_service_action_token TO 'account_service_api'@'172.31.%';
-- dev: the shared devopensim user already has access to dev_ew_system.
-- Minting components (their own chats own these lines; listed for completeness):
--   ew-portal-api (forgot-password): GRANT EXECUTE ON PROCEDURE ew_system.sp_mint_service_action_token TO '<portal api user>'@'172.31.%';

-- ── Check ────────────────────────────────────────────────────────────────────
-- CALL sp_mint_service_action_token('system:set-password', '<userId>', '<userId>');
-- CALL sp_consume_service_action_token('<token_id>');   -- found = 1, then found = 0 on a second call

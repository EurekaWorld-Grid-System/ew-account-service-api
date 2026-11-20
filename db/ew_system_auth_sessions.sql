-- ── ew_system: login sessions (server-side refresh-token revocation) ──────────
-- Owned by ew-account-service-api (it owns the ew_system schema for now). One row per login.
-- The refresh token carries { sid, jti }: sid = session_id, jti = the session's current
-- refresh_jti. Every refresh rotates refresh_jti; presenting an older jti (outside the short
-- grace window that covers parallel refreshes from several tabs) means the token was copied,
-- so the whole session is revoked. Access tokens carry sid, so POST /auth/verify can reject them
-- as soon as their session is revoked.
--
-- Access is through the SQL SECURITY DEFINER routines only: no component gets table privileges.
--
--   sp_create_auth_session(session_id, user_id, refresh_jti, ttl_seconds, client_ip)
--       → nothing. Login. Also purges sessions that expired more than 7 days ago.
--   sp_rotate_auth_session(session_id, presented_jti, new_jti, ttl_seconds, grace_seconds)
--       → one row { result, user_id, refresh_jti }. result:
--           OK         presented_jti was current: rotated to new_jti, expiry slides by ttl_seconds
--           GRACE      presented_jti is the previous one and the rotation happened less than
--                      grace_seconds ago (another tab refreshed first): nothing changes,
--                      refresh_jti = the current jti to sign into the new token
--           REUSED     any other older jti: the session is revoked ('reuse')
--           REVOKED / EXPIRED / NOT_FOUND
--   sp_check_auth_session(session_id)
--       → one row { active (0/1), user_id }. POST /auth/verify.
--   sp_revoke_auth_session(session_id, reason)
--       → one row { revoked } (0/1). Logout.
--   sp_revoke_user_auth_sessions(user_id, reason)
--       → one row { revoked } (count). Every session of a user: password change and forgot-password
--         reset with { revokeAllSessions: true }, logout with { allSessions: true }.
--
-- Run as a DB admin (the routines run with the creator's rights), once per environment:
--   dev:        USE dev_ew_system;   production: USE ew_system;
-- Names below are unqualified on purpose: they resolve to the current database.

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id        CHAR(36)     NOT NULL PRIMARY KEY,  -- random v4 UUID (account service)
  user_id           CHAR(36)     NOT NULL,              -- BMS Users.UserId
  refresh_jti       CHAR(36)     NOT NULL,              -- current refresh token id
  previous_jti      CHAR(36)     NULL,                  -- the one before (grace window only)
  created_at        DATETIME     NOT NULL,              -- UTC, login
  last_refreshed_at DATETIME     NULL,                  -- UTC, last rotation
  expires_at        DATETIME     NOT NULL,              -- UTC, slides on every refresh
  revoked_at        DATETIME     NULL,                  -- UTC
  revoked_reason    VARCHAR(32)  NULL,                  -- logout | reuse | user-not-found | <caller's reason>
  client_ip         VARCHAR(45)  NULL,                  -- IP seen at login
  KEY ix_auth_sessions_user (user_id),
  KEY ix_auth_sessions_expires (expires_at)
) ENGINE=InnoDB;

DROP PROCEDURE IF EXISTS sp_create_auth_session;
DROP PROCEDURE IF EXISTS sp_rotate_auth_session;
DROP PROCEDURE IF EXISTS sp_check_auth_session;
DROP PROCEDURE IF EXISTS sp_revoke_auth_session;
DROP PROCEDURE IF EXISTS sp_revoke_user_auth_sessions;

DELIMITER $$

CREATE PROCEDURE sp_create_auth_session(
  IN p_session_id  CHAR(36),
  IN p_user_id     CHAR(36),
  IN p_refresh_jti CHAR(36),
  IN p_ttl_seconds INT,
  IN p_client_ip   VARCHAR(45)
)
  MODIFIES SQL DATA
  SQL SECURITY DEFINER
  COMMENT 'Create a login session'
BEGIN
  IF p_session_id IS NULL OR p_user_id IS NULL OR p_refresh_jti IS NULL
     OR p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'VALIDATION_ERROR';
  END IF;

  START TRANSACTION;
  -- Expired sessions are kept 7 days (audit, reuse logging), then purged
  DELETE FROM auth_sessions WHERE expires_at <= UTC_TIMESTAMP() - INTERVAL 7 DAY;
  INSERT INTO auth_sessions
    (session_id, user_id, refresh_jti, created_at, expires_at, client_ip)
  VALUES
    (LOWER(p_session_id), LOWER(p_user_id), LOWER(p_refresh_jti), UTC_TIMESTAMP(),
     UTC_TIMESTAMP() + INTERVAL p_ttl_seconds SECOND, p_client_ip);
  COMMIT;
END$$

CREATE PROCEDURE sp_rotate_auth_session(
  IN p_session_id    CHAR(36),
  IN p_presented_jti CHAR(36),
  IN p_new_jti       CHAR(36),
  IN p_ttl_seconds   INT,
  IN p_grace_seconds INT
)
  MODIFIES SQL DATA
  SQL SECURITY DEFINER
  COMMENT 'Rotate a session refresh token (with reuse detection)'
BEGIN
  DECLARE v_found    TINYINT     DEFAULT 0;
  DECLARE v_user     CHAR(36)    DEFAULT NULL;
  DECLARE v_current  CHAR(36)    DEFAULT NULL;
  DECLARE v_previous CHAR(36)    DEFAULT NULL;
  DECLARE v_rotated  DATETIME    DEFAULT NULL;
  DECLARE v_expires  DATETIME    DEFAULT NULL;
  DECLARE v_revoked  DATETIME    DEFAULT NULL;
  DECLARE v_result   VARCHAR(16) DEFAULT 'NOT_FOUND';
  DECLARE v_jti      CHAR(36)    DEFAULT NULL;

  IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 OR p_new_jti IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'VALIDATION_ERROR';
  END IF;

  START TRANSACTION;
  -- Row lock: parallel refreshes of one session run one after the other
  SELECT 1, user_id, refresh_jti, previous_jti, last_refreshed_at, expires_at, revoked_at
    INTO v_found, v_user, v_current, v_previous, v_rotated, v_expires, v_revoked
    FROM auth_sessions
   WHERE session_id = LOWER(p_session_id)
   FOR UPDATE;

  IF v_found = 0 THEN
    SET v_result = 'NOT_FOUND';
  ELSEIF v_revoked IS NOT NULL THEN
    SET v_result = 'REVOKED';
  ELSEIF v_expires <= UTC_TIMESTAMP() THEN
    SET v_result = 'EXPIRED';
  ELSEIF v_current = LOWER(p_presented_jti) THEN
    UPDATE auth_sessions
       SET previous_jti = refresh_jti,
           refresh_jti = LOWER(p_new_jti),
           last_refreshed_at = UTC_TIMESTAMP(),
           expires_at = UTC_TIMESTAMP() + INTERVAL p_ttl_seconds SECOND
     WHERE session_id = LOWER(p_session_id);
    SET v_result = 'OK', v_jti = LOWER(p_new_jti);
  ELSEIF v_previous = LOWER(p_presented_jti)
         AND v_rotated > UTC_TIMESTAMP() - INTERVAL GREATEST(IFNULL(p_grace_seconds, 0), 0) SECOND THEN
    SET v_result = 'GRACE', v_jti = v_current;
  ELSE
    UPDATE auth_sessions
       SET revoked_at = UTC_TIMESTAMP(), revoked_reason = 'reuse'
     WHERE session_id = LOWER(p_session_id);
    SET v_result = 'REUSED';
  END IF;
  COMMIT;

  SELECT v_result AS result, v_user AS user_id, v_jti AS refresh_jti;
END$$

CREATE PROCEDURE sp_check_auth_session(
  IN p_session_id CHAR(36)
)
  READS SQL DATA
  SQL SECURITY DEFINER
  COMMENT 'Is a session active (not revoked, not expired)'
BEGIN
  DECLARE v_user CHAR(36) DEFAULT NULL;

  SELECT user_id INTO v_user
    FROM auth_sessions
   WHERE session_id = LOWER(p_session_id)
     AND revoked_at IS NULL
     AND expires_at > UTC_TIMESTAMP();

  SELECT IF(v_user IS NULL, 0, 1) AS active, v_user AS user_id;
END$$

CREATE PROCEDURE sp_revoke_auth_session(
  IN p_session_id CHAR(36),
  IN p_reason     VARCHAR(32)
)
  MODIFIES SQL DATA
  SQL SECURITY DEFINER
  COMMENT 'Revoke one session'
BEGIN
  UPDATE auth_sessions
     SET revoked_at = UTC_TIMESTAMP(), revoked_reason = LEFT(IFNULL(p_reason, 'revoked'), 32)
   WHERE session_id = LOWER(p_session_id)
     AND revoked_at IS NULL;
  SELECT ROW_COUNT() AS revoked;
END$$

CREATE PROCEDURE sp_revoke_user_auth_sessions(
  IN p_user_id CHAR(36),
  IN p_reason  VARCHAR(32)
)
  MODIFIES SQL DATA
  SQL SECURITY DEFINER
  COMMENT 'Revoke every active session of a user'
BEGIN
  UPDATE auth_sessions
     SET revoked_at = UTC_TIMESTAMP(), revoked_reason = LEFT(IFNULL(p_reason, 'revoked'), 32)
   WHERE user_id = LOWER(p_user_id)
     AND revoked_at IS NULL
     AND expires_at > UTC_TIMESTAMP();
  SELECT ROW_COUNT() AS revoked;
END$$

DELIMITER ;

-- ── Grants (EXECUTE only) ────────────────────────────────────────────────────
GRANT EXECUTE ON PROCEDURE ew_system.sp_create_auth_session       TO 'account_service_api'@'172.31.%';
GRANT EXECUTE ON PROCEDURE ew_system.sp_rotate_auth_session       TO 'account_service_api'@'172.31.%';
GRANT EXECUTE ON PROCEDURE ew_system.sp_check_auth_session        TO 'account_service_api'@'172.31.%';
GRANT EXECUTE ON PROCEDURE ew_system.sp_revoke_auth_session       TO 'account_service_api'@'172.31.%';
GRANT EXECUTE ON PROCEDURE ew_system.sp_revoke_user_auth_sessions TO 'account_service_api'@'172.31.%';
-- dev: the shared devopensim user already has access to dev_ew_system.

-- ── Check ────────────────────────────────────────────────────────────────────
-- After a login through the account service:
-- SELECT session_id, user_id, created_at, expires_at, revoked_at, revoked_reason
--   FROM auth_sessions ORDER BY created_at DESC LIMIT 5;
-- CALL sp_check_auth_session('<session_id>');        -- active = 1
-- CALL sp_revoke_auth_session('<session_id>', 'test'); -- revoked = 1, then active = 0

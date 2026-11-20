-- ── ew_system: admin and system admin lists ───────────────────────────────────
-- Owned by ew-account-service-api (it owns the ew_system schema for now). Two lists of
-- ew_index.account_index ids, maintained by hand for now (Asaff, 2026-11-21):
--   admin_index         accounts that are admins
--   system_admin_index  accounts that are system admins
-- The lists are independent: a system admin is not automatically in admin_index.
--
-- Read through the SQL SECURITY DEFINER routines only (no component gets table privileges):
--   sp_is_admin(account_id)         → one row { is_admin (0/1) }
--   sp_is_system_admin(account_id)  → one row { is_system_admin (0/1) }
--
-- Run as a DB admin (the routines run with the creator's rights), once per environment:
--   dev:        USE dev_ew_system;   production: USE ew_system;
-- Names below are unqualified on purpose: they resolve to the current database.

CREATE TABLE IF NOT EXISTS admin_index (
  account_id  CHAR(36)  NOT NULL PRIMARY KEY,                 -- ew_index.account_index.id
  created_at  DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP     -- UTC (Aurora time_zone)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS system_admin_index (
  account_id  CHAR(36)  NOT NULL PRIMARY KEY,                 -- ew_index.account_index.id
  created_at  DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP     -- UTC (Aurora time_zone)
) ENGINE=InnoDB;

DROP PROCEDURE IF EXISTS sp_is_admin;
DROP PROCEDURE IF EXISTS sp_is_system_admin;

DELIMITER $$

CREATE PROCEDURE sp_is_admin(
  IN p_account_id CHAR(36)
)
  READS SQL DATA
  SQL SECURITY DEFINER
  COMMENT 'Is the account in admin_index'
BEGIN
  SELECT EXISTS (SELECT 1 FROM admin_index WHERE account_id = LOWER(p_account_id)) AS is_admin;
END$$

CREATE PROCEDURE sp_is_system_admin(
  IN p_account_id CHAR(36)
)
  READS SQL DATA
  SQL SECURITY DEFINER
  COMMENT 'Is the account in system_admin_index'
BEGIN
  SELECT EXISTS (SELECT 1 FROM system_admin_index WHERE account_id = LOWER(p_account_id)) AS is_system_admin;
END$$

DELIMITER ;

-- ── Grants (EXECUTE only) ────────────────────────────────────────────────────
GRANT EXECUTE ON PROCEDURE ew_system.sp_is_admin        TO 'account_service_api'@'172.31.%';
GRANT EXECUTE ON PROCEDURE ew_system.sp_is_system_admin TO 'account_service_api'@'172.31.%';
-- dev: the shared devopensim user already has access to dev_ew_system.
-- Other components that need these checks get their own EXECUTE grants (their chats own those lines).

-- ── Maintaining the lists (by hand, as a DB admin) ───────────────────────────
-- Account ids are stored lower-case (the routines compare lower-case):
-- INSERT INTO admin_index (account_id) VALUES (LOWER('<account id>'));
-- INSERT INTO system_admin_index (account_id) VALUES (LOWER('<account id>'));
-- DELETE FROM admin_index WHERE account_id = LOWER('<account id>');
--
-- ── Check ────────────────────────────────────────────────────────────────────
-- CALL sp_is_admin('<account id>');          -- is_admin = 1 when listed, else 0
-- CALL sp_is_system_admin('<account id>');   -- is_system_admin = 1 when listed, else 0

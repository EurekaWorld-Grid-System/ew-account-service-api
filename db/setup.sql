-- ── ew-account-service-api: production database user (high access level) ───
-- Run ONCE in production, as the Aurora admin user, at the 0.2.0 production setup
-- (deploy/README.md "Registration setup"). The v1.0 account service only READS;
-- account_index/user_index rows are written by bms-adapter POST /users.
--   ew_index: account_index, user_index, license_index, institute_index, avatar_index
--   grid DB:  useraccounts
-- Create avatar_index first (db/avatar_index.sql). Replace <GRID_DB> with the
-- production OpenSim grid database name (= GRID_DB_NAME in deploy/config.env) and
-- CHANGE_ME_STRONG_PASSWORD (openssl rand -base64 32). Store the password in the
-- ew-account-service-api/aurora-password secret and don't commit the edited file.
--
-- Dev uses the shared devopensim user for now (no setup needed).

CREATE USER IF NOT EXISTS 'account_service_api'@'172.31.%' IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';

GRANT SELECT ON `ew_index`.`account_index`   TO 'account_service_api'@'172.31.%';
GRANT SELECT ON `ew_index`.`user_index`      TO 'account_service_api'@'172.31.%';
GRANT SELECT ON `ew_index`.`license_index`   TO 'account_service_api'@'172.31.%';
GRANT SELECT ON `ew_index`.`institute_index` TO 'account_service_api'@'172.31.%';
GRANT SELECT ON `ew_index`.`avatar_index`    TO 'account_service_api'@'172.31.%';

GRANT SELECT ON `<GRID_DB>`.`useraccounts`   TO 'account_service_api'@'172.31.%';

-- Check:
-- SHOW GRANTS FOR 'account_service_api'@'172.31.%';

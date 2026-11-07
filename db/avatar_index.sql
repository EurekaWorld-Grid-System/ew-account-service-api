-- ── ew_index.avatar_index (EurekaWorld_Account_Service_Design §5) ────────────
-- Avatar aliases the registration wizard may send as avatarCode. The account service
-- only checks that an active row exists; Robust maps the alias to its template avatar
-- user (AvatarAccount_<alias> in Robust's config), so no grid username is kept here.
-- Column conventions follow the other ew_index tables (CHAR(36) id, explicit timestamps).
--
-- Run as a DB admin on dev_ew_index (dev) and ew_index (production).

CREATE TABLE IF NOT EXISTS avatar_index (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  avatar_code  VARCHAR(64)  NOT NULL,        -- alias sent to Robust as `avatar`, e.g. 'Glen'
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   DATETIME     NOT NULL,
  updated_at   DATETIME     NOT NULL,
  UNIQUE KEY uq_avatar_index_avatar_code (avatar_code)
) ENGINE=InnoDB;

-- One row per alias Robust knows. Example:
-- INSERT INTO avatar_index (id, avatar_code, is_active, created_at, updated_at)
-- VALUES (UUID(), 'Glen', TRUE, UTC_TIMESTAMP(), UTC_TIMESTAMP());

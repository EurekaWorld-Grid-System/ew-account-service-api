-- ── ew_index.avatar_index (EurekaWorld_Account_Service_Design §5) ────────────
-- Avatar aliases the registration wizard may send as avatarCode.
-- v1.0 (registration through Robust): the account service only checks that an active
-- row exists and sends avatar_code to Robust, which maps it to its template avatar.
-- avatar_name (the template avatar's grid username) is for the future stage where
-- registration writes the grid DB directly instead of calling Robust.
-- Column conventions follow the other ew_index tables (CHAR(36) id, explicit timestamps).
--
-- Run as a DB admin on dev_ew_index (dev) and ew_index (production).

CREATE TABLE IF NOT EXISTS avatar_index (
  id           CHAR(36)      NOT NULL PRIMARY KEY,
  avatar_code  VARCHAR(64)   NOT NULL,       -- alias sent by the wizard (and to Robust), e.g. 'Glen'
  avatar_name  VARCHAR(255)  NOT NULL,       -- template avatar's grid username, e.g. 'boy01'
  is_active    BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at   DATETIME      NOT NULL,
  updated_at   DATETIME      NOT NULL,
  UNIQUE KEY uq_avatar_index_avatar_code (avatar_code)
) ENGINE=InnoDB;

-- One row per alias Robust knows (AvatarAccount_<alias> = <template user> in Robust's config). Example:
-- INSERT INTO avatar_index (id, avatar_code, avatar_name, is_active, created_at, updated_at)
-- VALUES (UUID(), 'Glen', 'boy01', TRUE, UTC_TIMESTAMP(), UTC_TIMESTAMP());

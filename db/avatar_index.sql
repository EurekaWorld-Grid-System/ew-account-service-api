-- ── ew_index.avatar_index ─────────────────────────────────────────────────────
-- Avatars the registration wizard offers and the account service accepts as avatarCode.
-- Owned by ew-account-service-api (EurekaWorld_Account_Service_Design §5,
-- EurekaWorld_Registration_Wizard_Architecture_v1.0 §6).
--   - account service (v1.0): checks avatar_code is active, sends it to Robust, which maps
--     the alias to its template avatar (AvatarAccount_<alias> in Robust's config).
--   - avatar_name: the template avatar's grid username, for the future stage where
--     registration writes the grid DB directly instead of calling Robust.
--   - display_name, image_url, in_main_form, position: the wizard's avatar picker
--     (ew-portal-api GET /registration/avatars: is_active AND in_main_form, ORDER BY position).
--
-- Run as a DB admin on dev_ew_index (dev) and ew_index (production).

CREATE TABLE IF NOT EXISTS avatar_index (
  id            CHAR(36)       NOT NULL PRIMARY KEY,
  avatar_code   VARCHAR(64)    NOT NULL,                -- alias sent by the wizard (and to Robust), e.g. 'Glen'
  avatar_name   VARCHAR(255)   NOT NULL,                -- template avatar's grid username, e.g. 'boy01'
  display_name  VARCHAR(255)   NOT NULL,                -- name shown in the wizard
  image_url     VARCHAR(2048)  NOT NULL,                -- picture shown in the wizard's avatar picker
  in_main_form  BOOLEAN        NOT NULL DEFAULT TRUE,   -- FALSE = special-project avatar, not offered in self-registration
  position      SMALLINT       NULL,                    -- display order in the wizard; NULL for in_main_form = FALSE
  is_active     BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at    DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_avatar_index_avatar_code (avatar_code)
) ENGINE=InnoDB;

-- MIGRATION: if avatar_index was already created from the earlier (pre-wizard) version of this
-- file, CREATE TABLE IF NOT EXISTS skips it. Run instead (fill display_name/image_url afterwards):
--   ALTER TABLE avatar_index
--     ADD COLUMN display_name VARCHAR(255)  NOT NULL DEFAULT '' AFTER avatar_name,
--     ADD COLUMN image_url    VARCHAR(2048) NOT NULL DEFAULT '' AFTER display_name,
--     ADD COLUMN in_main_form BOOLEAN       NOT NULL DEFAULT TRUE AFTER image_url,
--     ADD COLUMN position     SMALLINT      NULL AFTER in_main_form,
--     MODIFY created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
--     MODIFY updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
--   ALTER TABLE avatar_index ALTER COLUMN display_name DROP DEFAULT, ALTER COLUMN image_url DROP DEFAULT;

-- One row per alias Robust knows. Example:
-- INSERT INTO avatar_index (id, avatar_code, avatar_name, display_name, image_url, in_main_form, position)
-- VALUES (UUID(), 'Glen', 'boy01', 'Glen', 'https://<avatar image host>/glen.png', TRUE, 0);

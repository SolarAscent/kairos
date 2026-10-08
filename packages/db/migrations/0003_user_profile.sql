ALTER TABLE users
  ADD COLUMN nickname varchar(32),
  ADD COLUMN bio varchar(160) NOT NULL DEFAULT '',
  ADD COLUMN avatar_version uuid,
  ADD COLUMN avatar_mime_type varchar(32),
  ADD COLUMN avatar_base64 text;

ALTER TABLE users ADD CONSTRAINT users_avatar_valid CHECK (
  (avatar_version IS NULL AND avatar_mime_type IS NULL AND avatar_base64 IS NULL)
  OR
  (avatar_version IS NOT NULL AND avatar_mime_type IS NOT NULL AND avatar_base64 IS NOT NULL
    AND avatar_mime_type IN ('image/jpeg', 'image/png')
    AND length(avatar_base64) BETWEEN 4 AND 349528)
);

# Bundled global skills

This directory ships inside the backend image (`deploy/Dockerfile.backend`
copies it to `/app/skills` and sets `INNO_SKILLS_DIR` there). Each skill is a
subdirectory containing a `SKILL.md` marker file plus any supporting files —
the same layout as a local `INNO_SKILLS_DIR`.

Global skills are read-only in authenticated mode and ephemeral on worker
filesystems, so the image is their distribution channel: develop a skill in a
local skills directory (`INNO_SKILLS_DIR=./skills` or `runtime/skills`), then
copy it here and rebuild the image to roll it out to every worker.

Workspace-private skills (`.skills/` inside a workspace) are unaffected — they
replicate through the object store like any other workspace file.

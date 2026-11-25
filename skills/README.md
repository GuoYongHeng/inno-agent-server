# Bundled global skills

This directory ships inside the backend image (`deploy/Dockerfile.backend`
copies it to `/app/skills` and sets `INNO_SKILLS_DIR` there). Each skill is a
subdirectory containing a `SKILL.md` marker file plus any supporting files.

On server bootstrap the image directory is **seeded** into the platform skill
catalog: bodies go to object storage under `platform/skills/<id>/<version>/`,
metadata to PostgreSQL `skill_catalog` (`source=image-seed`). Tenants enable
skills through `tenant_skills` (the shared bodies stay read-only). Sessions
materialize enabled skills into the workspace's `.global-skills/` for the
agent `read` tool.

Publish an updated skill without rebuilding the image:

```bash
npm run skills:publish -- ./skills/my-skill
# or every child of a root:
npm run skills:publish -- --root ./skills
```

Requires `DATABASE_URL` and the same object-storage config the server uses.

Workspace-private skills (`.skills/` inside a workspace) are unaffected — they
replicate through the object store like any other workspace file.

Simple Mode presets bind platform skills by id in `preset.json` (`"skills":
["ppt-builder"]`); their `agent.md` is injected read-only from the image and is
never copied into the user's workspace.


# Migrations for the Agent Bridge Supabase project

Project `ornbhvaijcpsbcgquzhd`. **This directory does not yet hold the full
history.** Ten migrations were applied through the Supabase MCP before it
existed, so they live only in `supabase_migrations.schema_migrations` on the
server and nowhere in this repository. The repo is therefore NOT the record of
this schema, and a cold rebuild from these files is not possible today.

That gap is recorded here rather than left to be rediscovered. Anything added
from now on lands here as well as on the server.

`apply_migration` stamps its own timestamp, so a file named by hand matches no
row. Read the version back and name the file that:

```sql
select version from supabase_migrations.schema_migrations order by version desc limit 1;
```

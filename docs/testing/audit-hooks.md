# Git hook audit test rationale

## Deletion-only commits still run checkout quality checks

1. Observable behavior: a commit containing only deletions still runs the documented checkout-wide formatting and type-aware lint gates, without changing the index or unrelated working-tree files.
2. Credible regression: filtering staged paths to additions/copies/modifications/renames makes the hook skip both commands whenever a commit only deletes files.
3. Coverage gap: the existing real Git hook test covers newly added source files and partial staging, but every attempted commit has at least one nondeleted staged path.
4. Production seam: none. Extend the existing disposable repository test with a staged deletion and unrelated malformed source; check failure, repair the source, and verify the deletion commits normally. This rationale was recorded in `audit-operations.md` before changing the test, then separated for the tooling commit.

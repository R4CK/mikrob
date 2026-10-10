---
name: module-deletion-sweep
description: Delete a module/file without leaving dangling references that still compile. Use whenever you remove a source file, drop an export, or retire a feature -- the sweep must be by EXPORTED SYMBOL, not by filename or function name. Triggers - "delete this module", "remove the dead code", "drop the unused adapter", "retire this feature", "torold a holt kodot", "modul torlese".
---

# Module deletion sweep

## When to use
- Deleting one or more source files, or removing exports from a barrel/index.
- Retiring a feature whose code is "unwired" or "dead".
- Any change whose diff is mostly deletions.
- NOT for deleting a single local variable or a private helper with one caller in the same file.

## The failure this prevents
A deletion is easy to *believe* finished: the imports resolve, `tsc` is green, the suite passes.
What survives are references the type-checker cannot see:

- **string-keyed maps** (`{ SomeError: 401 }` status maps, error->code tables, feature registries)
- **allowlists / baselines / ratchets** that hold names as strings
- **comments and docs** describing an enforcement, cap or invariant that no longer exists
- **config keys, env names, migration or job identifiers** referring to the removed unit

None of these import anything, so nothing breaks at build time. The result is a control or a
document that silently refers to something gone -- and if a later card RE-CREATES the same name,
the stale entry quietly decides its behaviour with nobody reviewing that decision.

## Procedure

### 1. Enumerate what the deleted files EXPORTED (before deleting, or from git after)
Do not sweep for the filename or the functions you happen to remember. Get the real list:

```bash
# from the working tree, before deletion
grep -oE "^export (class|function|const|interface|type|enum) [A-Za-z0-9_]+" <file> | awk '{print $NF}'

# or after deletion, from the pre-delete commit
git show <sha-before>:<path> | grep -oE "^export (class|function|const|interface|type|enum) [A-Za-z0-9_]+" | awk '{print $NF}'
```
Include default exports and re-exported names from any barrel the module fed.

### 2. Grep EACH symbol across the whole tree, including non-code files
```bash
for s in $(cat symbols.txt); do
  n=$(grep -rn "\b$s\b" --include='*.*' . | grep -v node_modules | wc -l)
  [ "$n" -gt 0 ] && echo "STILL REFERENCED: $s ($n)"
done
```
Widen beyond source: `--include='*.*'` catches markdown, YAML, SQL and JSON that a
`--include='*.ts'` sweep silently skips.

### 3. Classify every hit before touching it
For each survivor decide, and say which:
- **live control** (a status map, a guard table) -- must be fixed; it is your debris.
- **document/comment** -- if it describes the deleted thing as existing, it now lies; fix it.
- **frozen review artifact** (a baseline, an approved allowlist) -- shrinking it may be a
  DECISION, not a mechanical follow-on. Leave it, and say so out loud with the consequence.
- **historical reference** ("the X regression, card 123") -- points at a past event, not the
  file. Deleting the file does not make the history untrue. Leave it.

### 4. Check the reverse direction too
Does anything the deleted module DEPENDED on now have zero remaining consumers? A deletion often
orphans one layer down. Sweep those too, or state that you checked and they still have callers.

### 5. Record the gap the deletion leaves
If the deleted unit was the only implementation of a capability, the capability is now missing.
Say so where a reader will look: the decision log, and any feature list that claims the capability
exists. A feature list saying "missing capability: none" is a lie the moment you delete the thing.

### 6. Check what the DELETED TEST FILES covered
A deletion card almost always removes "the module's own tests" too. A test file named after the dead
module can still hold coverage of code that STAYS -- and the natural check (does the removed file/`it()`
count match what was approved?) cannot see that, because the count is correct either way.

```bash
# titles + imports of each deleted test file, at the pre-delete commit
git show <sha-before>:<deleted-test> | grep -nE "^import|describe\(|it\("
```
For every symbol in there that still exists after the deletion, find a SURVIVING test that asserts the
same behaviour -- and check it asserts the CONTROL, not merely the throw (a denied-attempt tripwire's
value is the audit row, not the exception). If nothing survives, the deletion silently dropped live
coverage: that is a FAIL, not tidier code.

## Pitfalls
- **Filename/function sweep feels complete and is not.** A class declared inside the deleted file
  is invisible to it. Measured 2026-08-22: a filename+function sweep reported clean; the
  symbol-level sweep on the same deletion found FOUR dangling references, one of them a live
  status mapping and one a comment describing a hard cap whose enforcer was gone.
- **A green typecheck is not evidence here.** The survivors are strings and prose.
- **Do not sweep the frozen baselines into the cleanup.** Removing entries from a reviewed
  allowlist tightens it, which sounds safe, but it is still a change to a review artifact -- raise
  it instead of silently doing it.
- **"Its own tests" can guard live code.** Measured 2026-08-22: a deleted `*-lifecycle.test.ts` named
  for the dead module tested, in its last block, a STILL-LIVE denied-target tripwire. Coverage happened
  to survive elsewhere and better -- but only measuring showed that, and the approved-count match did not.
- **Re-creation is the real hazard.** If a follow-up card will rebuild the same names, a stale
  entry left behind will pre-decide their behaviour. Name that risk explicitly in the review.

## Verification
- [ ] Symbol list came from the file's own `export` lines (or the pre-delete blob), not from memory.
- [ ] Every symbol grepped across ALL file types, not just source.
- [ ] Every surviving hit classified and either fixed or explicitly left with a stated reason.
- [ ] Typecheck + suite green -- necessary, not sufficient; note that they cannot see this class.
- [ ] Every deleted TEST file checked for coverage of code that still exists, and each such
      behaviour shown to be covered by a surviving test (asserting the control, not just the throw).
- [ ] Any capability the deletion removes is recorded where a reader looks for it.

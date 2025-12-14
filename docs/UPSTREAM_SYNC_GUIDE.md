# Upstream Sync Guide

This guide explains how to properly sync with the upstream CloudTAK repository while handling file deletions and preventing import errors.

## The Problem

When syncing with upstream, files that were removed upstream may still exist locally, causing:
- Import errors for missing schema exports
- Orphaned route files that reference deleted schemas
- Runtime errors when the application tries to load deleted modules

## The Solution

### 1. Improved Sync Script

The `scripts/sync-upstream.sh` script now properly handles file deletions:

```bash
# Enhanced sync with deletion handling
./scripts/sync-upstream.sh
```

**Key improvements:**
- Compares upstream vs local file lists
- Removes files that exist locally but not upstream
- Automatically runs post-sync validation
- Fails fast if validation errors are found

### 2. Post-Sync Validation

The `scripts/post-sync-validate.sh` script catches common sync issues:

```bash
# Run validation manually
./scripts/post-sync-validate.sh

# Or via npm
cd api && npm run validate:sync
```

**Validation checks:**
- TypeScript compilation errors
- Missing schema exports that are still imported
- Orphaned route files not imported in index.ts
- Basic API startup test

### 3. Pre-Sync Analysis

Before syncing, analyze potential conflicts:

```bash
# Check what will change before syncing
./scripts/pre-sync-check.sh
```

## Workflow

### Safe Sync Process

1. **Pre-sync check** (optional but recommended):
   ```bash
   ./scripts/pre-sync-check.sh
   ```

2. **Run the sync**:
   ```bash
   ./scripts/sync-upstream.sh
   ```
   
   The script will:
   - Fetch latest upstream
   - Sync api/ and tasks/ directories
   - Remove files deleted upstream
   - Run validation automatically
   - Fail if validation errors are found

3. **Review and test**:
   ```bash
   git status                    # Review changes
   docker-compose up            # Test locally
   ```

4. **Commit and deploy**:
   ```bash
   git add .
   git commit -m "Sync with upstream"
   ./scripts/deploy.sh
   ```

### Manual Validation

If you need to run validation separately:

```bash
# TypeScript compilation check
cd api && npm run validate:imports

# Full post-sync validation
npm run validate:sync

# Or run the script directly
./scripts/post-sync-validate.sh
```

## Common Issues and Solutions

### Missing Schema Exports

**Error**: `SyntaxError: The requested module '../lib/schema.js' does not provide an export named 'LayerAlert'`

**Cause**: Route file imports a schema table that was removed upstream

**Solution**: The sync script now automatically removes orphaned route files

### Orphaned Route Files

**Error**: Route files exist but aren't imported in `index.ts`

**Cause**: Route was removed upstream but file still exists locally

**Solution**: 
1. Check if the route should be removed: `git show upstream/main:api/routes/filename.ts`
2. If it doesn't exist upstream, remove it locally
3. If it's TAK-NZ specific, ensure it's properly imported

### TypeScript Compilation Errors

**Error**: Various TypeScript errors after sync

**Cause**: API changes in upstream dependencies

**Solution**:
1. Review the specific errors
2. Update code to match new API signatures
3. Consider creating patches for TAK-NZ specific modifications

## File Structure

```
scripts/
├── sync-upstream.sh          # Main sync script with deletion handling
├── post-sync-validate.sh     # Validation after sync
├── pre-sync-check.sh         # Pre-sync conflict analysis
└── validate-sync.js          # Detailed import validation (Node.js)
```

## NPM Scripts

Added to `api/package.json`:

```json
{
  "scripts": {
    "validate:sync": "../scripts/post-sync-validate.sh",
    "validate:imports": "tsc --noEmit --skipLibCheck"
  }
}
```

## Best Practices

1. **Always run validation** after syncing
2. **Test locally** before deploying
3. **Review changes** carefully, especially deletions
4. **Create patches** for TAK-NZ specific features that conflict with upstream
5. **Document customizations** that need to be preserved across syncs

## Troubleshooting

### Sync Script Fails

If the sync script fails validation:

1. Check the error messages
2. Fix any import errors or orphaned files
3. Run validation again: `./scripts/post-sync-validate.sh`
4. Repeat until validation passes

### False Positives

If validation reports false positives:

1. Review the specific warnings
2. Update the validation script if needed
3. Document any expected exceptions

### Emergency Recovery

If sync breaks the application:

1. Revert the sync: `git reset --hard HEAD~1`
2. Analyze the issues: `./scripts/pre-sync-check.sh`
3. Fix issues manually or create patches
4. Try sync again

## Future Improvements

- Automated patch application for TAK-NZ customizations
- Integration with CI/CD pipeline
- Automated testing after sync
- Conflict resolution helpers
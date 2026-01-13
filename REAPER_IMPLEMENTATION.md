# Reaper Service Implementation Summary

## What Was Implemented

A simplified interim Reaper service that automatically cleans up stale polygons and lines from TAK clients.

### Files Created/Modified

1. **`api/lib/reaper.ts`** (NEW)
   - Reaper service class (~105 lines)
   - Queries `connection_features` for stale polygons/lines
   - Sends ForceDelete messages via ConnectionPool
   - Implements retry logic (T+5m, T+15m) using setTimeout

2. **`api/lib/config.ts`** (MODIFIED)
   - Added `import Reaper from './reaper.js'`
   - Added `reaper: Reaper` property
   - Added `this.reaper = new Reaper(this)` in constructor

3. **`scripts/patches/049-add-reaper-service.patch`** (NEW)
   - Patch file for reaper.ts

4. **`scripts/patches/050-integrate-reaper-config.patch`** (NEW)
   - Patch file for config.ts changes

5. **`scripts/patches/README-REAPER.md`** (NEW)
   - Documentation for applying patches after upstream sync

## Key Features

✅ **No Schema Changes** - Uses existing `connection_features` table  
✅ **Always Enabled** - No environment variable required  
✅ **Configurable** - Via optional environment variables  
✅ **Retry Logic** - Handles offline clients (T+5m, T+15m)  
✅ **Safe** - Isolated service with error handling  
✅ **Patchable** - Easy to reapply after upstream sync  

## Configuration (Optional)

```bash
# All optional - defaults work for most deployments
REAPER_INTERVAL=60      # Sweep interval in seconds (default: 60)
REAPER_BATCH_SIZE=100   # Max features per sweep (default: 100)
REAPER_BUFFER=30        # Buffer before considering stale (default: 30)
```

## How It Works

1. **Every 60 seconds** (configurable), the Reaper queries for stale features:
   ```sql
   SELECT connection, id FROM connection_features
   WHERE properties->>'stale' < NOW() - INTERVAL '30 seconds'
   AND ST_GeometryType(geometry) IN ('ST_Polygon', 'ST_LineString', ...)
   LIMIT 100
   ```

2. **For each stale feature**:
   - Sends ForceDelete message to TAK Server
   - Deletes from `connection_features` table
   - Schedules retries at T+5m and T+15m (for offline clients)

3. **Retries are in-memory** (lost on restart, but acceptable for interim)

## Limitations (Acceptable for Interim)

⚠️ **Retries lost on restart** - setTimeout-based, not database-backed  
⚠️ **No index optimization** - Query slower for >50k features  
⚠️ **No opt-out mechanism** - Can't mark features as permanent  
⚠️ **No admin endpoints** - No monitoring UI  

## Testing

The service will start automatically when the API container starts. Monitor logs for:

```
ok - Reaper service started (interval: 60000ms)
Reaper: Found 5 stale features to clean up
Reaper: Force-deleting stale feature nzta-delay-535218 from connection 1
```

## Applying Patches After Upstream Sync

```bash
cd /home/ubuntu/GitHub/TAK-NZ/CloudTAK

# After syncing with upstream
git pull upstream main

# Apply patches
cd api/lib
patch -p3 < ../../scripts/patches/049-add-reaper-service.patch
patch -p2 < ../../scripts/patches/050-integrate-reaper-config.patch

# Verify
git diff reaper.ts config.ts

# Commit
git add reaper.ts config.ts
git commit -m "feat: Reapply Reaper service after upstream sync"
```

## Migration to Full Solution

When upstream implements the full Reaper service with schema changes:

1. Remove `api/lib/reaper.ts`
2. Revert changes to `api/lib/config.ts` (3 lines)
3. Run upstream migrations
4. Deploy upstream version

No conflicts because we didn't change the schema!

## Related Documentation

- Feature request: `FEATURE_REQUEST_REAPER.md`
- Patch documentation: `scripts/patches/README-REAPER.md`

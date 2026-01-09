# Reaper Service - Quick Reference

## What It Does
Automatically removes expired polygons and lines from TAK clients (they don't auto-expire like points do).

## Files
- `api/lib/reaper.ts` - Service implementation
- `api/lib/config.ts` - Integration (3 lines added)
- `scripts/patches/*.patch` - Reapplication patches

## Configuration (All Optional)
```bash
REAPER_INTERVAL=60      # Sweep every 60 seconds
REAPER_BATCH_SIZE=100   # Process 100 features per sweep
REAPER_BUFFER=30        # 30 second buffer before deletion
```

## Monitoring
```bash
# Check logs for reaper activity
docker logs cloudtak-api | grep Reaper

# Expected output:
# ok - Reaper service started (interval: 60000ms)
# Reaper: Found 5 stale features to clean up
# Reaper: Force-deleting stale feature <uid> from connection <id>
```

## After Upstream Sync
```bash
cd api/lib
patch -p3 < ../../scripts/patches/049-add-reaper-service.patch
patch -p2 < ../../scripts/patches/050-integrate-reaper-config.patch
git add reaper.ts config.ts
git commit -m "feat: Reapply Reaper service"
```

## Troubleshooting

**No features being deleted?**
- Check if features have `stale` property in `connection_features`
- Verify features are polygons/lines (not points)
- Check `REAPER_BUFFER` - features must be stale for 30+ seconds

**Too many/few deletions?**
- Adjust `REAPER_BATCH_SIZE` (default: 100)
- Adjust `REAPER_INTERVAL` (default: 60 seconds)

**Performance issues?**
- Increase `REAPER_INTERVAL` to reduce query frequency
- Decrease `REAPER_BATCH_SIZE` to process fewer features per sweep

## Removal (When Upstream Implements)
```bash
rm api/lib/reaper.ts
git checkout api/lib/config.ts  # Revert 3 lines
```

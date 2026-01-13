# CloudTAK Reaper Service Patches

Automatic cleanup of stale polygons and lines from TAK clients.

## Patches

- `049-add-reaper-service.patch` - Adds the Reaper service class
- `050-integrate-reaper-config.patch` - Integrates Reaper into Config

**Purpose:**
Automatically cleans up stale polygons and lines from TAK clients. TAK clients automatically remove stale Point features, but Polygons and LineStrings remain visible indefinitely. The Reaper service monitors the `connection_features` table and sends ForceDelete messages when polygons/lines become stale.

**Features:**
- No schema changes (interim solution)
- Configurable sweep interval (default: 60 seconds)
- Configurable batch size (default: 100 features)
- Configurable buffer time (default: 30 seconds)
- Automatic retries for offline clients (T+5m, T+15m)

**Environment Variables:**
```bash
REAPER_INTERVAL=60      # Sweep interval in seconds
REAPER_BATCH_SIZE=100   # Max features per sweep
REAPER_BUFFER=30        # Buffer time in seconds before considering stale
```

**Applying Patches After Upstream Sync:**

```bash
# From CloudTAK root directory
cd api/lib

# Apply reaper service
patch -p3 < ../../scripts/patches/049-add-reaper-service.patch

# Apply config integration
patch -p2 < ../../scripts/patches/050-integrate-reaper-config.patch
```

**Verification:**
```bash
# Check if patches applied successfully
git diff api/lib/reaper.ts
git diff api/lib/config.ts

# If patches applied cleanly, commit
git add api/lib/reaper.ts api/lib/config.ts
git commit -m "feat: Add Reaper service for stale feature cleanup"
```

**Removing Patches (when upstream implements):**

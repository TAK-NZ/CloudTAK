# WebSocket Reconnection Limit Patch

## Overview
This patch adds reconnection limits with exponential backoff to the WebSocket connection handler to prevent infinite reconnection loops when authentication fails or the connection cannot be established.

## Problem
The original WebSocket implementation would immediately reconnect on any connection close event, leading to:
- Infinite reconnection loops when authentication fails
- Resource exhaustion from rapid reconnection attempts
- No user feedback when connection cannot be established
- Users needing to clear all site data to recover from stuck states

## Solution
Implements a reconnection strategy with:
- **Maximum 5 reconnection attempts** before giving up
- **Exponential backoff**: 1s, 2s, 4s, 8s, 10s (capped at 10s)
- **Automatic reset** on successful connection
- **Clear console logging** for debugging

## Changes
- Adds `reconnectAttempts` counter to track retry attempts
- Adds `maxReconnectAttempts` limit (set to 5)
- Implements exponential backoff: `delay = min(1000 * 2^(attempt-1), 10000)`
- Resets counter to 0 on successful connection
- Logs reconnection attempts with delay information
- Shows error message when max attempts reached

## Files Modified
- `api/web/src/workers/atlas-connection.ts`

## Testing
1. **Normal reconnection**: Disconnect network briefly, verify reconnection works
2. **Auth failure**: Use expired token, verify it stops after 5 attempts
3. **Server restart**: Restart backend, verify reconnection succeeds
4. **Network issues**: Simulate intermittent connectivity

## Backoff Schedule
| Attempt | Delay | Total Time |
|---------|-------|------------|
| 1       | 1s    | 1s         |
| 2       | 2s    | 3s         |
| 3       | 4s    | 7s         |
| 4       | 8s    | 15s        |
| 5       | 10s   | 25s        |

After 25 seconds total, the connection gives up and user must refresh the page.

## Related Issues
- Fixes infinite reconnection loops
- Prevents "connection closed by other side" requiring site data clearing
- Improves error recovery UX

## Dependencies
- Works with existing WebSocket infrastructure
- No new dependencies required
- Compatible with OIDC authentication flow

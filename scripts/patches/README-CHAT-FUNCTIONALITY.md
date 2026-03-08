# Chat Functionality Fixes (053)

**Patch:** `053-chat-functionality-fixes.patch`

## Summary

Fixes multiple interconnected issues with chat functionality and contact presence, bringing behaviour closer to parity with ATAK. See upstream bug reports in the repository root for full details.

## Files Modified

| File | Change |
|------|--------|
| `api/lib/connection-web.ts` | Remove duplicate storage; add `dest callsign` to CoT detail for plugin routing |
| `api/lib/connection-pool.ts` | Fix chatroom naming and `isOutgoing` UID comparison |
| `api/routes/profile-chat.ts` | Fix delete using `message_id` instead of serial `id` |
| `api/web/src/base/chatroom-chats.ts` | Remove unsafe display-name-as-UID fallback |
| `api/web/src/components/CloudTAK/Menu/MenuChat.vue` | Sender labels, scroll fixes, input bar layout, recipient state preservation |
| `api/web/src/components/CloudTAK/Menu/MenuContacts.vue` | Online check includes CoT-discovered contacts; periodic refresh |
| `api/web/src/components/CloudTAK/util/NotificationToast.vue` | Truncate body to prevent toast overflow |
| `api/web/src/workers/atlas-database.ts` | Fire `Contact_Change` when contact CoT goes stale |
| `api/web/src/workers/atlas-team.ts` | Merge contacts on reconnect; notify only on first appearance |

## Issues Fixed

### Server-side Chat
- **Double message**: `connection-web.ts` was calling `ProfileChat.generate()` immediately on send, and the TAK Server echo via `connection-pool.ts` stored it again. Removed the duplicate — the echo path is the single source of truth.
- **Wrong chatroom**: All messages now stored under `feat.properties.chat.chatroom` (always the recipient's callsign) so all users see messages in the same chatroom, matching ATAK behaviour.
- **`isOutgoing` broken**: Was comparing `senderUid` against the raw email (`conn.id`) instead of the full TAK UID (`ANDROID-CloudTAK-<email>`), so every message was treated as incoming.
- **Chat delete 500**: Delete predicate used the serial `id` column (never exposed to client) instead of `message_id` (the TAK GeoChat UUID the client holds).
- **Plugin routing**: TAK Server plugins (e.g. tak-gpt) search `xmlDetail` for `dest callsign="..."`. The TAK Server strips `<marti>` before populating `xmlDetail`, so `addDest()` is insufficient. A `<dest callsign="..."/>` element is now written directly inside `<detail>`.

### Client-side Chat
- **Recipient lost on navigation**: `route.query.uid` is only present on the `/new` route. After `router.push` to `/:chatroom`, subsequent messages had no recipient and were silently dropped. Recipient is now captured into component state at declaration time.
- **Message invisible on `/new` route**: `liveQuery` subscription was skipped when `route.params.chatroom === 'new'`. Now subscribes whenever `room` is non-null.
- **No sender labels**: Messages showed as plain bubbles with no attribution. Now shows sender callsign for incoming and `Me` for outgoing, matching ATAK convention.
- **Input bar overlapping messages**: `position-absolute bottom-0` input bar sat on top of the message list. Restructured as a flex column with `flex-shrink-0` footer.
- **No scroll-to-bottom indicator**: Added a floating arrow button above the input bar that appears when not at the bottom of the conversation.
- **Silent send failures**: `sendMessage` had no error handling; failures cleared the input with no feedback. Now logs to console and preserves input on error.

### Contact Presence
- **Repeated "Online" notifications**: `load()` called `contacts.clear()` on every reconnect, causing bot/plugin contacts (absent from `/api/contacts/all`) to re-trigger "Online" notifications. Changed to merge.
- **Offline never detected**: `diff()` removed stale CoTs from the map but never fired `Contact_Change`. Now removes the contact from `AtlasTeam.contacts` and fires `Contact_Change` when a CoT expires.
- **Comlink property access bug**: `fetchList` accessed `team.contacts` as a raw property across the Comlink boundary (returns an unresolvable proxy). Fixed to use the return value of `team.load()`.
- **Bot contacts not shown as Online**: Online check now tests both `db.has(uid)` and `team.get(uid)` so contacts discovered from received CoTs appear correctly.

### Notifications
- **Toast overflow**: Long chat message bodies caused the notification toast to exceed screen width, making the close button inaccessible. Body is now truncated.

## Upstream Bug Reports

- `UPSTREAM-BUG-REPORT-CONTACT-FLOOD.md`
- `UPSTREAM-BUG-REPORT-CHAT-DELETE.md`
- `UPSTREAM-BUG-REPORT-PRESENCE-RELIABILITY.md`
- `UPSTREAM-BUG-REPORT-CHAT-SEND.md`
- `UPSTREAM-BUG-REPORT-CHAT-SENDER-LABEL.md`
- `UPSTREAM-BUG-REPORT-CHAT-PLUGIN-ROUTING.md` (filed against `dfpc-coe/node-cot`)

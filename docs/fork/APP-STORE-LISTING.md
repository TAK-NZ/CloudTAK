# App Store listing for TAK.NZ

Everything App Store Connect asks for, ready to paste, plus how to make the screenshots and app previews.
Written 21 November 2026 against the 13.124.0 iOS app. Apple renames fields and adds devices now and then, so
treat the labels as a guide, and re-check the two Apple pages linked in [Screenshots](#screenshots) before a release.

**Status: a draft that needs your decisions.** Items marked **TODO** need a fact only the account owner has
(a URL, a legal name, a demo login) or a decision (see [Decisions before submitting](#decisions-before-submitting)).
Nothing here has been entered in App Store Connect. Field lengths were counted by a script, not by eye.

For how the Apple account and the TestFlight pipeline were set up, see [APPLE-DEVELOPER-SETUP.md](APPLE-DEVELOPER-SETUP.md).
For the shorter store checklist, see [MOBILE-APPS.md](MOBILE-APPS.md#11-store-submission).

## Decisions before submitting

These change what you can honestly write in the listing, so settle them first.

| # | Decision | Why it matters | Recommendation |
|---|---|---|---|
| 1 | **Capgo over-the-air updater.** `capacitor.config.json` sets `autoUpdate: atBackground`, and the plugin's default servers are `plugin.capgo.app` (`/updates`, `/stats`, `/channel_self`). No bundles are ever uploaded, so it does nothing useful, but it still contacts a third party with an app and device identifier on each foreground. | It is a third-party data flow you would have to declare in App Privacy, it is not mentioned in the privacy policy, and over-the-air code needs its own review reasoning (Guideline 2.5.2). | Turn it off (`autoUpdate: false`, or remove the plugin) before the submitted build. Needs a new build. If you keep it, add **Device ID** (third-party, app functionality) to the privacy answers. |
| 2 | **Capabilities missing from TestFlight builds.** `App-TestFlight.entitlements` is empty: no push notifications, no associated domains (passkeys), no location push. | The listing may only describe what the submitted build does. Push alerts and passkey sign-in are not live until those capabilities are enabled on the App ID and added back. | Either enable them before submission, or keep them out of the text. The description above already leaves out push and passkeys. The review notes have a line for each, to add once they work. |
| 3 | **Public listing or unlisted.** The app is only useful with an account on a TAK.NZ server. | A public listing invites reviewers and users with no account. Apple's *unlisted app distribution* gives a link-only listing that is not searchable. | Consider unlisted, which fits a closed community. It needs a request form to Apple. A public listing works too, with a demo account for review. |
| 4 | **Availability.** | You choose the countries. | New Zealand, and Australia if partner teams there will use it. |
| 5 | **User-generated content.** The app has chat, shared photos and shared markers between signed-in people. | Guideline 1.2 asks for a way to report content and block abusive users, and published contact details, for apps with user-generated content. This app has no public feed and every user is vetted, but a reviewer may ask. | Write the closed-community explanation in the review notes (below). The chat and contacts code has no report or block feature. |
| 6 | **Info.plist permission texts** have grammar errors that a reviewer and users will read. | The camera text says "Allows user's to upload geotagged photos and share them with other user's", and the Face ID text "User's are able to login...". | Replace them with the texts under [Permission texts](#permission-texts). Needs a new build. |

## App information

Set once, under *App Information* and *Pricing and Availability*.

| Field | Value | Limit / note |
|---|---|---|
| Name | `TAK.NZ` | 6 / 30. Already created. Names are unique across the App Store |
| Subtitle | `Team situational awareness` | 26 / 30 |
| Primary language | English (U.K.) | Already set. NZ spelling follows British |
| Bundle ID | `nz.tak.app` | Already set. SKU `taknz-ios` |
| Primary category | Navigation | The map is the app. *Productivity* is the alternative |
| Secondary category | Utilities | Optional |
| Content rights | Yes, it shows third-party content | Map tiles and data feeds (NZTA road events, weather radar, basemaps). **TODO** confirm each source's licence allows this use |
| Price | Free | No in-app purchases, no ads |
| Availability | **TODO** New Zealand, Australia? | See decision 4 |
| Distribution | **TODO** Public or unlisted | See decision 3 |
| Licence agreement | Apple's standard EULA | Nothing custom needed |

## Version information (1.0 / 13.124.0)

The version Apple sees is the marketing version, `13.124.0` today. The build number comes from the CI run number.

### Promotional text (159 / 170)
Can be changed at any time without a new review.

```
See your team on one live map, share your position when you choose to, and keep everyone working from the same picture. For TAK.NZ community and partner teams.
```

### Description (1887 / 4000)

```
TAK.NZ puts your team's map in your pocket. See where your team is, share your own position, chat, and work from one shared picture of the situation, in the field or at a desk.

TAK.NZ is the mobile app for the TAK.NZ community: search and rescue, emergency management and other response and volunteer teams that use the Team Awareness Kit (TAK). You need an account on a TAK.NZ server to sign in. Accounts are issued by your organisation or by TAK.NZ.

WHAT YOU CAN DO
• See your team live on the map, with positions, callsigns and status
• Share your location, and pause sharing with one tap whenever you want to be off the map
• Chat with people and groups, and share photos and files
• Take geotagged photos and attach them to the map
• Draw and share markers, routes and areas
• Work on shared missions that your whole team sees and updates
• Switch basemaps and layers, including NZ road events, weather radar and other feeds your server provides
• Watch video feeds shared by your team
• Sign in with your organisation's single sign-on
• Work alongside people using ATAK, iTAK and WinTAK on the same server

YOU STAY IN CONTROL
Your location goes only to the people signed in to your TAK server, never to advertisers. TAK.NZ does not track you across other apps or websites. Pause sharing at any time, and the app stops sending your position, disconnects from the server and releases the location service.

LOCATION IN THE BACKGROUND
While you are sharing, TAK.NZ can keep sending your position when the app is in the background or the screen is off, so your team still sees where you are. iOS shows its location indicator while this is happening.

IMPORTANT
TAK.NZ is not an emergency service and does not replace calling 111. Position sharing depends on your device, mobile coverage and your server, so do not rely on it alone for safety.

Need help or an account? Visit tak.nz.
```

Every feature line comes from the app's menus (Features, Contacts, Channels, Chats, Routes, Data Sync, Videos,
BaseMaps, Files and Settings). **Before submitting, check each against the submitted build**, and check that the
NZ layers and the video feeds exist on the server the reviewer will use. Remove a line rather than overstate it.

### Keywords (96 / 100)
Comma separated, no spaces after commas. Don't repeat the app name or category, Apple already indexes them.

```
TAK,ATAK,iTAK,situational awareness,SAR,search and rescue,CoT,map,tracking,tactical,volunteer,NZ
```

### What's New (41 / 4000)

```
First release of TAK.NZ on the App Store.
```

### URLs and copyright

| Field | Value |
|---|---|
| Support URL (required) | **TODO** a page with a contact method. `https://tak.nz` works only if it has one |
| Marketing URL (optional) | `https://tak.nz` |
| Privacy Policy URL (required) | **TODO** none exists in the repository. See [Privacy policy](#privacy-policy) |
| Copyright | **TODO** `2026 <legal name of the account holder>` |

## App Privacy ("nutrition labels")

Answer for the data **the app and your server** collect, including what third-party SDKs collect.
These answers are from reading the code, not from a network capture. **Verify them against your server's
data handling before publishing.** Declare conservatively: over-declaring is harmless, under-declaring is a
rejection or a later correction.

**Do you or your third-party partners collect data from this app?** Yes.
**Tracking** (linking with other companies' data for ads or sharing with data brokers): **No** for every type.

| Data type (Apple's name) | What it is here | Linked to the user | Purposes |
|---|---|---|---|
| Contact Info: **Email Address** | Sign-in account name | Yes | App Functionality |
| Contact Info: **Name** | Callsign and profile name shown to the team | Yes | App Functionality |
| Location: **Precise Location** | Position shared with the team, in the background too | Yes | App Functionality |
| User Content: **Photos or Videos** | Geotagged photos attached to markers, shared files | Yes | App Functionality |
| User Content: **Other User Content** | Markers, routes, missions, chat messages | Yes | App Functionality |
| Identifiers: **User ID** | Account identifier on the server | Yes | App Functionality |
| Identifiers: **Device ID** | Push notification token (Firebase Cloud Messaging) and session identifiers | Yes | App Functionality |
| Diagnostics: **Other Diagnostic Data** | Failed-request reports sent to your own server (`/api/error`) | Yes | App Functionality |

Not collected: Health and Fitness, Financial Info, Sensitive Info, Contacts, Browsing History, Search History,
Purchases, Usage Data (no analytics SDK is present), Advertising Data.

If decision 1 goes the other way and the Capgo updater stays, also declare **Device ID** as collected by a
third party for App Functionality.

### Privacy policy
The listing needs a public page that says: what is collected (the table above), that location is shared only with
people signed in to the same TAK server and with the server operator, that nothing is sold or used for advertising or
tracking, how long data is kept, who processes it (AWS hosting, Google Firebase for push if enabled), how a user asks
for access or deletion, and a contact address. It must be consistent with the labels. Say if you want me to draft it
as a page for the `app.tak.nz` repository.

### Account deletion
Guideline 5.1.1(v) requires in-app account deletion when an app lets people **create** an account. This app does not:
accounts are issued by the organisation through single sign-on. Say that in the review notes.

## Age rating

Apple's questionnaire changes, so answer it in the UI. The honest answers from the code are:

| Topic | Answer |
|---|---|
| Violence, sexual content, nudity, profanity, horror, drugs, alcohol, gambling, contests | None |
| Medical or health information | None |
| Messaging and chat | **Yes** (between signed-in team members) |
| User-generated content | **Yes** (photos, markers and messages shared in teams) |
| Unrestricted web access | No (the app opens links in the system browser) |
| Advertising | No |
| Parental controls, age assurance | No |

Apple works out the rating from these. Expect a mid-range rating because of chat and user content. Don't answer
"None" to those two to get a lower rating.

## Export compliance
`ITSAppUsesNonExemptEncryption` is already `false` in `Info.plist`, because the app only uses the encryption built
into iOS (HTTPS and TLS). App Store Connect then skips the question. No documentation is needed.

## App Review information

| Field | Value |
|---|---|
| Contact first name, last name, phone, email | **TODO** a person who answers within a day. Reviewers phone sometimes |
| Sign-in required | Yes |
| Demo account | **TODO** a username and password for a dedicated review account on a server the reviewer can reach, with demo data and **no real people or real operations** |
| Notes | Below |

### Notes for the reviewer (paste into the Notes field)

```
TAK.NZ is the mobile client for TAK.NZ, a closed community of search and rescue, emergency management and volunteer
teams in New Zealand that share a live map using the open Team Awareness Kit (TAK) system. It is not for the general
public: you sign in to a server that the organisation runs. A demo account is provided below.

HOW TO REVIEW
1. Open the app. Choose "TAK.NZ Demo" (map.demo.tak.nz) from the server list.
2. Sign in with the demo account: <TODO username> / <TODO password>. It uses the organisation's own single sign-on page,
   which is why Sign in with Apple is not offered (Guideline 4.8: the app uses its organisation's own account system).
   Accounts are created and removed by the organisation, not in the app, so there is no in-app account creation or deletion.
3. The map shows demo team members and demo data. Tap a marker, open the menu for Chats, Routes and Basemaps, and open
   the location panel at the lower left to pause or resume sharing.

LOCATION (Guideline 5.1.1, 2.5.4)
The app shows your position to the other people on your team and shares it with them, which is its core purpose
(real-time team situational awareness). Background location is declared (UIBackgroundModes: location) because a team
member whose phone is in a pocket or has its screen off must stay visible to the rest of the team. Location is only
requested after an in-app explanation screen. Sharing can be paused with one tap in the location panel, which stops
the location service, disconnects from the server and removes the push registration. Location is never used for
advertising or tracking.

CAMERA AND PHOTOS
Used to take geotagged photos and attach them to map markers, and to attach photos from the library.

USER CONTENT (Guideline 1.2)
Chat, photos and markers are visible only to people in the same access-controlled TAK channels. Every user is
vetted by the organisation, and an administrator can disable an account or remove content on the server.
There is no public feed.

OTHER
No in-app purchases, no ads, no analytics or tracking SDKs. Encryption is standard HTTPS/TLS only
(ITSAppUsesNonExemptEncryption = NO).
[Add when live: Push notifications deliver team alerts and chat messages. / Passkey and Face ID sign-in use the
associated domain <TODO>.]
```

### Permission texts
Suggested replacements for `app/ios/App/App/Info.plist`. They need a new build to take effect.

| Key | Suggested text |
|---|---|
| `NSLocationWhenInUseUsageDescription` | TAK.NZ shows your position to the other people on your team so everyone has the same live picture of the situation. |
| `NSLocationAlwaysAndWhenInUseUsageDescription` | TAK.NZ keeps sharing your position with your team while the app is in the background, so they can still see where you are. You can pause sharing at any time. |
| `NSCameraUsageDescription` | TAK.NZ uses the camera to take geotagged photos that you can share with your team. |
| `NSPhotoLibraryUsageDescription` | TAK.NZ lets you attach photos from your library to map markers. |
| `NSPhotoLibraryAddUsageDescription` | TAK.NZ saves photos you take in the app to your photo library. |
| `NSFaceIDUsageDescription` | TAK.NZ uses Face ID to sign you in with a passkey. (Only if passkeys are enabled.) |

## Screenshots

Specs checked against Apple's pages on 21 November 2026:
[screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications),
[app preview specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications).

The app supports iPhone and iPad (`TARGETED_DEVICE_FAMILY = 1,2`), so both are required. Provide the largest size and
App Store Connect scales it down for the other devices.

| Set | Size (portrait) | Required | Count |
|---|---|---|---|
| iPhone, 6.9" (Dynamic Island, large) | **1320 x 2868** (1290 x 2796 and 1260 x 2736 also accepted) | Yes | 1 to 10 |
| iPad, 13" | **2064 x 2752** (2048 x 2732 also accepted) | Yes, because the app runs on iPad | 1 to 10 |

PNG or JPEG, no alpha channel, no rounded corners baked in at the edge of the image.

### What the tool does
`scripts/app-store-media.py` turns raw captures into files App Store Connect accepts. It does not make screenshots
from nothing: Apple requires them to show the real app, and a made-up screen is a rejection.

```bash
# 1. Put raw captures (from a real device) in raw/iphone and raw/ipad, named 01-..., 02-..., in the order to show
# 2. Write raw/captions.txt, one "file name: caption" line per image (the lines below are the suggestions)
scripts/app-store-media.py screenshots --device iphone --in raw/iphone --out out/iphone --captions raw/captions.txt
scripts/app-store-media.py screenshots --device ipad   --in raw/ipad   --out out/ipad   --captions raw/captions.txt
scripts/app-store-media.py check out/iphone/*.png out/ipad/*.png
```

`--style framed` (the default) puts a caption above the capture on a plain background and keeps the capture's
shape. `--style plain` only converts the size and flattens transparency, and warns if it had to stretch.
A capture from an iPhone with a smaller screen (1179 x 2556, for example) is scaled to fit and is fine.

### Shot list (iPhone, then the same for iPad)
Use a **demo account with demo data**. No real names, callsigns, positions, photos or operations. Capture in light or
dark, but be consistent. Show the status bar at 9:41 with full signal if you can.

| # | Capture | Caption (keep under 45 characters) |
|---|---|---|
| 1 | The map zoomed to NZ with team markers and road events | See your team on one live map |
| 2 | Chat open in a channel with a few demo messages | Chat with your team and share photos |
| 3 | A marker's detail with a geotagged photo attached | Add geotagged photos to the map |
| 4 | A route and a drawn area being edited | Draw routes, markers and areas |
| 5 | A shared mission (Data Sync) with its content | Work on shared missions together |
| 6 | The layer picker with NZ road events and weather radar on | NZ road events, weather radar and more |
| 7 | The lower-left location panel, with the sharing control visible | Share your location only when you choose |
| 8 | The server selection or sign-in screen | Sign in with your organisation's account |

Shots 1, 2 and 7 matter most: the App Store shows the first three. Don't claim anything in a caption that the
description doesn't also claim.

```
01-map.png: See your team on one live map
02-chat.png: Chat with your team and share photos
03-photo.png: Add geotagged photos to the map
04-draw.png: Draw routes, markers and areas
05-mission.png: Work on shared missions together
06-layers.png: NZ road events, weather radar and more
07-sharing.png: Share your location only when you choose
08-signin.png: Sign in with your organisation's account
```

### How to capture
There is no Mac in this setup, so the realistic options are:
1. **A real iPhone and iPad** signed in to the demo account. Take screenshots with the side and volume-up buttons, then
   copy them off (AirDrop, or the Photos app). Use an iPhone 16/17 Pro Max (6.9") if you can, so no scaling is needed.
2. **The Xcode simulator** on any Mac or on a macOS CI runner, if someone has one. `xcrun simctl io booted screenshot`
   and `xcrun simctl io booted recordVideo` capture at device resolution. The simulator has no GPS fix of its own, use
   *Features, Location* to set a point in NZ.
3. **Not recommended:** a browser screenshot of the web app. It shows the same interface but not the iOS app
   (no native status bar, safe areas or native controls), and the sharing control is native-only.

## App previews

Optional, up to 3 per device size. They play before the screenshots.

| | iPhone | iPad |
|---|---|---|
| Accepted size (portrait) | **886 x 1920** | **1200 x 1600** |
| Length | 15 to 30 seconds | 15 to 30 seconds |
| Format | H.264 `.mp4`, `.mov` or `.m4v` (ProRes 422 HQ `.mov` also works) | same |
| Frame rate | up to 30 fps | up to 30 fps |
| Audio | stereo AAC 256 kbps, 44.1 or 48 kHz (the tool adds silence if the recording has none) | same |
| Size | up to 500 MB | up to 500 MB |

Apple needs a preview to show the app in use, recorded from the real app. Short captions or a title card are fine,
promises and off-app footage are not. Record with the iPhone's own screen recording (Control Centre), or the
simulator, then:

```bash
scripts/app-store-media.py preview --device iphone --in raw/recording.mov --out out/preview-iphone.mp4
scripts/app-store-media.py preview --device ipad   --in raw/recording-ipad.mov --out out/preview-ipad.mp4
scripts/app-store-media.py check out/preview-iphone.mp4
```

It scales and pads to the accepted size, converts to 30 fps H.264 and stereo AAC, and checks the result.
A recording shorter than 15 s is refused. A longer one needs `--trim` or an edit.

### Storyboard (about 28 seconds, no audio needed)
Keep one hand movement per beat and pause on each result for a second.

| Time | On screen | Shows |
|---|---|---|
| 0 to 4 s | The map settles, team markers and road events visible | One live map |
| 4 to 9 s | Tap a team marker, then open chat and send a short message | Team and chat |
| 9 to 14 s | Take a photo and attach it to a marker | Geotagged photos |
| 14 to 20 s | Draw a short route and an area | Drawing |
| 20 to 25 s | Open the layer picker and turn on NZ road events and weather radar | NZ layers |
| 25 to 30 s | Open the location panel and show the sharing control | You choose when you share |

The poster frame defaults to second 5. Pick a frame with the map and markers, in App Store Connect.

## Order of work in App Store Connect

1. Settle the decisions at the top, then build and upload a new TestFlight build if any of them change the app
   (updater off, permission texts, entitlements).
2. App Information: subtitle, categories, content rights.
3. Pricing and Availability: free, countries, distribution.
4. App Privacy: the table above, and the privacy policy URL.
5. Version page: promotional text, description, keywords, support and marketing URL, copyright, screenshots and previews.
6. Age rating questionnaire.
7. App Review Information: contact, demo account, notes.
8. Select the build, answer export compliance if asked, **Add for Review**.

Apple's first review usually takes a day or two. The usual rejection reasons for this kind of app are a demo account
that doesn't work, a missing privacy policy and screenshots that don't show the app.

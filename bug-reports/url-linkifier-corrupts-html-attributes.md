# Bug: URL linkifier corrupts HTML attributes in remarks/description content

**File:** `api/web/src/components/CloudTAK/util/CopyField.vue`

**Component:** `markdown` computed property

## Description

A URL linkifier regex runs on the entire remarks/description content before rendering, including content inside HTML tag attributes. The regex:

```typescript
.replace(/(http(s)?:\/\/[a-z-]+[:.].*?(?=[\s"]))/g, '[$1]($1)')
```

is intended to make bare URLs in plain-text remarks clickable by wrapping them in Markdown link syntax `[url](url)`. However it also matches URLs inside HTML attributes — specifically the `src` attribute of `<img>` tags.

## Steps to Reproduce

1. Create a KML/KMZ file with a `<description>` CDATA block containing an `<img>` tag with an `https://` src URL, e.g.:
   ```html
   <description><![CDATA[
   <img src="https://images.geonet.org.nz/volcano/cameras/latest/m-tekaha.jpg" width="320">
   ]]></description>
   ```
2. Import the KML/KMZ into CloudTAK.
3. Click the feature and open the remarks/description panel.

## Expected Behaviour

The image renders inline in the description panel, as it does in ATAK and Google Earth.

## Actual Behaviour

The `src` attribute is replaced with Markdown link syntax, producing invalid HTML:

```html
<img src="[https://images.geonet.org.nz/volcano/cameras/latest/m-tekaha.jpg](https://images.geonet.org.nz/volcano/cameras/latest/m-tekaha.jpg)" width="320">
```

The image does not render — the broken markup is displayed as raw text instead.

## Root Cause

The linkifier regex is applied to the raw string before HTML rendering. It has no awareness of HTML structure and matches any `http(s)://` URL it finds, including those already inside attribute values. The regex terminator `(?=[\s"])` stops at a quote, but it has already consumed the URL that was the attribute value — leaving the `src="..."` wrapper around Markdown syntax rather than a plain URL.

## Recommended Fix

Add a negative lookbehind to exclude URLs already inside an HTML attribute:

```typescript
.replace(/(?<![="'])(https?:\/\/[a-z-]+[:.].*?)(?=[\s"]|$)/g, '[$1]($1)')
```

The `(?<![="'])` lookbehind skips any URL immediately preceded by `=`, `"`, or `'` — i.e. already inside an attribute value — while still linkifying bare URLs in plain text.

### Long-term Fix

A more robust solution would process the content as HTML first and only apply the linkifier to text nodes, not attribute values. The current approach of running a regex over the entire raw string is inherently fragile in the presence of mixed HTML/text content.

## Impact

- Any KML/KMZ feature whose `<description>` CDATA embeds images using `<img src="https://...">` will have broken image rendering in CloudTAK.
- This is a standard and widely used KML pattern that works correctly in ATAK and Google Earth.
- The regression was introduced when HTML rendering was enabled for the remarks panel (to render HTML content rather than displaying raw source code). The linkifier runs before the HTML renderer and corrupts any HTML that contains URLs in attributes.

## Environment

- Confirmed affected: KML/KMZ `<description>` CDATA content with embedded `<img>` tags using `https://` src URLs.

# Market card images: two-copy policy

Owner decision, 12 November 2026: retain only one main static WebP (maximum
1200px on either side and 204800 bytes) and one WebP icon (maximum 64px and
16384 bytes). Preserve aspect ratio, never crop or upscale small images.
GIF input is explicitly permitted; createImageBitmap selects its default/first
frame and canvas encodes a still WebP before uploading. Raw uploads are never
persisted. This applies to market photos, not company/document attachments.

Local main WebP bytes live in market_image_uploads. Its variant row retains
only the icon; preview_bytes/width/height are NULL. For legacy external URLs,
preview_bytes is a compatibility column containing the single bounded main
WebP. There is no third copy. The original and preview HTTP variant names
remain compatibility aliases for main, not independent stored files.

The owner backfill processes all local assets (including pending/history) and
referenced external URLs. It preserves compliant existing WebP bytes, compacts
oversized files, removes redundant local previews after the main is safely
available, and marks storage_version=2. It does not change card IDs, revisions,
moderation or ordering. Use image-variants/status to verify policyVersion=2,
pending=0 and previewBytes=0 for local assets; failed sources require review.

All existing visibility checks, private-prescription moderation, source-card
binding, deletion cascade and external-source SSRF restrictions remain.

## Owner image batches and lost-reply recovery — 25 November 2026

`POST /medicine-market/owner/images-batch` accepts up to ten medicine images,
with a total encoded JSON limit of 768 KiB in the main parser, signed gateway
and isolated market parser. Source downloads and transforms run sequentially
inside one transaction; uploading does not set a card's image field.
The gateway gives this exact POST operation a 120-second response budget only
for the current owner. Other market requests retain their normal four-second
budget, and admission, source validation and authority checks are unchanged.

A timeout or disconnected response is an unknown delivery outcome, not proof
of rollback. Do not repeat the upload before checking
`GET /medicine-market/audit?page=1&pageSize=100` and subsequent pages as needed.
Active owners receive an `imageUpload` receipt on matching
`medicine-market.image_upload` events: `imageId`, `cardId`, `url`, `createdAt`,
`bytes`, `width` and `height`. Each receipt is read from the existing image row
and matched to the audit event's image ID, card and uploader. Other audit
readers receive the original audit fields only; raw audit JSON is never
included. Reuse the recovered URL for the normal expected-value image
contribution, then read the card back. Image batches still have no replay key.

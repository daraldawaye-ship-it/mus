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

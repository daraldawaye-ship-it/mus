"""Emit an image-name-only batch from a ZIP, without extracting any image."""
import argparse
import collections
import csv
import io
import json
import pathlib
import re
import zipfile

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("archive", type=pathlib.Path)
p.add_argument("--drive-id", required=True)
p.add_argument("--modified-at")
a = p.parse_args()
with zipfile.ZipFile(a.archive) as z:
    filenames = [i.filename for i in z.infolist() if not i.is_dir() and
                 re.search(r"\.(webp|jpe?g|png|avif|gif|bmp|tiff?|svg|heic|heif|jfif|ico)$", i.filename, re.I)]
    if not 1 <= len(filenames) <= 1000 or len(filenames) != len(set(filenames)):
        p.error("Expected 1–1000 unique image paths")
    names = {}
    if "فهرس الصور.csv" in z.namelist():
        index = z.getinfo("فهرس الصور.csv")
        if index.file_size > 4_000_000:
            p.error("Image index is too large")
        rows = list(csv.DictReader(io.StringIO(z.read(index).decode("utf-8-sig"))))
        counts = collections.Counter(r.get("الملف") for r in rows)
        names = {r["الملف"]: r.get("الصنف") or "" for r in rows if r.get("الملف") and counts[r["الملف"]] == 1}
    entries = []
    for name in filenames:
        entry = {"filename": name}
        label = names.get(name, "")
        if re.search("[ء-ي]", label):
            entry["sourceArabicName"] = label
        entries.append(entry)
    result = {"archiveName": a.archive.name, "archiveDriveId": a.drive_id, "entries": entries}
    if a.modified_at:
        result["modifiedAt"] = a.modified_at
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))

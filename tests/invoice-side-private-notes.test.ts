import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePrivateNotesListQuery } from "../apps/api/src/routes-quick-messages.ts";
const read=(path:string)=>readFileSync(path,"utf8");

test("personal notes are the first and default sidebar option",()=>{
  const side=read("apps/web/src/InvoiceSideOverview.tsx");
  assert.match(side,/value: "privateNotes", label: "ملاحظاتي الخاصة"/);
  assert.match(side,/useState<View>\("privateNotes"\)/);
  assert.ok(side.indexOf('{ value: "privateNotes"')<side.indexOf('{ value: "pouch"'));
  assert.match(side,/<InvoiceSidePrivateNotes \/>/);
  assert.match(side,/view === "pouch" \|\| view === "electronic" \|\| view === "closings"/);
});
test("notes and archive actions are account-private with no destructive deletion",()=>{
  const route=read("apps/api/src/routes-quick-messages.ts");
  const migration=read("apps/api/migrations/20261103_private_notes_archive.sql");
  const panel=read("apps/web/src/InvoiceSidePrivateNotes.tsx");
  assert.match(migration,/ADD COLUMN IF NOT EXISTS archived_at/);
  assert.doesNotMatch(migration,/DELETE FROM user_private_notes/);
  assert.match(route,/router.get\("\/private-notes"/);
  assert.match(route,/user_id=\$1 AND \(archived_at IS NOT NULL\)=\$2/);
  assert.match(route,/router.patch\("\/private-notes\/:id\/archive"/);
  assert.match(route,/router.patch\("\/private-notes\/:id\/restore"/);
  assert.match(route,/WHERE user_id=\$1 AND id=\$2 RETURNING id/);
  assert.match(route,/SET archived_at=COALESCE\(archived_at,clock_timestamp\(\)\)/);
  assert.match(panel,/\["private-notes",user\?\.id,archived,page\]/);
  assert.doesNotMatch(panel,/<strong>\{note.title\}<\/strong>/);
  assert.match(panel,/invoice-side-private-note-text/);
  assert.match(panel,/note.body/);
  assert.match(panel,/onClick=\{\(\)=>setCreating\(true\)\}/);
  assert.match(panel,/kind="private_note"/);
});
test("personal notes reuse avatar composer and do not leak content to audit",()=>{
  const compose=read("apps/web/src/UserMenuQuickCompose.tsx");
  const route=read("apps/api/src/routes-quick-messages.ts");
  assert.match(compose,/invalidateQueries\(\{queryKey:\["private-notes"\]\}\)/);
  assert.match(route,/quick.privateNoteArchive/);
  assert.match(route,/quick.privateNoteRestore/);
  assert.match(route,/\{ownerId:user.id,archived:true\}/);
  assert.match(route,/\{ownerId:user.id,archived:false\}/);
});

test("personal notes pagination accepts valid decimal pages and rejects invalid queries", () => {
  assert.deepEqual(parsePrivateNotesListQuery({archived:"0",page:"1",pageSize:"20"}),
    {page:1,pageSize:20,archivedOnly:false});
  assert.deepEqual(parsePrivateNotesListQuery({page:"2",pageSize:"5",archived:"1"}),
    {page:2,pageSize:5,archivedOnly:true});
  assert.deepEqual(parsePrivateNotesListQuery({}),
    {page:1,pageSize:20,archivedOnly:false});
  for(const invalid of [{page:"0"},{page:"x"},{page:"1x"},{pageSize:"51"},{archived:"x"}])
    assert.throws(()=>parsePrivateNotesListQuery(invalid));
});
test("personal note is single-field in the composer and text-only in the sidebar", () => {
  const panel=read("apps/web/src/InvoiceSidePrivateNotes.tsx");
  const compose=read("apps/web/src/UserMenuQuickCompose.tsx");
  assert.match(panel,/\{note.body\}/);
  assert.match(panel,/invoice-side-private-card-footer/);
  assert.doesNotMatch(panel,/<strong>\{note.title\}<\/strong>/);
  assert.doesNotMatch(compose,/<span>عنوان المذكرة<\/span>/);
  assert.doesNotMatch(compose,/const \[title,setTitle\]/);
  assert.match(compose,/title:"ملاحظة خاصة"/);
});

from pathlib import Path
import subprocess

page = Path('apps/web/src/pages/MedicineMarketPage.tsx')
upload = Path('apps/web/src/MarketImageUpload.tsx')
for path, expected in [(page, 'b90e9b8a0e0cab4cb2bfddd4c47622d0507d07b7'), (upload, 'b923ffd6ac986b26bed9641ba52bcafaba2d52ac')]:
    if subprocess.check_output(['git', 'hash-object', str(path)], text=True).strip() != expected:
        raise SystemExit('Concurrent edit; refusing to overwrite ' + str(path))
source = page.read_text()
start = source.index('function MarketInlineField(')
end = source.index('/** Approval-only photo verification;', start)
block = source[start:end]

def swap(old, new, count=1):
    global block
    if block.count(old) != count:
        raise SystemExit('Unexpected field anchor: ' + old[:100])
    block = block.replace(old, new)

swap('function MarketInlineField(', 'export function MarketInlineField(')
swap('  // Relations require explicit confirmation so accidental selections can be cancelled.\n  const immediate=!complex&&(field.type==="boolean"||field.type==="reference"||!!field.options?.length);',
     '  // Discrete choices commit immediately; text/compound values commit on field exit.\n  const immediate=!complex&&(["boolean","reference","relation","date"].includes(field.type)||!!field.options?.length);\n  const saveOnExit=!immediate&&field.key!=="image";')
swap('      await api(`${ROOT}/cards/${card.id}/contributions`,{',
     '      const result=await api<{contribution?:{status:string;published:boolean}}>(`${ROOT}/cards/${card.id}/contributions`,{')
swap('      update(null);retry.current=null;setMessage("تم حفظ المساهمة.");',
     '      update(null);retry.current=null;\n      setMessage(result.contribution?.status==="pending"&&!result.contribution.published\n        ?"تم إرسال المساهمة للمصادقة.":"تم الحفظ تلقائيًا.");')
swap('      if(requestGuard.isCurrent())setError(errorMessage(cause));',
     '      if(requestGuard.isCurrent()){\n        setError("لم يُحفظ التعديل. "+errorMessage(cause));\n        if(cause&&typeof cause==="object"&&"status" in cause&&cause.status===409)\n          void client.invalidateQueries({queryKey:["medicine-market",user?.id,"card",card.id]});\n      }')
swap('    if(immediate)void save(next);',
     '    if(immediate||(field.key==="image"&&!uploading.current))void save(next);')
swap('if(!textEditor||event.currentTarget.contains(event.relatedTarget as Node|null))return;',
     'if(!saveOnExit||event.currentTarget.contains(event.relatedTarget as Node|null))return;')
swap('            if(textEditor)void save();', '            if(field.key!=="image")void save();')
swap('  const textEditor=!complex&&!immediate;\n', '')
swap('          onImageBusyChange={value=>{uploading.current=value;if(guard.isCurrent())setImageBusy(value);}}/>',
'''          onImageBusyChange={value=>{
            uploading.current=value;
            if(!guard.isCurrent())return;
            setImageBusy(value);
            // The new URL arrives before busy clears. Failed uploads retain their error.
            const next=current.current;
            if(!value&&next&&JSON.stringify(next.value)!==JSON.stringify(next.initialValue))void save(next);
          }}/>''')
swap('''          <Button type="submit" size="compact" disabled={!canEdit||disabled||busy||imageBusy}>
            {busy?"جارٍ الحفظ…":imageBusy?"جارٍ رفع الصورة…":"حفظ المساهمة"}
          </Button>''',
'''          <small className="medicine-market-muted" role="status">
            {busy?"جارٍ الحفظ…":imageBusy?"جارٍ رفع الصورة…":
              field.key==="image"?"تُحفظ الصورة تلقائيًا بعد الرفع.":
              immediate?"يُحفظ الاختيار تلقائيًا.":"يُحفظ التعديل تلقائيًا عند مغادرة الحقل أو الضغط على Enter."}
          </small>
          {error&&<Button type="button" size="compact" disabled={!canEdit||disabled||busy||imageBusy}
            onClick={()=>void save()}>إعادة المحاولة</Button>}''')
source = source[:start] + block + source[end:]
start = source.index('function PrescriptionLinesInline(')
end = source.index('function ReferencePicker(', start)
block = source[start:end]
swap('function PrescriptionLinesInline(', 'export function PrescriptionLinesInline(')
swap('  const retry=useRef<{payload:string;key:string}|null>(null);',
     '  const retry=useRef<{payload:string;key:string}|null>(null);\n  const currentDraft=useRef<PrescriptionLine[]|null>(null);\n  const expected=useRef<unknown>(null),pending=useRef(false);')
swap('    if(!available)return;',
     '    if(!available||pending.current)return;\n    expected.current=structuredClone(card.data.prescriptionLines??null);')
swap('    setDraft(copy);',
     '    currentDraft.current=copy;setDraft(copy);\n    if(kind==="add")void save(undefined,copy);')
swap('  const cancel=()=>{if(busy)return;setDraft(null);setEditingIndex(null);setAction(null);setError("");};',
     '  const cancel=()=>{if(pending.current)return;currentDraft.current=null;setDraft(null);setEditingIndex(null);setAction(null);setError("");};')
swap('''  const updateRow=(index:number,row:PrescriptionLine)=>{
    setDraft(old=>old?.map((entry,i)=>i===index?row:entry)??null);
  };''',
'''  const updateRow=(index:number,row:PrescriptionLine,keepEditing=true)=>{
    if(pending.current||!currentDraft.current)return;
    const next=currentDraft.current.map((entry,i)=>i===index?row:entry);
    currentDraft.current=next;setDraft(next);
    void save(undefined,next,keepEditing);
  };''')
swap('''  async function save(event:FormEvent){
    event.preventDefault();
    if(!available||!draft||!guard.isCurrent())return;
    const initial=card.data.prescriptionLines??null;
    if(JSON.stringify(draft)===JSON.stringify(initial)){cancel();return;}
    const payload={fieldKey:"prescriptionLines",value:draft,expectedValue:initial};''',
'''  async function save(event?:FormEvent,next=currentDraft.current,keepEditing=false){
    event?.preventDefault();
    if(!available||pending.current||!next||!guard.isCurrent())return;
    const initial=expected.current;
    if(JSON.stringify(next)===JSON.stringify(initial)){if(!keepEditing)cancel();return;}
    const payload={fieldKey:"prescriptionLines",value:next,expectedValue:initial};''')
swap('    setBusy(true);setError("");setSuccess("");',
     '    pending.current=true;setBusy(true);setError("");setSuccess("");')
swap('      await api(`${ROOT}/cards/${card.id}/contributions`,{',
     '      const result=await api<{card:MarketCard;contribution?:{published:boolean}}>(`${ROOT}/cards/${card.id}/contributions`,{')
swap('''      setDraft(null);setEditingIndex(null);setAction(null);retry.current=null;
      setSuccess("تم حفظ تعديل الأسطر.");''',
'''      expected.current=structuredClone(result.card.data.prescriptionLines??null);
      if(!keepEditing){currentDraft.current=null;setDraft(null);setEditingIndex(null);setAction(null);}
      retry.current=null;
      setSuccess(result.contribution?.published===false?"تم إرسال تعديل الأسطر للمصادقة.":"تم حفظ تعديل الأسطر تلقائيًا.");''')
swap('    }catch(cause){if(guard.isCurrent())setError(errorMessage(cause));}',
     '    }catch(cause){if(guard.isCurrent())setError("لم يُحفظ التعديل. "+errorMessage(cause));}')
swap('    finally{if(guard.isCurrent())setBusy(false);}',
     '    finally{pending.current=false;if(guard.isCurrent())setBusy(false);}')
swap('onChange={id=>updateRow(index,{...draft[index],id})}',
     'onChange={id=>updateRow(index,{...draft[index],id},false)}')
swap('''                <Button type="submit" size="compact" disabled={busy}>
                  {busy?"جارٍ الحفظ…":"حفظ السطر"}
                </Button>''',
'''                <small role="status">{busy?"جارٍ الحفظ…":success||"يُحفظ الاختيار تلقائيًا."}</small>
                {error&&<Button type="button" size="compact" disabled={busy}
                  onClick={()=>void save()}>إعادة المحاولة</Button>}''')
source = source[:start] + block + source[end:]
page.write_text(source)
text = upload.read_text()
old = 'رُفعت الصورة ({Math.round(size/1024)} كيلوبايت). اضغط «حفظ المساهمة» لاعتمادها.'
if text.count(old) != 1:
    raise SystemExit('Upload message changed concurrently')
upload.write_text(text.replace(old, 'حجم الصورة المرفوعة: {Math.round(size/1024)} كيلوبايت. تُرسل المساهمة تلقائيًا.'))
Path('docs/MARKET_CONTRIBUTION_AUTOSAVE.md').write_text('''# Market contribution autosave

Owner decision, 12 November 2026: all existing market card contribution fields
save without a Save Contribution button, not only images.

Text, numeric, multiline and compound fields submit on leaving the complete
field editor or pressing Enter (Shift+Enter keeps multiline input). Relation,
reference, option, checkbox and date choices submit immediately. Image changes
submit only after successful upload; removal submits immediately. Failed image
uploads do not create a contribution or dismiss the upload error.

Prescription choices and add-row controls submit automatically. Switching a
line's type keeps its editor open and rebases the expected value from the actual
server response, including when moderation leaves the public value unchanged.
Removing the last prescription line retains its explicit deletion confirmation.
New-card creation and moderation decisions remain explicit actions.

The existing contribution API, authority, expectedValue concurrency checks,
idempotency and review rules are unchanged. Errors keep the draft and provide
Retry, reusing the same idempotency key for the unchanged request. No production
cards, images, prices or prescriptions are created for regression testing.
Browser regression: tests/browser-market-autosave.ts (intercepted local API).
''')
print('Applied guarded automatic saving for all market contribution field editors.')

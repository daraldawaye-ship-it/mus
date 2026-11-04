"""Prepare owner supplied originals and lossless JSON/Excel rows for private staging.
Usage: python prepare-market-staging.py SOURCE_DIR OUTPUT_PREFIX
SOURCE_DIR/manifest.json describes local,name,driveId,modifiedAt,byteSize.
Original file bytes are always preserved. No repair is written to originals.
"""
import base64, datetime, gzip, hashlib, io, json, pathlib, sys
import openpyxl, xlrd

root=pathlib.Path(sys.argv[1]); out=pathlib.Path(sys.argv[2]); manifest=json.loads((root/'manifest.json').read_text())
def encode(v):
    return json.dumps(v,ensure_ascii=False,separators=(',',':'),default=lambda x:x.isoformat() if isinstance(x,(datetime.datetime,datetime.date,datetime.time)) else str(x),allow_nan=False)
def json_rows(raw):
    s=raw.decode('utf-8-sig'); decoder=json.JSONDecoder(); marker='"messages":'; a=s.index(marker)+len(marker)
    while s[a].isspace():a+=1
    assert s[a]=='['; a+=1
    metadata=json.loads(s[:a]+']}'); metadata.pop('messages')
    rows=[]; issue=None
    while True:
        while a<len(s) and s[a].isspace():a+=1
        if a==len(s): issue='missing closing messages array and root object at EOF';break
        if s[a]==']':
            json.loads(s);break
        begin=a
        try: _,a=decoder.raw_decode(s,a)
        except json.JSONDecodeError as e: issue=f'incomplete record at character {begin}: {e.msg}';break
        rows.append(('messages',len(rows)+1,s[begin:a]))
        while a<len(s) and s[a].isspace():a+=1
        if a<len(s) and s[a]==',':a+=1;continue
        if a<len(s) and s[a]==']':continue
        if a==len(s):issue='missing closing messages array and root object at EOF';break
        raise ValueError('unexpected JSON delimiter')
    return rows,{'format':'telegram-json','root':metadata,'parseIssue':issue,'completeRecords':len(rows)}
def excel_rows(raw):
    rows=[];sheets=[]
    if raw.startswith(b'PK'):
        w=openpyxl.load_workbook(io.BytesIO(raw),read_only=True,data_only=False)
        cached=openpyxl.load_workbook(io.BytesIO(raw),read_only=True,data_only=True)
        for s in w:
            n=0
            for ri,(rr,cc) in enumerate(zip(s.iter_rows(),cached[s.title].iter_rows()),1):
                if not any(c.value is not None for c in rr):continue
                cells=[{'column':i,'value':c.value,'type':c.data_type,'format':c.number_format,'cached':cv.value if c.data_type=='f' else None} for i,(c,cv) in enumerate(zip(rr,cc),1)]
                rows.append((s.title,ri,encode({'cells':cells})));n+=1
            sheets.append({'name':s.title,'rows':s.max_row,'columns':s.max_column,'nonemptyRows':n})
        w.close();cached.close();fmt='xlsx'
    else:
        w=xlrd.open_workbook(file_contents=raw,formatting_info=True)
        for s in w.sheets():
            n=0
            for ri in range(s.nrows):
                if not any(c.ctype not in (0,6) for c in s.row(ri)):continue
                cells=[]
                for ci,c in enumerate(s.row(ri),1):
                    xf=w.xf_list[s.cell_xf_index(ri,ci-1)]; fmt=w.format_map.get(xf.format_key)
                    cells.append({'column':ci,'value':c.value,'type':c.ctype,'format':fmt.format_str if fmt else None})
                rows.append((s.name,ri+1,encode({'cells':cells})));n+=1
            sheets.append({'name':s.name,'rows':s.nrows,'columns':s.ncols,'nonemptyRows':n})
        fmt='xls'
    return rows,{'format':fmt,'sheets':sheets,'note':'Original workbook retained byte-for-byte; row cells preserve source values/types/formats. No prices or formulas recalculated.'}
summary=[]; h=hashlib.sha256(); expanded=0
with gzip.open(str(out)+'.ndjson.gz','wb') as target:
    def emit(v):
        global expanded
        b=(encode(v)+'\n').encode();h.update(b);expanded+=len(b);target.write(b)
    for m in manifest:
        raw=(root/m['local']).read_bytes();assert len(raw)==m['byteSize']
        rows,meta=json_rows(raw) if m['local'].endswith('.json') else excel_rows(raw)
        sh=hashlib.sha256(raw).hexdigest()
        emit({'type':'source','key':m['driveId'],'filename':m['name'],'driveId':m['driveId'],'modifiedAt':m['modifiedAt'],'sha256':sh,'byteSize':len(raw),'rowCount':len(rows),'metadata':meta})
        for i,a in enumerate(range(0,len(raw),196608)):emit({'type':'chunk','index':i,'data':base64.b64encode(raw[a:a+196608]).decode()})
        for section,position,payload in rows:emit({'type':'row','section':section,'position':position,'payload':payload})
        emit({'type':'end'})
        summary.append({'name':m['name'],'driveId':m['driveId'],'sha256':sh,'bytes':len(raw),'rows':len(rows),'metadata':meta})
        print(m['name'],len(rows),meta.get('parseIssue',''),flush=True)
result={'sha256':h.hexdigest(),'expandedBytes':expanded,'sources':summary}
pathlib.Path(str(out)+'.manifest.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print('TOTAL',sum(x['rows'] for x in summary),'EXPANDED',expanded,'SHA',h.hexdigest())

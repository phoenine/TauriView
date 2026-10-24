import pathlib,urllib.request,time
root=pathlib.Path(__file__).resolve().parents[1]/'.dictionary-sources'
root.mkdir(exist_ok=True)
urls={
'ecdict.csv':'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv',
'ecdict.LICENSE':'https://raw.githubusercontent.com/skywind3000/ECDICT/master/LICENSE',
'mapull-word.json':'https://raw.githubusercontent.com/mapull/chinese-dictionary/main/word/word.json',
'mapull-idiom.json':'https://raw.githubusercontent.com/mapull/chinese-dictionary/main/idiom/idiom.json',
'mapull-char.json':'https://raw.githubusercontent.com/mapull/chinese-dictionary/main/character/common/char_common_detail.json',
'mapull.LICENSE':'https://raw.githubusercontent.com/mapull/chinese-dictionary/main/LICENSE',
'mapull.README':'https://raw.githubusercontent.com/mapull/chinese-dictionary/main/README.md',
'TSCharacters.txt':'https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSCharacters.txt',
'TSPhrases.txt':'https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSPhrases.txt',
'OpenCC.LICENSE':'https://raw.githubusercontent.com/BYVoid/OpenCC/master/LICENSE',
}
for name,url in urls.items():
 target=root/name
 if target.exists():continue
 for attempt in range(4):
  try:
   print('Downloading',name,flush=True)
   with urllib.request.urlopen(url,timeout=90) as response:data=response.read()
   temp=target.with_suffix(target.suffix+'.tmp');temp.write_bytes(data);temp.replace(target)
   print(name,len(data),flush=True);break
  except Exception:
   if attempt==3:raise
   time.sleep(1)

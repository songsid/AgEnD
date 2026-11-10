import json

def claude(body,seq,root):
 text=json.dumps(body.get('messages',[]),ensure_ascii=False)
 return ([{'type':'text','text':'Offline mock completed.'}],'end_turn',8 if (root/'mode').read_text()=='busy' else .1)

def codex(body,seq,root):
 text=json.dumps(body.get('input',[]),ensure_ascii=False)
 return ([{'type':'message','role':'assistant','id':'msg_'+str(seq),'content':[{'type':'output_text','text':'Offline mock completed.'}]}],8 if (root/'mode').read_text()=='busy' else .1)

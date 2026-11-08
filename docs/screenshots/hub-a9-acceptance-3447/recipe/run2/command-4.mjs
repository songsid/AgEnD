const a=globalThis.a9,m=a.first;
await m.page.locator('.hub-first-trust').waitFor({timeout:8000}).catch(()=>{});await a.shot(m.page,'A9-10-desk-first-use');
return{fleet:await m.page.locator('main').last().innerText(),popup:m.popup.url(),buttons:await m.page.locator('button').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>({text:e.textContent,disabled:e.disabled}))) };

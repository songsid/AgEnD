const a=globalThis.a9;for(const k of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GROK_API_KEY','DISCORD_BOT_TOKEN','TELEGRAM_BOT_TOKEN'])delete process.env[k];
const m=a.members[0],p=m.page;const sw=p.locator('.hub-exposure input[type=checkbox]');await sw.click();await p.getByText('在 Hub 上管理存取權',{exact:false}).waitFor({timeout:15000}).catch(()=>{});
return{text:await p.locator('.hub-exposures').innerText(),link:await p.locator('.hub-exposure a').first().getAttribute('href')};

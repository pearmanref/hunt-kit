const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const b=await chromium.launch();const p=await b.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
const dir=require('path').resolve(__dirname,'..')+'/';
for(const f of fs.readdirSync(dir+'docs')){const slug=f.replace('.html','');
 await p.goto('file://'+dir+'docs/'+f);await p.emulateMedia({media:'print'});
 const title=await p.title();
 await p.pdf({path:dir+'pdf/'+slug+'.pdf',format:'Letter',margin:{top:'14mm',bottom:'14mm',left:'12mm',right:'12mm'},displayHeaderFooter:true,headerTemplate:'<span></span>',
  footerTemplate:'<div style="font-size:8px;width:100%;padding:0 12mm;display:flex;justify-content:space-between;color:#555"><span>'+title+'</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'});}
await b.close();})();

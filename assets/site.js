(function(){
"use strict";
var B=document.body.getAttribute('data-base')||'';
var IDX=window.SEARCH_INDEX||[];
var K='huntkit-';
function ls(k,v){try{if(v===undefined)return localStorage.getItem(K+k);localStorage.setItem(K+k,v);}catch(e){return null;}}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function reEsc(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

/* ---------- search ---------- */
var LOW=IDX.map(function(x){return {h:x.h.toLowerCase(),t:x.t.toLowerCase(),d:x.d.toLowerCase()};});
function terms(q){return q.toLowerCase().split(/\s+/).filter(function(t){return t.length>0;});}
function count(hay,t){var n=0,i=hay.indexOf(t);while(i>=0&&n<50){n++;i=hay.indexOf(t,i+t.length);}return n;}
function search(q){
  var ts=terms(q);if(!ts.length)return [];
  var phrase=q.trim().toLowerCase();
  var out=[];
  for(var i=0;i<IDX.length;i++){
    var L=LOW[i],score=0,ok=true;
    for(var j=0;j<ts.length;j++){
      var ch=count(L.h,ts[j]),ct=count(L.t,ts[j]);
      if(!ch&&!ct){ok=false;break;}
      score+=ch*8+Math.min(ct,10);
    }
    if(!ok)continue;
    if(ts.length>1&&(L.t.indexOf(phrase)>=0||L.h.indexOf(phrase)>=0))score+=15;
    out.push({i:i,s:score});
  }
  out.sort(function(a,b){return b.s-a.s;});
  return out.slice(0,40).map(function(r){return IDX[r.i];});
}
function snippet(t,ts){
  var lo=t.toLowerCase(),pos=-1;
  for(var j=0;j<ts.length;j++){var p=lo.indexOf(ts[j]);if(p>=0&&(pos<0||p<pos))pos=p;}
  if(pos<0)pos=0;
  var a=Math.max(0,pos-70),b=Math.min(t.length,pos+150);
  var s=(a>0?'… ':'')+t.slice(a,b)+(b<t.length?' …':'');
  var h=esc(s);
  ts.forEach(function(x){if(x.length<2)return;h=h.replace(new RegExp('('+reEsc(esc(x))+')','gi'),'<mark>$1</mark>');});
  return h;
}
function link(r){return B+'docs/'+r.s+'.html'+(r.a?'#'+r.a:'');}
function bind(input,box){
  if(!input||!box)return;
  var sel=-1,cur=[];
  function draw(){
    var q=input.value.trim();
    if(!q){box.hidden=true;box.innerHTML='';return;}
    cur=search(q);sel=cur.length?0:-1;var ts=terms(q);
    box.innerHTML=cur.length?cur.map(function(r,k){
      return '<a href="'+link(r)+'" class="'+(k===0?'sel':'')+'"><div class="rd">'+esc(r.d)+(r.p?' › '+esc(r.p):'')+'</div><div class="rh">'+esc(r.h)+'</div><div class="rs">'+snippet(r.t,ts)+'</div></a>';
    }).join(''):'<div class="none">No matches. Try fewer or shorter words.</div>';
    box.hidden=false;
  }
  function mark(){var as=box.querySelectorAll('a');for(var k=0;k<as.length;k++)as[k].classList.toggle('sel',k===sel);if(as[sel])as[sel].scrollIntoView({block:'nearest'});}
  input.addEventListener('input',draw);
  input.addEventListener('focus',function(){if(input.value.trim())draw();});
  input.addEventListener('keydown',function(e){
    if(e.key==='ArrowDown'){sel=Math.min(sel+1,cur.length-1);mark();e.preventDefault();}
    else if(e.key==='ArrowUp'){sel=Math.max(sel-1,0);mark();e.preventDefault();}
    else if(e.key==='Enter'&&sel>=0){location.href=link(cur[sel]);box.hidden=true;}
    else if(e.key==='Escape'){box.hidden=true;input.blur();}
  });
  if(!box.classList.contains('inline'))document.addEventListener('click',function(e){if(!box.contains(e.target)&&e.target!==input)box.hidden=true;});
  box.addEventListener('click',function(){setTimeout(function(){if(!box.classList.contains('inline'))box.hidden=true;},0);});
}
bind(document.getElementById('q'),document.getElementById('results'));
bind(document.getElementById('q2'),document.getElementById('results2'));
document.addEventListener('keydown',function(e){
  if(e.key==='/'&&!/INPUT|TEXTAREA|SELECT/.test((document.activeElement||{}).tagName)){
    e.preventDefault();var t=document.getElementById('q2')||document.getElementById('q');t.focus();t.select();}
});

/* ---------- copy buttons on code ---------- */
Array.prototype.forEach.call(document.querySelectorAll('.content pre'),function(pre){
  var b=document.createElement('button');b.className='cp';b.type='button';b.textContent='Copy';
  b.addEventListener('click',function(){
    var code=pre.querySelector('code')||pre;var txt=code.innerText;
    var done=function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy';},1200);};
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(done,function(){fallback(txt);done();});}else{fallback(txt);done();}
  });
  pre.appendChild(b);
});
function fallback(t){var ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(e){}ta.remove();}

/* ---------- panes + theme ---------- */
var small=function(){return window.matchMedia('(max-width:1150px)').matches;};
function tog(btn,cls,openCls,key){
  var el=document.getElementById(btn);if(!el)return;
  if(ls(key)==='0')document.body.classList.add(cls);
  el.addEventListener('click',function(){
    if(small()){document.body.classList.toggle(openCls);return;}
    document.body.classList.toggle(cls);ls(key,document.body.classList.contains(cls)?'0':'1');
  });
}
tog('tocBtn','notoc','tocopen','toc');tog('railBtn','norail','railopen','rail');
if(!document.getElementById('toc')){var tb=document.getElementById('tocBtn');if(tb)tb.style.display='none';}
document.addEventListener('click',function(e){
  if(!small())return;
  ['toc','rail'].forEach(function(id){var p=document.getElementById(id);var b=document.getElementById(id+'Btn');
    if(p&&!p.contains(e.target)&&e.target!==b)document.body.classList.remove(id+'open');});
  var t=e.target.closest&&e.target.closest('#toc a');if(t)document.body.classList.remove('tocopen');
});
var th=ls('theme');if(th)document.documentElement.setAttribute('data-theme',th);
var tbn=document.getElementById('themeBtn');
if(tbn)tbn.addEventListener('click',function(){
  var r=document.documentElement,cur=r.getAttribute('data-theme');
  var dark=cur?cur==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;
  r.setAttribute('data-theme',dark?'light':'dark');ls('theme',dark?'light':'dark');
});

/* ---------- toc scroll spy ---------- */
var toc=document.getElementById('toc');
if(toc&&'IntersectionObserver' in window){
  var links={};Array.prototype.forEach.call(toc.querySelectorAll('a'),function(a){links[a.getAttribute('href').slice(1)]=a;});
  var last=null;
  var io=new IntersectionObserver(function(es){
    es.forEach(function(en){if(en.isIntersecting&&links[en.target.id]){if(last)last.classList.remove('on');last=links[en.target.id];last.classList.add('on');
      var tr=last.getBoundingClientRect(),pr=toc.getBoundingClientRect();if(tr.top<pr.top||tr.bottom>pr.bottom)last.scrollIntoView({block:'nearest'});}});
  },{rootMargin:'-60px 0px -75% 0px'});
  Array.prototype.forEach.call(document.querySelectorAll('.content h1[id],.content h2[id],.content h3[id]'),function(h){io.observe(h);});
}
})();

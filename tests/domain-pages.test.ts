import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {PageCrawler} from '../src/domain-intel/pages.js';
import type {IntelNet} from '../src/domain-intel/net.js';
describe('authorized page evidence',()=>{
 it('keeps four slots busy without waiting for a slow earlier URL',async()=>{
  let release!:()=>void,overflow!:()=>void;
  const slow=new Promise<void>(resolve=>{release=resolve}),fastStarted=new Promise<void>(resolve=>{overflow=resolve});
  let active=0,peak=0,started=0;
  const net={http:async(url:string)=>{
   peak=Math.max(peak,++active);if(++started===5)overflow();
   if(url.endsWith('/0'))await slow;
   await Promise.resolve();active--;
   return {url,finalUrl:url,status:200,headers:{},body:'ok',truncated:false,redirects:[],remoteAddress:null,ms:1};
  }} as unknown as IntelNet;
  const crawler=new PageCrawler(net,h=>h==='audit.example',()=>{});
  for(let i=0;i<10;i++)crawler.enqueue('https://audit.example/'+i,null,'fixture');
  const run=crawler.wave(10000);
  try{await fastStarted;expect(crawler.records.some(r=>r.url.endsWith('/0'))).toBe(false);expect(peak).toBe(4);}finally{release();}
  await run;expect(crawler.records).toHaveLength(10);expect(crawler.frontier).toBe(0);
 });
 it('discovers scoped HTTP links and base-relative links and hashes exact received bytes',async()=>{
  const root='https://audit.example/',calls:string[]=[];
  const original=Buffer.concat([Buffer.from('<base href="/guide/"><a href="intro">Intro</a><a href="/%6cogout">Sign out</a>'),Buffer.from([255])]);
  const net={http:async(url:string,opts:{raw?:boolean})=>{
   calls.push(url);expect(opts.raw).toBe(true);
   const body=url===root?original.toString('utf8'):url.endsWith('/catalog.xml')?'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://audit.example/item?a=1&amp;b=2</loc></url></urlset>':'fixture';
   return {url,finalUrl:url,status:200,headers:{'content-type':url.endsWith('.xml')?'application/xml':'text/html',...(url===root?{link:'</catalog.xml>; rel="sitemap", <https://outside.example/>; rel="next", </skip>; rel="next"; anchor="/other"'}:{})},body,bytes:url===root?original:Buffer.from(body),truncated:false,redirects:[],remoteAddress:null,ms:1};
  }} as unknown as IntelNet;
  const crawler=new PageCrawler(net,h=>h==='audit.example',()=>{});crawler.enqueue(root,null,'input');await crawler.wave(10000);
  expect(calls.sort()).toEqual([root,root+'catalog.xml',root+'guide/intro',root+'item?a=1&b=2'].sort());
  expect(crawler.records.find(r=>r.url===root+'catalog.xml')).toMatchObject({parent:root,via:'HTTP link'});
  expect(crawler.records.find(r=>r.url===root)).toMatchObject({bytes:original.length,sha256:createHash('sha256').update(original).digest('hex')});
  expect(crawler.rejected[0]?.url).toBe(root+'%6cogout');
 });
 it('follows nested pages, scripts and sitemap children; preserves exact values and queue state',async()=>{
  const calls:string[]=[];let clock=0;
  const pages:Record<string,{body:string;type?:string;status?:number;location?:string;truncated?:boolean}>={
   'https://audit.example/':{body:'<a href="/nested">next</a><a href="https://outside.example/no">outside</a><a href="/logout">logout</a><script src="/app.js"></script><a href="/sitemap.xml">map</a>'},
   'https://audit.example/nested':{body:'<a href="/deeper">deep</a><a href="/">root</a>'},
   'https://audit.example/deeper':{body:'password="exact-fixture-value-012345"',truncated:true},
   'https://audit.example/app.js':{body:'const token="fixture-only-value-12345";',type:'application/javascript'},
   'https://audit.example/sitemap.xml':{body:'<sitemapindex><loc>https://sub.audit.example/child.xml</loc></sitemapindex>',type:'application/xml'},
   'https://sub.audit.example/child.xml':{body:'<urlset><loc>https://sub.audit.example/final</loc></urlset>',type:'application/xml'},
   'https://sub.audit.example/final':{body:'<title>Subdomain page</title><p>contact@audit.example</p><form method="post"><input type="password" name="pw"></form>'},
  };
  const net={http:async(url:string)=>{calls.push(url);const p=pages[url];return {url,finalUrl:url,status:p?200:404,headers:{'content-type':p?.type||'text/html'},body:p?.body||'',truncated:p?.truncated||false,redirects:[],remoteAddress:null,ms:1};}} as unknown as IntelNet;
  const run=new PageCrawler(net,h=>h==='audit.example'||h.endsWith('.audit.example'),()=>{},()=>clock++);
  run.enqueue('https://audit.example/',null,'input');
  await run.wave(3);expect(run.frontier).toBeGreaterThan(0);
  for(let i=0;i<10&&run.frontier;i++)await run.wave(10);
  expect(run.frontier).toBe(0);expect(run.records).toHaveLength(7);
  expect(calls.some(u=>u.includes('outside.example')||u.includes('/logout'))).toBe(false);
  const finding=run.records.find(r=>r.url.endsWith('/deeper'))!;
  expect(finding.secrets[0].value).toBe('exact-fixture-value-012345');expect(finding.truncated).toBe(true);expect(finding.sha256).toMatch(/^[a-f0-9]{64}$/);
  const subpage = run.records.find(r=>r.url.endsWith('/final'));
  expect(subpage?.contacts).toEqual(['contact@audit.example']);
  expect(subpage?.web?.page).toMatchObject({title:'Subdomain page',forms:[{method:'post',password:true}]});
  expect(run.report().rejected).toHaveLength(1);
 });
 it('does not follow redirects outside authorization, and never executes or validates a credential',async()=>{
  const calls:string[]=[];
  const net={http:async(url:string,opts:any)=>{calls.push(url);expect(opts.follow).toBe(false);return{url,finalUrl:url,status:302,headers:{location:'https://other.example/secret'},body:'',truncated:false,redirects:[],remoteAddress:null,ms:1};}} as unknown as IntelNet;
  const run=new PageCrawler(net,h=>h==='audit.example',()=>{});run.enqueue('https://audit.example/',null,'input');await run.wave(100);
  expect(calls).toEqual(['https://audit.example/']);expect(run.records[0].status).toBe(302);
 });
});

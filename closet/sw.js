// 오프라인에서도 열리도록 앱 파일을 캐시해요. 파일을 고치면 VERSION을 올려 주세요.
// 화면(HTML)은 항상 서버에 새 버전이 있는지 확인하고(no-cache), 인터넷이 없을 때만 캐시를 써요.
const VERSION='closet-v5',FILES=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(VERSION).then(c=>c.addAll(FILES.map(f=>new Request(f,{cache:'reload'})))));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==VERSION).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;
  const doc=r.mode==='navigate'||r.destination==='document';
  e.respondWith(fetch(doc?new Request(r.url,{cache:'no-cache'}):r).then(res=>{const c=res.clone();caches.open(VERSION).then(x=>x.put(r,c));return res}).catch(()=>caches.match(r)))});

var CACHE_NAME = 'essay-grader-v1.2';
var STATIC_ASSETS = [
  '/',
  '/index.html'
];

// 설치 시 기본 파일 캐시
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// 활성화 시 이전 캐시 삭제
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

// 네트워크 요청 처리
// API 요청은 항상 네트워크 우선, 나머지는 캐시 우선
self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  // API 요청은 캐시하지 않고 네트워크로만
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 정적 파일은 캐시 우선, 없으면 네트워크
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(response) {
        // 성공적인 응답만 캐시에 저장
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      });
    })
  );
});

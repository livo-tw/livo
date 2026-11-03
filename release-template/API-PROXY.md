# HTTPS, API caching and redirect recovery

This package prepares application-side cache safeguards. It does not install or
change an external nginx, CDN, certificate or browser configuration. Apply an
instance's reviewed proxy changes in its authorized maintenance window, then
verify both the public endpoint and the origin. A source test or release package
is not evidence that an instance has been updated.

## Response contract

- `/auth/v1/`, `/rest/v1/`, `/functions/v1/` and `/graphql/v1/` responses carry
  `Cache-Control: no-store`, including errors and upstream redirects. The proxy
  preserves upstream status, `Location`, cookies and streamed bytes. GoTrue OAuth
  redirects remain functional; do not block every API 3xx response.
- The application's canonical-host and legacy `/demo/` page redirects use
  temporary 302 responses with `Cache-Control: no-store`. API and probe requests
  do not participate in the application's canonical-page redirect.
- Application-generated HTTP and WebSocket gateway 502 errors are not stored.
- Successful storage-object downloads retain their upstream cache policy,
  validators and range handling. Static resources are outside this API policy.

These headers prevent new cache entries when the request reaches the updated
server. They cannot retroactively remove a redirect already stored in a browser
or override a CDN rule that serves a cached response before contacting the app.
The client also requests protected API data with `cache: no-store`; it does not
silently retry writes or clear login/site storage.

## Choose the actual TLS topology first

There are two distinct configurations below. Do not copy either over an existing
instance before identifying where TLS terminates. In particular, **do not put
the HTTP API 426 rule from topology A onto a topology B origin**: that would
reject the CDN's legitimate HTTPS-to-HTTP-origin API traffic.

### A. nginx origin terminates TLS; CDN uses Full (strict)

Adapt this example to the existing host, certificates, trusted proxy chain and
frontend listener. It is not an installer or a complete production hardening
configuration. Keep Kong, database, Studio and metadata ports private. In this
example nginx terminates TLS directly, so it writes `X-Forwarded-Proto: $scheme`;
never trust a client-supplied forwarded scheme. If another trusted TLS terminator
sits in front, derive the scheme only from that verified proxy chain.

Before choosing A, verify the origin's actual 443 listener, hostname/SNI and
valid certificate from the trusted edge. Only then configure Full (strict) and
the HTTP listener's page 302 / API 426 rules. Changing TLS mode without this
preflight can make a previously reachable origin unavailable.

The `/healthz` location below is **frontend liveness only**: it proxies a real
GET of the frontend root, so an unavailable frontend fails the probe. It does not
claim that the database, authentication or every API is ready. Configure deeper
readiness separately; the other reserved probe paths below return 404 instead of
redirecting or reporting a fabricated success.

```nginx
# http context
map $http_upgrade $livo_connection_upgrade {
    default upgrade;
    ''      close;
}
upstream livo_frontend {
    server 127.0.0.1:3000;
}

server {
    listen 80;
    server_name app.example.com;

    # Never send API clients into a scheme/canonical redirect chain.
    # Public API clients must use the HTTPS URL directly.
    location ~ ^/(?:auth|rest|functions|graphql|storage|realtime)/v1(?:/|$) {
        default_type application/json;
        add_header Cache-Control "no-store" always;
        return 426 '{"error":"HTTPS required"}';
    }
    location = /healthz {
        proxy_pass http://livo_frontend/;
        proxy_set_header Host app.example.com;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Accept "*/*";
        proxy_cache off;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store" always;
    }
    location ~ ^/(?:health|healthz|ready)(?:/|$) {
        add_header Cache-Control "no-store" always;
        return 404;
    }
    location / {
        add_header Cache-Control "no-store" always;
        if ($request_method !~ ^(?:GET|HEAD)$) { return 405; }
        return 302 https://app.example.com$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name app.example.com;
    ssl_certificate     /etc/ssl/certs/app.example.com.pem;
    ssl_certificate_key /etc/ssl/private/app.example.com.key;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $livo_connection_upgrade;
    proxy_redirect off;

    location = /healthz {
        proxy_pass http://livo_frontend/;
        # A local proxy_set_header list replaces the inherited list.
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Accept "*/*";
        proxy_cache off;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store" always;
    }
    location ~ ^/(?:health|healthz|ready)(?:/|$) {
        add_header Cache-Control "no-store" always;
        return 404;
    }
    location ~ ^/(?:auth|rest|functions|graphql)/v1(?:/|$) {
        proxy_pass http://livo_frontend;
        proxy_cache off;
        expires off;
        proxy_hide_header Cache-Control;
        proxy_hide_header Expires;
        add_header Cache-Control "no-store" always;
    }
    location / {
        # Storage objects and Realtime upgrades retain upstream semantics.
        proxy_pass http://livo_frontend;
    }
}
```

Do not place an unconditional server-level `return 301` or `return 308` before
these locations: nginx would redirect APIs and probes before their exceptions.
Keep the canonical hostname explicit rather than constructing a destination
from an untrusted Host header. Configure the app's `APP_BASE_URL` to that same
HTTPS origin. Preserve existing certificates, access restrictions and unrelated
services when adapting the example.

### B. a trusted edge terminates TLS; the protected origin uses HTTP

In this topology the CDN or load balancer deliberately connects to an HTTP
origin. The origin must accept direct API proxying rather than redirecting or
requiring HTTPS on that private hop. Restrict origin access to the trusted edge
at both the network/firewall and nginx layers; the edge must overwrite Host and
`X-Forwarded-Proto` from its verified public connection. Never accept arbitrary
forwarded headers from an unrestricted public listener. Validate the exact
trusted CIDRs and IPv6 coverage for the chosen edge; the example CIDR below is
documentation-only and must be replaced.

```nginx
# http context; reuse topology A's upgrade map and frontend upstream.
map $http_x_forwarded_proto $livo_public_scheme {
    default invalid;
    https   https;
}
map $livo_public_scheme $livo_scheme_error_cache {
    default "";
    invalid "no-store";
}
server {
    listen 80;
    server_name app.example.com;
    allow 192.0.2.0/24;  # EXAMPLE ONLY: replace with the actual trusted edge CIDRs.
    deny all;
    # Empty for valid requests: do not add a second cache header to storage.
    add_header Cache-Control $livo_scheme_error_cache always;
    if ($livo_public_scheme = invalid) { return 400; }

    proxy_http_version 1.1;
    proxy_set_header Host app.example.com;
    proxy_set_header X-Forwarded-Proto $livo_public_scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $livo_connection_upgrade;
    proxy_redirect off;

    location = /healthz {
        proxy_pass http://livo_frontend/;
        proxy_set_header Host app.example.com;
        proxy_set_header X-Forwarded-Proto $livo_public_scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Accept "*/*";
        proxy_cache off;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store" always;
    }
    location ~ ^/(?:health|healthz|ready)(?:/|$) {
        add_header Cache-Control "no-store" always;
        return 404;
    }
    location ~ ^/(?:auth|rest|functions|graphql)/v1(?:/|$) {
        proxy_pass http://livo_frontend;
        proxy_cache off;
        expires off;
        proxy_hide_header Cache-Control;
        proxy_hide_header Expires;
        add_header Cache-Control "no-store" always;
    }
    location / {
        # No transport redirect here: the public connection was already HTTPS.
        # Preserve storage-object cache headers and Realtime semantics.
        proxy_pass http://livo_frontend;
    }
}
```

Handle public HTTP at the edge in topology B: use a temporary no-store page
redirect, and keep APIs/probes outside that redirect rule (an explicit no-store
HTTPS-required response for a public HTTP API is one option). An edge-origin
probe must use the configured trusted scheme policy; a raw internal probe with
no forwarded scheme is intentionally rejected by this example. Do not switch
this origin to Full (strict) until a valid TLS origin actually exists. The app's
canonical hostname must match the public host; the origin must not send an
already-HTTPS public request back to that identical URL based on its HTTP hop.

nginx proxy and header behavior:
[proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html),
[response headers](https://nginx.org/en/docs/http/ngx_http_headers_module.html).

## CDN and TLS termination

For topology A, a Cloudflare HTTPS origin with a valid certificate should use **Full
(strict)**. Flexible mode sends HTTP to the origin and can loop when the origin
redirects to HTTPS; an HTTPS public URL alone does not prove an HTTPS origin
connection. See the official
[redirect-loop diagnosis](https://developers.cloudflare.com/ssl/troubleshooting/too-many-redirects/).

Review every active layer, including global HTTPS switches, Redirect Rules,
legacy page rules, Workers and origin rules. API/probe paths must not acquire
new 301/308 responses at any layer. Replace a global transport redirect that
intercepts API paths with a reviewed page-only temporary redirect rule; keep
public API callers on the canonical HTTPS URL directly. This is separate from
upstream GoTrue's legitimate OAuth redirects.

Create explicit CDN **cache bypass** rules for all versioned API prefixes
(`auth`, `rest`, `functions`, `graphql`, `storage`, `realtime`) and configured
probe paths. Do not let a Cache Everything rule, edge TTL override, URL rewrite
or custom cache key overrule the private API policy. A CDN bypass for storage
does not change an object's browser cache/ETag/Range headers. Purge only the
known affected CDN URLs if existing redirect entries are found; avoid changing
unrelated caches or customer content. See
[Cloudflare cache rules](https://developers.cloudflare.com/cache/how-to/cache-rules/).

## Verify before and after a maintenance-window application

1. Save the current reviewed configuration and validate the candidate with
   `nginx -t` before any reload. Inspect the active CDN rules and origin TLS mode;
   a repository template cannot verify these runtime values.
2. Probe the public hostname and the origin separately for the selected topology,
   without following
   redirects. Use the configured hostname/SNI when probing the origin. For an
   unauthenticated API probe, a deliberate 401/403 can be correct: require no
   transport/canonical redirect and `Cache-Control: no-store`, rather than
   requiring data access. The command below discards the body and prints only
   safe response metadata; it never sends authentication credentials.

   ```sh
   curl --silent --show-error --max-time 15 --output /dev/null --dump-header - \
     'https://app.example.com/rest/v1/tasks?select=id&limit=0' |
     awk '/^HTTP\// {print} {h=tolower($0); if (h ~ /^(cache-control|cf-cache-status|age):/) print; if (h ~ /^location:/) print "Location: present (redacted)"}'
   ```

3. Repeat for `/auth/v1/user`, a known read-only function probe and `/healthz`.
   In topology A, check HTTP port 80 APIs return the explicit 426 without Location, HTTP page
   navigation returns only a temporary no-store 302, and HTTPS APIs/probes do
   not redirect back to the identical URL. `CF-Cache-Status: HIT` or a positive
   cached Age on protected API responses requires investigating edge rules.
   In topology B, verify the trusted-edge HTTPS request reaches the HTTP origin
   and APIs pass through without 426 or a transport redirect; public HTTP handling
   belongs to the edge. Use its reviewed network access and forwarded-header
   policy for a direct-origin probe, without weakening restrictions for a test.
4. With an authorized disposable test account, verify login and read-only data
   loading. Separately exercise the configured OAuth flow: its expected provider
   redirect and cookies must survive. Verify an allowed test object's normal
   download and Range/ETag behavior. Do not copy credentials, signed URLs or
   business response bodies into reports or logs.
5. Test a fresh browser profile and a profile that previously cached the bad
   redirect. The latter must actually make API network requests and display the
   expected data. HTTP status alone does not prove that the browser received or
   parsed the body. If correlation is needed, use a unique diagnostic page query
   nonce and aggregate only API path, status, response byte count and time from
   access logs; do not log Authorization, raw query values or response bodies.

## Recover an already affected browser

The updated frontend is the primary recovery path: its protected API fetches
use `cache: no-store` to bypass an old cached redirect at the **same API URL**.
Installing and loading that frontend does not require a routine manual cache
clear, sign-out or loss of saved preferences. Server response safeguards prevent
new bad entries when requests reach the app; the external redirect/CDN rules
must also be corrected. A working incognito view is useful comparison evidence,
not proof that the original profile loaded the updated frontend.

If the **HTML entry itself** has a cached redirect and the new JavaScript cannot
load, response headers cannot retroactively remove that entry. Provide a
versioned entry URL on the verified canonical origin, for example:

```text
https://app.example.com/?livo-release=<release-id>
```

First correct and verify the external transport/canonical redirects and CDN
cache key so this distinct URL actually returns the current HTML and its new
script assets. Use the published release identifier, keep the canonical host
explicit, and preserve the release query through any necessary temporary page
redirect. Verify the updated script in the affected profile and that protected
API reads recover without clearing the cache. This entry does not purge an old
bookmark's cached response; the release handoff should link to the verified
versioned entry when that fallback is needed. Do not add cache-busting values to
every API call or replay writes as a recovery mechanism.

Only if the corrected/versioned entry still cannot load the new frontend, use
an HTTP-cache-only fallback: open DevTools, then choose the reload button's
**Empty Cache And Hard Reload** option. Chrome documents that it forces resources
to be fetched from the network:
[Inspect network activity](https://developer.chrome.com/docs/devtools/network).
Keep unsaved edits before reloading. Do not clear cookies, login storage, local
preferences or all site data. Ordinary reload and sign-out/sign-in are not
equivalent to this cache-only fallback, and the fallback is not an installation
or recurring maintenance requirement.

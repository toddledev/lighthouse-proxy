# Lighthouse proxy on Cloudflare Worker

Simple proxy in front of Lighthouse (pagespeedonline) that caches results in Redis on Upstash.
Upstash Redis is used for rate limiting.

To install: `bun i`
To run: `bun dev`
To deploy: `bun deploy`

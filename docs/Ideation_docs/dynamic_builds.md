In the part of dynamic builds, how can I make it more scallable. Also if some deployment is not receiving any requests for say 15 minutes, we can put that to sleep. As soon as some req are received, we can wake them up. This way we can serve more audience with better effeciency and less bill. Improve on this idea and merge it into existing one

Related files: [dreamer_hld_v2.html](docs/Ideation_docs/dreamer_hld_v2.html)

### Current HLD Limitation: No Scale-to-Zero

This is essentially **scale-to-zero** — the same pattern Vercel/Railway use for serverless containers. Let me think through the full design before drawing anything.

---

**The Core Problem with Naive Scale-to-Zero**

The obvious approach is: detect idle → stop container → on next request, start container → proxy request. But the cold start latency (ECS Fargate spins up in ~10-30s) means the **first request after sleep gets a terrible experience**. You need to handle this gracefully.

**The better design has 4 sub-problems:**

1. **Idle detection** — how do you know a container is idle?
2. **Sleep mechanism** — how do you stop it cleanly?
3. **Wake mechanism** — who intercepts the "wake-up request" and holds it while the container starts?
4. **Scaling up** — what if a running container gets too much traffic?

---

Let me now build the full refined diagram merging this into the existing architecture.Here's the full merged v2. Let me break down the design decisions that make scale-to-zero actually work:

---

**The hardest problem: the wake-up request**

The naive approach drops the first request. The correct approach is a **Wake-Up Proxy** that sits in front of sleeping containers. When a request arrives for a sleeping deployment:
- Browser clients get an HTML loading page with a JS poll every 3s — exactly what Railway shows you
- API clients (curl, mobile apps) get `503 + Retry-After: 30` so they know to retry

The proxy checks `containerState:{id}` in Redis — a single key that both the idle detector and the wake worker update atomically. This prevents thundering herd (100 simultaneous requests all trying to wake the same container).

**Why bare_metal cold start is only 2–5s but cloud is 15–30s**

On bare metal, `docker stop` doesn't delete the container — it just freezes it. `docker start` resumes it in seconds since the image is already on disk. On ECS Fargate, `desiredCount=0` actually terminates the task, so waking up means Fargate provisioning a fresh microVM, pulling the ECR image, and running health checks. This is the fundamental tradeoff you're accepting on cloud.

**The idle detector design**

Rather than each container running its own timer (which breaks when containers sleep), a single BullMQ repeatable job runs every 60s and scans all RUNNING deployments by checking `lastRequestAt:{id}` keys in Redis. The proxy middleware stamps this key on every forwarded request. This is O(n) per minute but extremely cheap — just Redis MGET.

**Horizontal scaling is now also in there** — when a running container goes above 70% CPU for 2 minutes, the auto-scaler adds a replica. On bare metal that means `docker run` + NGINX upstream block update. On cloud it's `desiredCount+1` and ALB handles the routing automatically.
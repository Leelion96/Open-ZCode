---
description: Bring the linked ZCode Sites site back online.
argument-hint: "[site id]"
skills: site-deploy
---

Use the `site-deploy` skill for this request:

$ARGUMENTS

Run `zcode-site online` (with `--site <id>` if the arguments name a site) and report the URL. A site that has never deployed successfully stays `pending` and has nothing to serve; deploy it first. On 3612 the live version was rejected by content review: tell the user, change the content and deploy again.

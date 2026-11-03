---
description: Show the ZCode Sites site linked to this project.
argument-hint: "[site id]"
skills: site-deploy
---

Use the `site-deploy` skill for this request:

$ARGUMENTS

Run `zcode-site status` (with `--site <id>` if the arguments name a site) and summarize the URL, the site status (`pending` means never deployed successfully; `offlineReason: review_rejected` means content review rejected the live version and took the site offline, so it needs changed content and a new deploy), the live version and the latest deployment, including the failure reason if it failed. A latest deployment still `preparing`, `uploading`, `publishing` or `verifying` is in progress, not stuck.

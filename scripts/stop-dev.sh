#!/usr/bin/env bash
# Stop our dev server (:4000), the web app (:5173) and any check instances (:4001-4003).
# Only processes LISTENING on those ports are stopped. A plain `lsof -ti:4000 | xargs kill` would also kill
# Docker Desktop, whose network process holds connections to :4000 (it delivers the simulators' webhooks).
for port in 4000 4001 4002 4003 5173; do
  lsof -ti tcp:$port -sTCP:LISTEN | xargs kill 2>/dev/null
done
true

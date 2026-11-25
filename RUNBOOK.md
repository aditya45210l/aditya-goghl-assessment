# Day-of runbook
0:00 packet released: unzip into THIS folder (keep any harness/ folder), read brief
0:02 start services: npm run up  ;  npm run up
0:05 run checker once for baseline
0:10 plan on paper: build first / cut. then:
     git init && git add -A && git commit -m "init"
     create PRIVATE repo on github.com (or gh repo create NAME --private --source=. --push)
     git remote add origin <url> && git push -u origin main
build: scripts/checkpoint.sh "msg" at least every 10 min (autocommit.sh in spare tab as safety net)
0:55 export AI log -> ai-logs/   (Claude Code: /export, or copy ~/.claude/projects/<proj>/*.jsonl)
1:30 stop features. fix checker failures, fill README + DECISIONS.md, save checker report in repo
1:45 export AI log again -> ai-logs/
1:50 final checker run, commit, push, make repo PUBLIC, copy final commit id:  git rev-parse HEAD
     submit form BEFORE 2:00 (name, email, repo url, commit id, AI tools used)
Then leave repo public + unchanged 14 days.
